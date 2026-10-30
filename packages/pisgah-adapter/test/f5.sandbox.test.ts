import { describe, expect, it } from "vitest";
import { loadProfile } from "../src/profile.js";
import { mintPersonBearer, sandboxQuery, SandboxBlock } from "../src/sandbox.js";
import { freshArrival } from "./sandbox-helpers.js";

// Runs only with SANDBOX=1 and F5=1 against the loopback sandbox in the private door profile; ward and nurse ids come from read-only SQL.
const RUN = process.env["SANDBOX"] === "1" && process.env["F5"] === "1";
type Row = Record<string, unknown>;

describe.skipIf(!RUN)("F5 a ward's team task stays with that ward's staff", () => {
  it("lets only a nurse posted to the ward (or on duty there) take it, and keeps tasks to two wards apart", async () => {
    const profile = loadProfile();
    const sb = SandboxBlock.parse(profile.sandbox);
    const base = profile.base_url.replace(/\/+$/, "");
    const facility = String(sandboxQuery(sb, "f5_facility_of", { user: sb.owner })[0]?.["facility"] ?? "");
    const nurses = sandboxQuery(sb, "f5_nurses", { facility }) as { id: string; username: string; ward: string | null }[];
    const wards = sandboxQuery(sb, "f5_wards", { facility }) as { id: string; name: string }[];
    // The ward with a posted nurse, a second ward, and a nurse of the same hospital posted to neither.
    const posted = nurses.find((n) => n.username === "nurse.patience" && n.ward)!;
    const ward = posted.ward!;
    const other = wards.find((w) => w.id !== ward && !nurses.some((n) => n.ward === w.id))!;
    const elsewhere = nurses.find((n) => n.username === "nurse.edidiong" && n.ward !== ward)!;
    expect([posted, other, elsewhere].every(Boolean), "the seed's posted nurse, a second ward and an unposted nurse").toBe(true);
    const { patient } = await freshArrival(profile, "F5 Ward");
    const doctor = mintPersonBearer(sb, { login: "dr.edikan" });
    const call = async (bearer: string, method: "GET" | "POST", path: string, body?: unknown) => {
      const r = await fetch(`${base}/${path}`, { method, headers: { authorization: `Bearer ${bearer}`, accept: "application/json", ...(body ? { "content-type": "application/json", [profile.headers.idempotency]: `f5-${Date.now()}-${Math.random().toString(36).slice(2)}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await r.text();
      let json: Row = {};
      try { json = text ? (JSON.parse(text) as Row) : {}; } catch { json = { text: text.slice(0, 200) }; }
      return { status: r.status, json };
    };
    const tag = Date.now().toString(36);
    const task = (wardId: string) => ({ kind: "nursing", patientId: patient, subject: { table: "patients", id: patient }, title: "Check the drip site", instruction: "Check the drip site and record what you see.", evidence: `f5:ward-scope:${tag}`, assignee: { role: "nurse", wardId } });
    const a = await call(doctor, "POST", "delegations", task(ward));
    expect(a.status).toBe(200);
    // The claim rule is only tested on a task left to the team; a nurse on duty there now would be named instead.
    expect((a.json["assignee"] as Row)["rule"], "nobody of the role is on duty at the ward now").toBe("team");
    const id = String(a.json["id"]);
    const claim = { list: false, read: 0, ack: 0 };
    // A same-role nurse of the hospital not posted to the ward and not on duty there neither sees nor takes it.
    const out = mintPersonBearer(sb, { login: elsewhere.username });
    const seen = await call(out, "GET", "delegations?as=assignee");
    claim.list = ((seen.json["rows"] as Row[] | undefined) ?? []).some((r) => r["id"] === id);
    claim.read = (await call(out, "GET", `delegations/${id}`)).status;
    claim.ack = (await call(out, "POST", `delegations/${id}/acknowledge`, { evidence: `f5:claim:${tag}` })).status;
    // Duplicate detection keys on the destination ward: the same task to another ward is its own task, and the same ward still folds.
    const b = await call(doctor, "POST", "delegations", task(other.id));
    const again = await call(doctor, "POST", "delegations", task(ward));
    process.stderr.write(`f5 rows: patient ${patient}, delegations ${id} ${String(b.json["id"])}; claim by the unposted nurse ${JSON.stringify(claim)}; second ward ${String(b.json["status"])}\n`);
    expect(claim).toEqual({ list: false, read: 404, ack: 404 });
    expect(b.status).toBe(200);
    expect(b.json["status"]).toBe("assigned");
    expect(String(b.json["id"])).not.toBe(id);
    expect(again.json).toMatchObject({ status: "already_delegated", id });
    // The nurse posted to the ward sees it and takes it.
    const inn = mintPersonBearer(sb, { login: posted.username });
    const mine = await call(inn, "GET", "delegations?as=assignee");
    expect(((mine.json["rows"] as Row[] | undefined) ?? []).some((r) => r["id"] === id)).toBe(true);
    const took = await call(inn, "POST", `delegations/${id}/acknowledge`, { evidence: `f5:claim:${tag}` });
    expect(took.status).toBe(200);
    expect(sandboxQuery(sb, "f5_delegation", { id })[0]).toMatchObject({ ward, acknowledged_by: posted.id });
  }, 600_000);
});
