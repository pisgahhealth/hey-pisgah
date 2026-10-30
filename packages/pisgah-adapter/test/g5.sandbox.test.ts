import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEnvText } from "@hey-pisgah/model";
import { loadProfile } from "../src/profile.js";
import { personCaller } from "../src/journey.sandbox.js";
import { mintAgentBearer, SandboxBlock, sandboxQuery } from "../src/sandbox.js";

// Runs only with SANDBOX=1 and G5=1 against the loopback sandbox: the money rulings at the doors, with every committed step's writer named; no model is called.
const RUN = process.env["SANDBOX"] === "1" && process.env["G5"] === "1";
const run = Date.now().toString(36);

// A named synthetic write from the private controls file, as the sandbox owner role, committed in its own transaction.
function control(sb: SandboxBlock, name: string, vars: Record<string, string>): string {
  const file = process.env["HEY_PISGAH_G5_SQL"];
  if (!file) throw new Error("set HEY_PISGAH_G5_SQL to the private controls file");
  const sql = (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)[name];
  if (!sql) throw new Error(`no control named ${name}`);
  const url = parseEnvText(readFileSync(sb.env_file, "utf8"))["SANDBOX_APP_DB_OWNER_URL"]!;
  if (!/@(localhost|127\.0\.0\.1):55433\//.test(url)) throw new Error("not the loopback sandbox");
  try {
    return execFileSync("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), url], { input: `${sql};\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    // The database URL carries the sandbox password, so only psql's own message is shown.
    throw new Error(`control ${name} failed: ${String((e as { stderr?: unknown }).stderr ?? "").slice(0, 300)}`);
  }
}

// A door path from the private controls file, so this public test names none.
function door(name: string, vars: Record<string, string> = {}): string {
  const p = (JSON.parse(readFileSync(process.env["HEY_PISGAH_G5_SQL"]!, "utf8")) as Record<string, string>)[`path:${name}`];
  if (!p) throw new Error(`no path named ${name}`);
  return p.replace(/\$([a-z_]+)/g, (_m, k: string) => vars[k] ?? "");
}

describe.skipIf(!RUN)("G5 money rulings at the doors of the sandbox EMR", () => {
  it("clears with tests pending, posts a late result once beside the cleared statement, tasks the teams, and takes a cancelled prepayment only by a person's decision", async () => {
    const profile = loadProfile();
    const sb = SandboxBlock.parse(profile.sandbox);
    const person = personCaller(profile, sb, new Map(), []);
    const out: Record<string, unknown> = { run, synthetic: true, settlement: "simulated: cash recorded by the accounts person; no money moved" };
    const steps: { step: string; by: string }[] = [];
    const fx = JSON.parse(control(sb, "fixture", { run }).split("\n").at(-1)!) as Record<string, string>;
    steps.push({ step: "stay with a consultation, an FBC and a prepaid urinalysis", by: "fixture SQL (owner role)" });
    const vars = { admission_id: fx["admission"]! };
    control(sb, "discharge", { admission: fx["admission"]! });
    steps.push({ step: "clinical discharge", by: "fixture SQL (the discharge door is E5's and needs a spoken confirm)" });

    const bill = async () => {
      const r = await person("g5_bill", vars);
      expect(r.ok, JSON.stringify(r.note)).toBe(true);
      return r.json as { bill: { outstandingNgn: string }; clearanceState: string; money: Record<string, any> };
    };
    const before = await bill();
    expect(before.bill.outstandingNgn).toBe("2000.00");
    expect(before.money["reservedPrepaymentNgn"]).toBe("1500.00");
    expect(before.money["availableNgn"]).toBe("0.00");

    const settled = await person("g5_settle", { ...vars, amount: "2000.00" });
    expect(settled.ok, settled.note).toBe(true);
    steps.push({ step: "the stay bill paid and cleared", by: "accounts person at the settle door" });
    const atClearance = await bill();
    expect(atClearance.clearanceState).toBe("cleared");
    expect(atClearance.money["settlement"]).toMatchObject({ permissionToLeave: { granted: true, withExposure: true }, finalSettlement: { done: false } });
    expect(sandboxQuery(sb, "g5_exposure", { admission: fx["admission"]! }).map((e) => e["order_id"]).sort()).toEqual([fx["fbc"], fx["urine"]].sort());
    const clearedBills = sandboxQuery(sb, "g5_bills", { admission: fx["admission"]! });
    const clearedAt = sandboxQuery(sb, "g5_stay", { admission: fx["admission"]! })[0]!["cleared_at"];

    // A cancelled prepaid test: an agent may not decide its money; the accounts person moves it to credit once.
    control(sb, "cancel", { order: fx["urine"]! });
    steps.push({ step: "urinalysis cancelled", by: "fixture SQL" });
    const acc = mintAgentBearer(sb, sb.owners.find((o) => o.login.startsWith("accounts"))!);
    const h = profile.headers;
    const agent = async (method: "GET" | "POST", path: string, body?: unknown) => {
      const r = await fetch(`${profile.base_url.replace(/\/+$/, "")}/${path}`, {
        method, ...(body ? { body: JSON.stringify(body) } : {}),
        headers: { authorization: `Bearer ${acc.bearer}`, "content-type": "application/json", [h.on_behalf_of]: acc.owner, [h.origin]: profile.origin_value,
          [h.evidence]: `transcript:g5-${run}-acc`, [h.spoken_at]: new Date().toISOString(), [h.idempotency]: `g5-${run}-${Math.random().toString(36).slice(2)}` }
      });
      return { status: r.status, json: (await r.json().catch(() => null)) as any };
    };
    const decision = { action: "resolve_cancelled_test", orderId: fx["urine"], decision: "reallocate", reason: "ZZ-TEST G5 cancelled, kept as credit" };
    const byAgent = await agent("POST", door("money", { admission_id: fx["admission"]! }), decision);
    expect(byAgent.status).toBe(403);
    const resolved = await person("g5_resolve", { ...vars, order_id: fx["urine"]!, decision: "reallocate", reason: "ZZ-TEST G5 cancelled, kept as credit" });
    expect(resolved.ok, resolved.note).toBe(true);
    const again = await person("g5_resolve", { ...vars, order_id: fx["urine"]!, decision: "refund", reason: "ZZ-TEST G5 second decision" });
    expect(again.status).toBe(409);
    steps.push({ step: "cancelled prepayment moved to credit", by: "accounts person at the bill door (agent refused 403, second decision 409)" });
    expect((await bill()).money["availableNgn"]).toBe("1500.00");

    // The FBC result is committed after clearance; the hospital posts it once at commit.
    // The result's writer is a lab person at the order's lab, chosen by the private control, and must be the one the posting names.
    const lab = /[0-9a-f-]{36}/.exec(control(sb, "result", { order: fx["fbc"]! }))?.[0];
    control(sb, "reviewed", { order: fx["fbc"]! });
    steps.push({ step: "FBC resulted after clearance, then moved on to doctor review", by: "fixture SQL in two committed transactions, as the lab door's status change" });
    const late = sandboxQuery(sb, "g5_late", { admission: fx["admission"]! });
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ order_id: fx["fbc"], charge: "3000.00", reserved: "0.00", owed: "3000.00", cleared_bill: clearedBills.at(-1)!["id"], posted_by: lab });
    const afterLate = await bill();
    expect(afterLate.bill.outstandingNgn).toBe("1500.00");
    expect(afterLate.money["lateResults"]).toEqual([expect.objectContaining({ orderId: fx["fbc"], owedNgn: "3000.00", clearedStayBillId: clearedBills.at(-1)!["id"] })]);
    expect(sandboxQuery(sb, "g5_bills", { admission: fx["admission"]! })).toEqual(clearedBills);
    expect(sandboxQuery(sb, "g5_stay", { admission: fx["admission"]! })[0]!["cleared_at"]).toBe(clearedAt);

    // The accounts team sees its task; the stay's doctors see theirs.
    const accTasks = await agent("GET", door("tasks"));
    expect(accTasks.status).toBe(200);
    const accountsTask = (accTasks.json?.rows ?? []).find((d: any) => d.id === late[0]!["accounts"]);
    expect(accountsTask, JSON.stringify(accTasks.json).slice(0, 300)).toBeTruthy();
    const doc = mintAgentBearer(sb);
    const docTasks = await fetch(`${profile.base_url.replace(/\/+$/, "")}/${door("tasks")}`, {
      headers: { authorization: `Bearer ${doc.bearer}`, [h.on_behalf_of]: doc.owner, [h.origin]: profile.origin_value, [h.evidence]: `transcript:g5-${run}-doc`, [h.spoken_at]: new Date().toISOString(), [h.idempotency]: `g5-${run}-doc` }
    }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
    const reviewTask = (docTasks.json?.rows ?? []).find((d: any) => d.id === late[0]!["review"]);
    expect(reviewTask, JSON.stringify(docTasks.json).slice(0, 300)).toBeTruthy();
    expect(reviewTask.escalateAfterAt).toBeTruthy();

    // The late charge net of the credit is collected; the accounts task then reads done from the record.
    const paid = await person("g5_settle", { ...vars, amount: "1500.00" });
    expect(paid.ok, paid.note).toBe(true);
    steps.push({ step: "late charge collected", by: "accounts person at the settle door" });
    const detail = await agent("GET", door("task", { id: String(late[0]!["accounts"]) }));
    expect(detail.json?.record?.status).toBe("verified");
    expect((await bill()).bill.outstandingNgn).toBe("0.00");
    expect(sandboxQuery(sb, "g5_late", { admission: fx["admission"]! })).toHaveLength(1);
    out["fixture"] = fx;
    out["steps"] = steps;
    out["late"] = late[0];
    out["decisions"] = sandboxQuery(sb, "g5_decisions", { admission: fx["admission"]! });
    out["controls"] = { agent_decision: byAgent.status, second_decision: again.status };
    out["touches"] = { person_actions: 3, which: ["accounts settles the stay", "accounts moves the cancelled prepayment to credit", "accounts collects the late charge"] };
    const file = process.env["HEY_PISGAH_G5_OUT"];
    if (file) writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  }, 300_000);
});
