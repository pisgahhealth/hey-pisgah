import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sherpaEmbedder, type Provenance, type SpeakerVerdict } from "@hey-pisgah/agent";
import { parseEnvText } from "@hey-pisgah/model";
import { loadProfile } from "../src/profile.js";
import { PisgahPort, type DoorLog } from "../src/port.js";
import { personCaller } from "../src/journey.sandbox.js";
import { mintAgentBearer, SandboxBlock, sandboxQuery } from "../src/sandbox.js";
import { speak, VOICES } from "./e3.sandbox.test.js";

// Runs only with SANDBOX=1 and E5=1 against the loopback sandbox: discharge behind the owner's spoken confirmation, then the accounts leg; no model is called.
const RUN = process.env["SANDBOX"] === "1" && process.env["E5"] === "1";
const now = () => new Date().toISOString();

// One named fixture write from the private file, as the sandbox owner role, to give a synthetic stay the diagnosis the paperwork reads.
function fixture(sb: SandboxBlock, name: string, vars: Record<string, string>): void {
  const file = process.env["HEY_PISGAH_E5_SQL"];
  if (!file) throw new Error("set HEY_PISGAH_E5_SQL to the private fixture file");
  const sql = (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)[name];
  if (!sql) throw new Error(`no fixture named ${name}`);
  const url = parseEnvText(readFileSync(sb.env_file, "utf8"))["SANDBOX_APP_DB_OWNER_URL"]!;
  if (!/@(localhost|127\.0\.0\.1):55433\//.test(url)) throw new Error("not the loopback sandbox");
  execFileSync("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), url], { input: `${sql};\n`, encoding: "utf8" });
}

describe.skipIf(!RUN)("E5 discharge by voice and the accounts leg on the sandbox EMR", () => {
  it("discharges only on the owner's matched confirmation of the paperwork read back, then accounts collate, send a verified pay link, and the person's settlement clears the bed", async () => {
    const profile = loadProfile();
    const sb = SandboxBlock.parse(profile.sandbox);
    const stay = process.env["HEY_PISGAH_E5_STAY"]!, other = process.env["HEY_PISGAH_E5_OTHER"]!, unsignedStay = process.env["HEY_PISGAH_E5_UNSIGNED"]!;
    const embed = sherpaEmbedder({ modelPath: process.env["HEY_PISGAH_SPEAKER_MODEL"] ?? "", sherpaDir: process.env["HEY_PISGAH_SHERPA_DIR"] })!;
    expect(embed).not.toBeNull();
    for (const s of [stay, other, unsignedStay]) fixture(sb, "diagnosis", { admission: s });
    const doc = mintAgentBearer(sb);
    const acc = mintAgentBearer(sb, sb.owners.find((o) => o.login.startsWith("accounts"))!);
    const log: DoorLog[] = [];
    const port = new PisgahPort(profile, { bearers: { [doc.owner]: doc.bearer, [acc.owner]: acc.bearer }, onRequest: (l) => log.push(l) });
    const lastDoor = () => JSON.stringify(log.at(-1) ? { path: log.at(-1)!.path, status: log.at(-1)!.status, reason: log.at(-1)!.reason } : null);
    const dir = join(process.env["HEY_PISGAH_E5_TMP"] ?? "/tmp", `e5-${Date.now().toString(36)}`);
    mkdirSync(dir, { recursive: true });
    const prov = (owner: string, line: string, extra: Partial<Provenance> = {}): Provenance => ({ owner, evidence: `transcript:${line}`, spoken_at: now(), ...extra });
    const matched = async (voice: string, text: string, line: string): Promise<SpeakerVerdict> => port.speaker!(doc.owner, (await embed(speak(voice, text, join(dir, `${line}.wav`))))!.vector, prov(doc.owner, line));
    const result: Record<string, unknown> = { settlement: "simulated: a cash payment recorded by the accounts person; no money moved" };
    const instruction = `e5-${Date.now().toString(36)}-home`;

    // The paperwork is read back from the record: a diagnosis, medicines from dispensing, and a digest the confirmation must name.
    const paper = await port.readPaperwork!(doc.owner, stay, prov(doc.owner, instruction));
    expect(paper.diagnosis).toBeTruthy();
    result["paperwork"] = { diagnosis_present: !!paper.diagnosis, dispensed: paper.dispensed.length, exceptions: paper.exceptions.length, tests: paper.tests };

    // Negative control: the door itself refuses an agent's discharge with no confirmation line.
    const op = profile.work["release_home"]!;
    if (!("method" in op)) throw new Error("release_home is not a write in the profile");
    const raw = async (headers: Record<string, string>, admission: string, diagnosis = paper.diagnosis ?? "x") => {
      const h = profile.headers;
      const r = await fetch(`${profile.base_url.replace(/\/+$/, "")}/${op.path}`, {
        method: "POST", body: JSON.stringify({ admissionId: admission, dischargeType: "routine", primaryDiagnosis: diagnosis }),
        headers: { authorization: `Bearer ${doc.bearer}`, "content-type": "application/json", [h.on_behalf_of]: doc.owner, [h.origin]: profile.origin_value, [h.evidence]: `transcript:${instruction}`, [h.spoken_at]: now(), [h.idempotency]: `e5-raw-${Math.random().toString(36).slice(2)}`, ...headers }
      });
      return { status: r.status, text: (await r.text()).slice(0, 200) };
    };
    const bare = await raw({}, stay);
    expect(bare.status).toBe(403);
    // The engine never sends it without one either.
    expect(await port.request("POST", op.path, prov(doc.owner, instruction), { body: {} })).toEqual({ kind: "refused", reason: "needs_confirmation" });

    // The owner's own instruction line, matched, which every discharge carries beside its confirmation.
    const said = await matched(VOICES.owner, "She can go home today.", instruction);
    expect(said.speaker).toBe("owner");
    const instr = said.speaker === "owner" ? `transcript:${instruction}~${said.token}` : "";
    const A = profile.headers.authorisation!, C = profile.headers.confirmation!, D = profile.headers.read_back_digest!;

    // An unenrolled voice saying confirm gets no token, so nothing can carry it.
    const stranger = await matched(VOICES.stranger, "Confirm.", `${instruction}-s`);
    expect(stranger.speaker).not.toBe("owner");
    // A forged token is refused by the door.
    const forged = await raw({ [A]: instr, [C]: `transcript:${instruction}-f~v1.${Date.now()}.${"A".repeat(43)}`, [D]: paper.digest }, stay);
    expect(forged.status).toBe(403);

    // The owner's own confirm, with a digest that is not the paperwork read back, is refused and nothing changes.
    const confirmLine = `${instruction}-c`;
    const owner = await matched(VOICES.owner, "Confirm.", confirmLine);
    expect(owner.speaker).toBe("owner");
    const token = owner.speaker === "owner" ? `transcript:${confirmLine}~${owner.token}` : "";
    // The instruction line itself never counts as the confirmation.
    const selfConfirm = await raw({ [A]: instr, [C]: instr, [D]: paper.digest }, stay);
    expect(selfConfirm.status).toBe(403);
    // A diagnosis that is not the record's is refused even with a good confirmation.
    const wrongDiagnosis = await raw({ [A]: instr, [C]: token, [D]: paper.digest }, stay, "ZZ-TEST something else");
    expect(wrongDiagnosis.status).toBe(409);
    const stale = await raw({ [A]: instr, [C]: token, [D]: "0".repeat(64) }, stay);
    expect(stale.status).toBe(409);
    expect(sandboxQuery(sb, "e5_stay", { admission: stay })[0]!["state"]).toBe("open");

    // The owner's confirm on the paperwork read back discharges; the audit row carries the confirmation and the provenance.
    const t0 = Date.now();
    const c = await port.commit("release_home", { admission_id: stay, primary_diagnosis: paper.diagnosis }, `e5-home-${Date.now()}`, prov(doc.owner, instruction, { voice: { authorisation: instr, confirmation: token }, read_back_digest: paper.digest }));
    expect(c.ok, lastDoor()).toBe(true);
    const proof = c.ok ? await port.prove("release_home", { admission_id: stay }, c, prov(doc.owner, instruction)) : null;
    expect(proof).not.toBeNull();
    result["discharge_ms_from_confirm_to_verified"] = Date.now() - t0;
    const audit = sandboxQuery(sb, "e5_discharge_audit", { admission: stay })[0]!;
    expect(audit).toMatchObject({ agent: doc.agent, owner: doc.owner, origin: "voice", evidence: `transcript:${instruction}` });
    expect((audit["confirmation"] as Record<string, unknown>)["evidence"]).toBe(`transcript:${confirmLine}`);
    expect((audit["confirmation"] as Record<string, unknown>)["paperworkDigest"]).toBe(paper.digest);

    // The same spoken confirmation never discharges a second patient.
    const otherPaper = await port.readPaperwork!(doc.owner, other, prov(doc.owner, instruction));
    const reused = await raw({ [A]: instr, [C]: token, [D]: otherPaper.digest }, other, otherPaper.diagnosis ?? "x");
    expect(reused.status).toBe(409);
    expect(reused.text).toMatch(/already used/);
    expect(sandboxQuery(sb, "e5_stay", { admission: other })[0]!["state"]).toBe("open");

    // Voice orders still awaiting countersign hold the encounter open, even with a fresh confirm.
    const unsignedPaper = await port.readPaperwork!(doc.owner, unsignedStay, prov(doc.owner, instruction));
    expect(unsignedPaper.unsigned).toBeGreaterThan(0);
    const line2 = `${instruction}-u`;
    const owner2 = await matched(VOICES.owner, "Confirm.", line2);
    const held = await raw({ [A]: instr, [C]: owner2.speaker === "owner" ? `transcript:${line2}~${owner2.token}` : "", [D]: unsignedPaper.digest }, unsignedStay, unsignedPaper.diagnosis ?? "x");
    expect(held.status).toBe(409);
    expect(held.text).toMatch(/countersign/);
    result["controls"] = { no_confirmation: bare.status, forged: forged.status, instruction_as_confirmation: selfConfirm.status, wrong_diagnosis: wrongDiagnosis.status, stale_digest: stale.status, reused_confirmation: reused.status, unsigned_orders: held.status, stranger: stranger.speaker };

    // The accounts leg: the agent collates the bill and sends the pay link, verified from the read-back; it may not take the money.
    const accLine = `e5-${Date.now().toString(36)}-acc`;
    const bill = await port.commit("prepare_bill", { admission_id: stay }, `e5-bill-${Date.now()}`, prov(acc.owner, accLine));
    expect(bill.ok).toBe(true);
    const t1 = Date.now();
    const link = await port.commit("send_pay_link", { admission_id: stay }, `e5-link-${Date.now()}`, prov(acc.owner, `${accLine}-l`));
    expect(link.ok).toBe(true);
    const linkProof = link.ok ? await port.prove("send_pay_link", { admission_id: stay }, link, prov(acc.owner, `${accLine}-l`)) : null;
    expect(linkProof).not.toBeNull();
    result["pay_link_ms_to_verified"] = Date.now() - t1;
    const payPath = sb.person_ops["discharge_mark_paid"]!.path;
    const paid = await port.request("POST", payPath, prov(acc.owner, `${accLine}-p`), { body: { admissionId: stay, method: "cash" }, idempotencyKey: `e5-pay-${Date.now()}` });
    expect(paid.kind).toBe("refused");
    expect(sandboxQuery(sb, "e5_stay", { admission: stay })[0]).toMatchObject({ state: "discharged", cleared: false });

    // The accounts person records the payment; clearance follows and the bed is released.
    const person = personCaller(profile, sb, new Map(), []);
    const settled = await person("discharge_mark_paid", { admission_id: stay });
    expect(settled.ok).toBe(true);
    const after = sandboxQuery(sb, "e5_stay", { admission: stay })[0]!;
    expect(after).toMatchObject({ state: "discharged", cleared: true, bed_holder: null });
    result["accounts"] = { bill_report: bill.ok ? bill.report : null, pay_link_verified: !!linkProof, agent_mark_paid: paid.kind, person_settled: settled.status, cleared: after["cleared"], bed_state: after["bed_state"] };
    result["touches"] = { person_actions: 1, which: ["accounts person records the cash payment"], agent_confirmations_spoken: 1 };
    const out = process.env["HEY_PISGAH_E5_OUT"];
    if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  }, 300_000);
});
