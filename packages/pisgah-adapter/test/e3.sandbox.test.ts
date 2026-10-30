import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEnvText } from "@hey-pisgah/model";
import { KEPT_LEVERS, leversFrom, percentile, startEmrServe, type EmrRuntime, type EmrTaskView, type Provenance, type SpeakerVerdict } from "@hey-pisgah/agent";
import { ModelClient, ledgerRowsIn } from "@hey-pisgah/model";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { mintPersonBearer } from "../src/sandbox.js";
import { PisgahPort } from "../src/port.js";
import { loadProfile } from "../src/profile.js";
import { personCaller } from "../src/journey.sandbox.js";
import { SandboxBlock, mintAgentBearer, sandboxQuery } from "../src/sandbox.js";
import { freshArrival, paceAudio, sandboxEmbedder, voiceOf } from "./sandbox-helpers.js";

// Runs only with SANDBOX=1 and E3=1 against the loopback sandbox, with the speaker model files named by HEY_PISGAH_SPEAKER_MODEL and HEY_PISGAH_SHERPA_DIR.
const RUN = process.env["SANDBOX"] === "1" && process.env["E3"] === "1";
const now = () => new Date().toISOString();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Synthetic voices: the owner and Dr B are enrolled from R1's passages, and the third voice is enrolled by nobody.
export const VOICES = { owner: "Rishi", drb: "Daniel", stranger: "Samantha" } as const;
export function speak(voice: string, text: string, file: string): Uint8Array {
  mkdirSync(dirname(file), { recursive: true });
  execFileSync("say", ["-v", voice, "-o", file, "--file-format=WAVE", "--data-format=LEI16@24000", `${text} [[slnc 900]]`], { stdio: "ignore", timeout: 30_000 });
  return new Uint8Array(readFileSync(file));
}

// A named write from the private controls file, as the sandbox owner role or the app role, used only to show that the database refuses it.
function controlSql(sb: SandboxBlock, as: "owner" | "app", name: string, vars: Record<string, string>): { ok: boolean; out: string } {
  const file = process.env["HEY_PISGAH_E3_SQL"];
  if (!file) throw new Error("set HEY_PISGAH_E3_SQL to the private controls file");
  const sql = (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)[name];
  if (!sql) throw new Error(`no control named ${name}`);
  const env = parseEnvText(readFileSync(sb.env_file, "utf8"));
  const url = as === "owner" ? env["SANDBOX_APP_DB_OWNER_URL"]! : env[sb.db_url_var]!;
  if (!/@(localhost|127\.0\.0\.1):55433\//.test(url)) throw new Error("not the loopback sandbox");
  const args = ["-X", "-At", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), url];
  try { return { ok: true, out: execFileSync("psql", args, { input: `${sql};\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }) }; } catch (e) { return { ok: false, out: String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300) }; }
}

describe.skipIf(!RUN)("E3 voice orders, countersign and attribution on the sandbox EMR", () => {
  it("sends only owner-authorised orders without signing, holds the non-emergency lab order, countersigns exactly the read-back batch, and refuses every agent signature", async () => {
    const profile = loadProfile();
    const embed = sandboxEmbedder()!;
    expect(embed).not.toBeNull();
    const { patient, visit, sb } = await freshArrival(profile);
    const person = personCaller(profile, sb, new Map(), []);
    const mine = mintAgentBearer(sb);
    const port = new PisgahPort(profile, { bearers: { [mine.owner]: mine.bearer } });
    const dir = join(process.env["HEY_PISGAH_E3_TMP"] ?? "/tmp", `e3-${Date.now().toString(36)}`);
    const prov = (line: string): Provenance => ({ owner: mine.owner, evidence: `transcript:${line}`, spoken_at: now() });
    // Each line id and recording is new for this run, since a spoken line is bound to the first patient and order it authorises and one recording earns one token.
    const run = Date.now().toString(36);
    const matched = async (voice: string, text: string, line: string): Promise<SpeakerVerdict> => { const p = (await embed(speak(voice, `${text} Run ${run}.`, join(dir, `${line}.wav`))))!; await paceAudio(p); return port.speaker!(mine.owner, voiceOf(p), prov(line)); };
    const authorised = (line: string, v: SpeakerVerdict) => (v.speaker === "owner" ? `transcript:${line}~${v.token}` : undefined);
    const result: Record<string, unknown> = { visit_kind: "registered and paid" };
    const L = (x: string) => `${x}-${run}`;

    // Attribution: the owner's voice gets a token, Dr B is named with no token, and an unenrolled voice is unverified.
    const own = await matched(VOICES.owner, "Send a full blood count.", L("e3-own-1"));
    const drb = await matched(VOICES.drb, "Send a full blood count.", L("e3-drb-1"));
    const str = await matched(VOICES.stranger, "Send a full blood count.", L("e3-str-1"));
    expect(own.speaker).toBe("owner");
    expect(drb).toMatchObject({ speaker: "other_clinician", label: expect.stringMatching(/^Dr\./) });
    expect(str.speaker).toBe("unverified");
    result["attribution"] = { owner: own.speaker, drb: drb.speaker, stranger: str.speaker };

    // Negative control: with no matched line, and with a token for another line, the door sends nothing.
    const args = { visit_id: visit, patient_id: patient, test: "fbc" };
    const none = await port.commit("order_test", args, `e3-none-${visit}`, prov(L("e3-str-1")));
    expect(none).toMatchObject({ ok: false, status: 403 });
    const stolen = await port.commit("order_test", args, `e3-stolen-${visit}`, { ...prov(L("e3-str-1")), voice: { authorisation: `transcript:${L("e3-str-1")}~${(own as { token: string }).token}` } });
    expect(stolen).toMatchObject({ ok: false, status: 403 });
    expect(sandboxQuery(sb, "order_states_for_visit", { visit })).toHaveLength(0);

    // The owner's matched line sends the test as a voice order, unsigned, and the agent is named apart from the issuer.
    const sent = await port.commit("order_test", args, `e3-fbc-${visit}`, { ...prov(L("e3-own-1")), voice: { authorisation: authorised(L("e3-own-1"), own)! } });
    expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true });
    const fbcState = (sent as { record_id: string }).record_id;
    // Negative control: the same matched line cannot send the same order again under a fresh key.
    expect(await port.commit("order_test", args, `e3-fbc-again-${visit}`, { ...prov(L("e3-own-1")), voice: { authorisation: authorised(L("e3-own-1"), own)! } })).toMatchObject({ ok: false, status: 403 });
    expect(await port.prove("order_test", args, sent as { record_id: string; record_version: number; event_ids: string[] }, prov(L("e3-own-1")))).not.toBeNull();
    const [row] = sandboxQuery(sb, "order_states_for_visit", { visit });
    expect(row).toMatchObject({ id: fbcState, kind: "lab", requested_by: mine.agent, issued_by: mine.owner, authorised_by: mine.owner, sent_by: mine.agent, verbal: false, receiver_role: "lab_tech", countersigned_by: null, emergency: false, order_status: "AWAITING_PAYMENT" });
    expect(sandboxQuery(sb, "visit_status", { visit })[0]?.["consultation_state"]).not.toBe("completed");
    const audit = sandboxQuery(sb, "audit_for_visit", { visit }).find((a) => a["action_type"] === "visit.voice_order_sent");
    expect(audit).toMatchObject({ actor: mine.agent, agent: mine.agent, on_behalf_of: mine.owner, evidence: `transcript:${L("e3-own-1")}` });

    // Negative control: a non-emergency order waits its payment hold, so the lab board does not show it.
    const lab = await person("lab_queue", {});
    expect(lab.ok).toBe(true);
    expect(JSON.stringify(lab.json)).not.toContain(String(row!["diagnostic_order_id"]));

    // A prescription goes through the consultation's own prescribe path under the owner, and reaches the pharmacy board while the consultation is open.
    expect(await port.commit("open_consult", { visit_id: visit, patient_id: patient }, `e3-open-${visit}`, prov(L("e3-own-1")))).toMatchObject({ ok: true });
    const ownRx = await matched(VOICES.owner, "Give paracetamol tablets 500 milligrams by mouth three times a day, quantity 6.", L("e3-own-rx"));
    const rxArgs = { visit_id: visit, patient_id: patient, drug: "paracetamol_oral", dose: "500 mg", route: "oral", frequency: 3, quantity: 6 };
    const rx = await port.commit("prescribe", rxArgs, `e3-rx-${visit}`, { ...prov(L("e3-own-rx")), voice: { authorisation: authorised(L("e3-own-rx"), ownRx)! } });
    expect(rx, JSON.stringify(rx)).toMatchObject({ ok: true });
    expect(await port.prove("prescribe", rxArgs, rx as { record_id: string; record_version: number; event_ids: string[] }, prov(L("e3-own-rx")))).not.toBeNull();
    expect(sandboxQuery(sb, "visit_status", { visit })[0]?.["consultation_state"]).toBe("in_consultation");
    const pharm = await person("pharmacy_queue", {});
    expect(JSON.stringify(pharm.json)).toContain((rx as { record_id: string }).record_id);

    // A controlled drug is refused without the owner's spoken confirmation, and sent with it; it then needs a second clinician.
    const ownMo = await matched(VOICES.owner, "Give morphine 5 milligrams IV, one dose.", L("e3-own-mo"));
    const moArgs = { visit_id: visit, patient_id: patient, drug: "morphine", dose: "5 mg", route: "iv", quantity: 1 };
    const noConfirm = await port.commit("prescribe", moArgs, `e3-mo-noconfirm-${visit}`, { ...prov(L("e3-own-mo")), voice: { authorisation: authorised(L("e3-own-mo"), ownMo)! } });
    expect(noConfirm).toMatchObject({ ok: false });
    const ownConfirm = await matched(VOICES.owner, "Confirm.", L("e3-own-confirm"));
    const strConfirm = await matched(VOICES.stranger, "Confirm.", L("e3-str-confirm"));
    expect(strConfirm.speaker).not.toBe("owner");
    const mo = await port.commit("prescribe", moArgs, `e3-mo-${visit}`, { ...prov(L("e3-own-mo")), voice: { authorisation: authorised(L("e3-own-mo"), ownMo)!, confirmation: authorised(L("e3-own-confirm"), ownConfirm)! } });
    expect(mo, JSON.stringify(mo)).toMatchObject({ ok: true });
    const states = sandboxQuery(sb, "order_states_for_visit", { visit });
    expect(states.find((s) => s["controlled"])).toMatchObject({ needs_second_countersign: true, kind: "prescription" });

    // Sign everything: the read-back names three orders; an order sent after it is not in the batch the yes signs.
    const rb = await port.readBack!(mine.owner, visit, prov(L("e3-own-sign")));
    expect(rb.items).toHaveLength(3);
    const ownUa = await matched(VOICES.owner, "Send a urinalysis.", L("e3-own-ua"));
    const ua = await port.commit("order_test", { ...args, test: "urinalysis" }, `e3-ua-${visit}`, { ...prov(L("e3-own-ua")), voice: { authorisation: authorised(L("e3-own-ua"), ownUa)! } });
    expect(ua).toMatchObject({ ok: true });
    const yes = await matched(VOICES.owner, "Yes.", L("e3-own-yes"));
    const csArgs = { visit_id: visit, item_ids: rb.items.map((i) => i.stateId), items_digest: rb.itemsDigest!, read_back_at: rb.readBackAt, read_back_seal: rb.seal!, labels: rb.items.map((i) => i.label) };
    // Negative control: the agent with no matched yes cannot countersign anything.
    expect(await port.commit("countersign", csArgs, `e3-cs-none-${visit}`, prov(L("e3-own-yes")))).toMatchObject({ ok: false, status: 403 });
    const cs = await port.commit("countersign", csArgs, `e3-cs-${visit}`, { ...prov(L("e3-own-yes")), voice: { confirmation: authorised(L("e3-own-yes"), yes)! } });
    expect(cs, JSON.stringify(cs)).toMatchObject({ ok: true });
    const after = sandboxQuery(sb, "order_states_for_visit", { visit });
    expect(after.filter((s) => s["countersigned_by"] === mine.owner).map((s) => s["id"]).sort()).toEqual([...csArgs.item_ids].sort());
    expect(after.find((s) => s["id"] === (ua as { record_id: string }).record_id)?.["countersigned_by"]).toBeNull();
    const [batch] = sandboxQuery(sb, "batches_for_visit", { visit });
    expect(batch).toMatchObject({ signer: mine.owner, entered_by: mine.agent, signer_role: "issuer", method: "voice", voice_verdict: "owner", evidence: `transcript:${L("e3-own-yes")}` });

    // Negative control: an order changed after its read-back is not signed; the change here is simulated by cancelling it in the database.
    const rb2 = await port.readBack!(mine.owner, visit, prov(L("e3-own-sign2")));
    expect(rb2.items.map((i) => i.stateId)).toEqual([(ua as { record_id: string }).record_id]);
    const uaOrder = String(after.find((s) => s["id"] === (ua as { record_id: string }).record_id)?.["diagnostic_order_id"]);
    const changed = controlSql(sb, "owner", "simulate_change", { order: uaOrder });
    // Worded apart from the first yes, since one recording earns a token for one line only.
    const yes2 = await matched(VOICES.owner, "Yes please.", L("e3-own-yes2"));
    const cs2 = await port.commit("countersign", { visit_id: visit, item_ids: rb2.items.map((i) => i.stateId), items_digest: rb2.itemsDigest!, read_back_at: rb2.readBackAt, read_back_seal: rb2.seal!, labels: [] }, `e3-cs2-${visit}`, { ...prov(L("e3-own-yes2")), voice: { confirmation: authorised(L("e3-own-yes2"), yes2)! } });
    result["change_after_read_back"] = { simulated_by: changed.ok ? "status set to CANCELLED by the owner role" : `not simulated: ${changed.out}`, countersign: cs2 };
    if (changed.ok) expect(cs2).toMatchObject({ ok: false, status: 409 });
    expect(sandboxQuery(sb, "order_states_for_visit", { visit }).find((s) => s["id"] === (ua as { record_id: string }).record_id)?.["countersigned_by"]).toBeNull();

    // Negative control: the database refuses an agent row as countersigner and as a batch signer.
    const agentSigns = controlSql(sb, "owner", "agent_countersigns", { agent: mine.agent!, batch: String(batch!["id"]), state: (ua as { record_id: string }).record_id });
    expect(agentSigns.ok).toBe(false);
    expect(agentSigns.out).toMatch(/must be a person/);
    const agentBatch = controlSql(sb, "owner", "agent_signs_batch", { agent: mine.agent!, state: fbcState });
    expect(agentBatch.ok).toBe(false);

    // The controlled drug: its issuer alone is refused as second signer, and another doctor's own session signs it.
    const moState = states.find((s) => s["controlled"])!;
    const issuerRb = await person("issuer_read", { visit_id: visit });
    expect(issuerRb.ok).toBe(true);
    const selfSecond = await person("issuer_second_sign", { visit_id: visit, item_ids: [String(moState["id"])] as unknown as string, items_digest: "0".repeat(64), read_back_at: now(), read_back_seal: "x".repeat(43) });
    expect(selfSecond.ok).toBe(false);
    const second = await person("second_read", { visit_id: visit });
    const srb = second.json as { items: { stateId: string }[]; itemsDigest: string; readBackAt: string; readBackSeal: string; awaitingSecond: unknown[] };
    // The second clinician sees the items to sign and not the issuer's list of what else waits.
    expect(srb.awaitingSecond).toEqual([]);
    expect(srb.items.map((i) => i.stateId)).toEqual([String(moState["id"])]);
    const signed2 = await person("second_sign", { visit_id: visit, item_ids: srb.items.map((i) => i.stateId) as unknown as string, items_digest: srb.itemsDigest, read_back_at: srb.readBackAt, read_back_seal: srb.readBackSeal });
    // Negative control: the same countersign with a forged seal is refused.
    expect((await person("second_sign", { visit_id: visit, item_ids: srb.items.map((i) => i.stateId) as unknown as string, items_digest: srb.itemsDigest, read_back_at: srb.readBackAt, read_back_seal: "A".repeat(43) })).ok).toBe(false);
    expect(signed2.ok, JSON.stringify(signed2)).toBe(true);
    const moAfter = sandboxQuery(sb, "order_states_for_visit", { visit }).find((s) => s["id"] === moState["id"])!;
    expect(moAfter["second_countersigned_by"]).not.toBeNull();
    expect(moAfter["second_countersigned_by"]).not.toBe(mine.owner);

    // Negative control: an agent never enrols or revokes a voice; the database refuses it and the app role cannot delete or rewrite a template.
    const agentEnrol = controlSql(sb, "owner", "agent_enrols", { agent: mine.agent!, owner: mine.owner });
    expect(agentEnrol.ok).toBe(false);
    const agentRevoke = controlSql(sb, "owner", "agent_revokes", { agent: mine.agent!, owner: mine.owner });
    expect(agentRevoke.ok).toBe(false);
    expect(controlSql(sb, "app", "app_deletes_template", { owner: mine.owner })).toMatchObject({ ok: false, out: expect.stringMatching(/permission denied/) });
    expect(controlSql(sb, "app", "app_rewrites_template", { owner: mine.owner })).toMatchObject({ ok: false, out: expect.stringMatching(/permission denied/) });
    expect(sandboxQuery(sb, "template_for", { person: mine.owner })[0]).toMatchObject({ live: true, revoked: false });

    // Emergency mode removes the payment hold: an unnamed emergency arrival's voice order is on the lab board at once, marked as such.
    const em = await person("unnamed_arrival", { ref: `E3-${Date.now().toString(36)}` });
    expect(em.ok, JSON.stringify(em)).toBe(true);
    const emVisit = String((em.json as { visitId: string }).visitId), emPatient = String((em.json as { id: string }).id);
    expect(sandboxQuery(sb, "visit_status", { visit: emVisit })[0]?.["front_desk_status"]).toBe("emergency_override");
    const ownEm = await matched(VOICES.owner, "Send a full blood count, stat.", L("e3-own-em"));
    const emArgs = { visit_id: emVisit, patient_id: emPatient, test: "fbc", priority: "stat" };
    const emSent = await port.commit("order_test", emArgs, `e3-em-${emVisit}`, { ...prov(L("e3-own-em")), voice: { authorisation: authorised(L("e3-own-em"), ownEm)! } });
    expect(emSent, JSON.stringify(emSent)).toMatchObject({ ok: true });
    const [emRow] = sandboxQuery(sb, "order_states_for_visit", { visit: emVisit });
    // Since E5 the emergency edge routes the order to the bench at once; its charge stays held until the result.
    expect(emRow).toMatchObject({ emergency: true, order_status: "ROUTED_TO_LAB" });
    const emLab = await person("lab_queue", {});
    expect(JSON.stringify(emLab.json)).toContain(String(emRow!["diagnostic_order_id"]));
    result["emergency"] = { visit: emVisit, on_lab_board: true };

    // The one simulated deadline: the urinalysis falls due a minute after sending, and the next read puts it on the issuer's bell without a patient name.
    if (process.env["E3_SKIP_OVERDUE"] === "1") return;
    await new Promise((r) => setTimeout(r, 65_000));
    const ownUa2 = await matched(VOICES.owner, "Send another urinalysis.", L("e3-own-ua2"));
    const ua2 = await port.commit("order_test", { ...args, test: "urinalysis" }, `e3-ua2-${visit}`, { ...prov(L("e3-own-ua2")), voice: { authorisation: authorised(L("e3-own-ua2"), ownUa2)! } });
    expect(ua2).toMatchObject({ ok: true });
    await port.readBack!(mine.owner, visit, prov(L("e3-own-sign3")));
    const bell = sandboxQuery(sb, "bell_for", { person: mine.owner });
    expect(bell.some((b) => b["title"] === "Countersign overdue" && String(b["source_key"]).endsWith((ua as { record_id: string }).record_id))).toBe(true);
    // The alert names no patient: its words are the fixed overdue sentence.
    expect(bell.every((b) => String(b["body"]).startsWith("A voice order you gave is past its countersign time."))).toBe(true);
    result["escalated"] = sandboxQuery(sb, "order_states_for_visit", { visit }).filter((s) => s["countersign_escalated_at"]).map((s) => s["id"]);

    const file = process.env["HEY_PISGAH_E3_OUT"];
    if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify({ ...result, visit_states: sandboxQuery(sb, "order_states_for_visit", { visit }), batches: sandboxQuery(sb, "batches_for_visit", { visit }) }, null, 1)}\n`); }
    expect(uuid.test(fbcState)).toBe(true);
  }, 10 * 60_000);

  // The order speed run: live Voice Transcribe, live gate and second ear, the local speaker model, and the serve's default levers; timed from the end of each spoken line to the board showing the order.
  it.skipIf(process.env["E3_LIVE"] !== "1")("times voice orders from the end of the line to the lab and pharmacy boards, and keeps other voices from ordering", async () => {
    const profile = loadProfile();
    const sb = SandboxBlock.parse(profile.sandbox);
    const embed = sandboxEmbedder()!;
    const person = personCaller(profile, sb, new Map(), []);
    const reg = await freshArrival(profile);
    const em = await person("unnamed_arrival", { ref: `E3S-${Date.now().toString(36)}` });
    expect(em.ok).toBe(true);
    const emVisit = String((em.json as { visitId: string }).visitId), emPatient = String((em.json as { id: string }).id);
    const mine = mintAgentBearer(sb);
    const port = new PisgahPort(profile, { bearers: { [mine.owner]: mine.bearer } });
    const root = mkdtempSync(join(tmpdir(), "hp-e3s-"));
    let rt: EmrRuntime | null = null;
    const client = new ModelClient({ storeRoot: root, mode: "live", recordingsDir: join(root, "recordings"), taskStateOf: (id) => rt?.stateOf(id) ?? null });
    const levers = leversFrom(KEPT_LEVERS);
    const s = await startEmrServe({ storeRoot: root, port, client, embed, listenPort: Number(process.env["HEY_PISGAH_EMR_PORT"] ?? 4108), ears: "spark", runtime: { holdMs: 4000, proofRetryMs: 1500, speed: levers, keepHeard: true } });
    rt = s.runtime;
    // The boards as their own people see them, read every 300 ms; the first time an id shows is when the order reached that board.
    const labBearer = mintPersonBearer(sb, { login: "lab.grace" }), rxBearer = mintPersonBearer(sb, { login: "pharm.uduak" });
    const seen = new Map<string, number>();
    let polling = true;
    const poll = async (path: string, bearer: string) => {
      while (polling) {
        try {
          const r = await fetch(`${profile.base_url}/${path}`, { headers: { authorization: `Bearer ${bearer}`, accept: "application/json" } });
          const at = Date.now();
          for (const id of (await r.text()).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []) if (!seen.has(id)) seen.set(id, at);
        } catch { /* a dropped poll is retried */ }
        await new Promise((r) => setTimeout(r, 300));
      }
    };
    const pollers = [poll("lab/queue", labBearer), poll("pharmacy/queue", rxBearer)];
    await new Promise((r) => setTimeout(r, 1500));
    const before = new Set(seen.keys());
    const out: Record<string, unknown> = { levers: KEPT_LEVERS, hold_ms: 4000, started_at: new Date().toISOString(), voices: VOICES, synthetic: true };
    let seq = 0;
    const sayLine = async (voice: string, text: string, patientId: string, session: string, gapMs: number) => {
      const wav = speak(voice, text, join(root, `l${seq}.wav`));
      const form = new FormData();
      form.append("audio", new Blob([Buffer.from(wav)], { type: "audio/wav" }), `l${seq}.wav`);
      form.append("owner", mine.owner); form.append("patientId", patientId); form.append("session_id", session); form.append("seq", String(seq));
      seq += 1;
      const res = await fetch(`${s.url}/tasks/listen?wait=1`, { method: "POST", body: form });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, gapMs));
    };
    try {
      const E = `e3s-em-${emVisit.slice(0, 8)}`, R = `e3s-rx-${reg.visit.slice(0, 8)}`;
      await sayLine(VOICES.owner, "Send a full blood count, stat.", emPatient, E, 12_000);
      await sayLine(VOICES.owner, "Send a malaria parasite test.", emPatient, E, 12_000);
      await sayLine(VOICES.drb, "Send an abdominal ultrasound.", emPatient, E, 10_000);
      await sayLine(VOICES.stranger, "Send a urinalysis.", emPatient, E, 10_000);
      await sayLine(VOICES.owner, "Yes.", emPatient, E, 12_000);
      seq = 0;
      await sayLine(VOICES.owner, "Give paracetamol tablets five hundred milligrams by mouth three times a day, quantity six.", reg.patient, R, 14_000);
      await sayLine(VOICES.owner, "Give amoxicillin five hundred milligrams by mouth three times a day for five days, quantity fifteen.", reg.patient, R, 14_000);
      await sayLine(VOICES.owner, "Give morphine five milligrams IV, one dose.", reg.patient, R, 12_000);
      await sayLine(VOICES.owner, "Confirm.", reg.patient, R, 12_000);
      await sayLine(VOICES.owner, "Sign everything.", reg.patient, R, 6_000);
      await sayLine(VOICES.owner, "Yes.", reg.patient, R, 8_000);
      await s.listening.flush(E); await s.listening.flush(R);
      await s.runtime.settled(8 * 60_000);
      await new Promise((r) => setTimeout(r, 3000));
      const views = s.runtime.views(mine.owner) as EmrTaskView[];
      const states = [...sandboxQuery(sb, "order_states_for_visit", { visit: emVisit }), ...sandboxQuery(sb, "order_states_for_visit", { visit: reg.visit })];
      const rows: Record<string, unknown>[] = [];
      for (const v of views) {
        const lineEnd = new Map(v.transcript.map((l) => [l.id, Date.parse(l.ambient?.ended_at ?? l.at)]));
        for (const a of v.actions.filter((x) => ["order_test", "prescribe", "countersign"].includes(x.kind))) {
          const st = states.find((x) => x["id"] === a.proof?.record_id || x["prescription_id"] === a.proof?.record_id);
          const boardId = a.kind === "order_test" ? String(st?.["diagnostic_order_id"] ?? "") : a.kind === "prescribe" ? String(a.proof?.record_id ?? "") : "";
          const at = boardId && !before.has(boardId) ? seen.get(boardId) ?? null : null;
          const from = lineEnd.get(a.line_id) ?? null;
          const speedRow = v.speed.rows.find((x) => x.action_id === a.action_id);
          rows.push({ kind: a.kind, state: a.state, summary: a.summary, reason: a.reason, line: v.transcript.find((l) => l.id === a.line_id)?.text ?? "", speaker: v.transcript.find((l) => l.id === a.line_id)?.speaker ?? null,
            verified_ms: speedRow?.ms ?? null, board_ms: at !== null && from !== null ? at - from : null,
            board_ms_from_authorising_line: a.authorised_by_line && at !== null ? at - (lineEnd.get(a.authorised_by_line) ?? at) : null, board: a.kind === "order_test" ? "lab" : a.kind === "prescribe" ? "pharmacy" : null, order_status: st?.["order_status"] ?? null });
        }
      }
      const boardMs = rows.map((r) => r["board_ms"]).filter((x): x is number => typeof x === "number");
      const verifiedMs = rows.map((r) => r["verified_ms"]).filter((x): x is number => typeof x === "number");
      Object.assign(out, {
        rows, board: { n: boardMs.length, p50_ms: percentile(boardMs, 50), p90_ms: percentile(boardMs, 90) }, verified: { n: verifiedMs.length, p50_ms: percentile(verifiedMs, 50), p90_ms: percentile(verifiedMs, 90) },
        errors: views.map((v) => v.speed.errors), notes: views.flatMap((v) => v.notes.map((n) => n.text)).slice(-30), questions: views.flatMap((v) => v.asked.map((q) => q.text)).slice(-12),
        speakers: views.flatMap((v) => v.transcript.map((l) => ({ text: l.text, classes: l.classes, speaker: l.speaker?.speaker ?? null, embed_ms: l.speaker?.embed_ms ?? null, match_ms: l.speaker?.match_ms ?? null }))),
        usd: views.reduce((n, v) => n + v.usd, 0), calls: views.reduce((n, v) => n + v.calls, 0),
        ledger: readdirSync(join(root, "ledger")).flatMap((f) => ledgerRowsIn(join(root, "ledger", f))).map((x) => ({ purpose: x.purpose, model: x.model, ms: x.latency_ms, usd: x.cost_usd, effort: (x as { effort?: string }).effort ?? null }))
      });
      // Dr B's order and the unenrolled voice's order never went out on their own words.
      expect(rows.some((r) => String(r["summary"]).includes("abdominal ultrasound"))).toBe(false);
      const ua = rows.find((r) => String(r["summary"]).includes("urinalysis"));
      out["held_then_authorised"] = ua ?? null;
      expect(rows.filter((r) => r["state"] === "completed").length).toBeGreaterThanOrEqual(4);
    } finally {
      polling = false;
      await Promise.all(pollers);
      const file = process.env["HEY_PISGAH_E3_SPEED_OUT"];
      if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`); }
      await s.close();
      client.close();
    }
  }, 30 * 60_000);
});
