import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ModelClient, parseEnvText } from "@hey-pisgah/model";
import { EmrRuntime, type EmrTaskView, type Provenance, type SpeakerVerdict } from "@hey-pisgah/agent";
import { PisgahPort } from "../src/port.js";
import { loadProfile } from "../src/profile.js";
import { mintAgentBearer, SandboxBlock, sandboxQuery } from "../src/sandbox.js";
import { speak, VOICES } from "./e3.sandbox.test.js";
import { freshArrival, paceAudio, sandboxEmbedder, voiceOf } from "./sandbox-helpers.js";

// Runs only with SANDBOX=1 and G1=1 against the loopback sandbox; the owner's lines are matched by the local speaker model and no language model is called.
const RUN = process.env["SANDBOX"] === "1" && process.env["G1"] === "1";
const now = () => new Date().toISOString();
const run = Date.now().toString(36);
const results: Record<string, unknown> = { run, synthetic: true };

// A named write from the private controls file, as the sandbox owner role, used only to simulate a lost answer.
function controlSql(sb: SandboxBlock, name: string, vars: Record<string, string>): string {
  const file = process.env["HEY_PISGAH_G1_SQL"];
  if (!file) throw new Error("set HEY_PISGAH_G1_SQL to the private controls file");
  const sql = (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)[name];
  if (!sql) throw new Error(`no control named ${name}`);
  const url = parseEnvText(readFileSync(sb.env_file, "utf8"))["SANDBOX_APP_DB_OWNER_URL"]!;
  if (!/@(localhost|127\.0\.0\.1):55433\//.test(url)) throw new Error("not the loopback sandbox");
  return execFileSync("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), url], { input: `${sql};\n`, encoding: "utf8" });
}

describe.skipIf(!RUN)("G1 one spoken authorisation, one patient, one encounter, one action and its contents", () => {
  const profile = RUN ? loadProfile() : null!;
  let sb: SandboxBlock, port: PisgahPort, mine: { owner: string; agent: string | null };
  let A: { patient: string; visit: string }, B: typeof A, C: typeof A, D: typeof A;
  let matched: (text: string, line: string) => Promise<string>;
  const prov = (line: string, voice?: Provenance["voice"]): Provenance => ({ owner: mine.owner, evidence: `transcript:${line}`, spoken_at: now(), ...(voice ? { voice } : {}) });
  const order = (v: typeof A, test: string) => ({ visit_id: v.visit, patient_id: v.patient, test });
  const states = (v: typeof A) => sandboxQuery(sb, "order_states_for_visit", { visit: v.visit });

  beforeAll(async () => {
    const embed = sandboxEmbedder()!;
    expect(embed).not.toBeNull();
    const a = await freshArrival(profile);
    sb = a.sb;
    A = a; B = await freshArrival(profile); C = await freshArrival(profile); D = await freshArrival(profile);
    const m = mintAgentBearer(sb);
    mine = m;
    port = new PisgahPort(profile, { bearers: { [m.owner]: m.bearer } });
    const dir = join(process.env["HEY_PISGAH_G1_TMP"] ?? "/tmp", `g1-${run}`);
    // Every line id and recording is new for this run, so no earlier run's spent line or recording is reused.
    matched = async (text, line) => {
      const print = (await embed(speak(VOICES.owner, `${text} Run ${run}.`, join(dir, `${line}.wav`))))!;
      await paceAudio(print);
      const v: SpeakerVerdict = await port.speaker!(m.owner, voiceOf(print), prov(line));
      if (v.speaker !== "owner") throw new Error(`the owner's synthetic voice was not matched (${v.speaker})`);
      return `transcript:${line}~${v.token}`;
    };
  }, 5 * 60_000);

  it("refuses a line spent on one patient's order when it is sent for another patient", async () => {
    const line = `g1-${run}-patient`;
    const auth = await matched("Send a full blood count.", line);
    expect(await port.commit("order_test", order(A, "fbc"), `${line}-a`, prov(line, { authorisation: auth }))).toMatchObject({ ok: true });
    const other = await port.commit("order_test", order(B, "fbc"), `${line}-b`, prov(line, { authorisation: auth }));
    results["changed_patient"] = other;
    expect(other).toMatchObject({ ok: false, status: 403 });
    expect(states(B)).toHaveLength(0);
  }, 120_000);

  it("refuses a line spent on one test when it is sent for a different test", async () => {
    const line = `g1-${run}-contents`;
    const auth = await matched("Send a malaria parasite test.", line);
    expect(await port.commit("order_test", order(A, "malaria"), `${line}-a`, prov(line, { authorisation: auth }))).toMatchObject({ ok: true });
    const changed = await port.commit("order_test", order(A, "urinalysis"), `${line}-b`, prov(line, { authorisation: auth }));
    results["changed_contents"] = changed;
    expect(changed).toMatchObject({ ok: false, status: 403 });
    expect(states(A).filter((s) => String(s["authorised_evidence"]) === `transcript:${line}`)).toHaveLength(1);
  }, 120_000);

  it("refuses a line spent on an order when it is offered as a countersign", async () => {
    const line = `g1-${run}-purpose`;
    const auth = await matched("Send a urinalysis.", line);
    expect(await port.commit("order_test", order(B, "urinalysis"), `${line}-a`, prov(line, { authorisation: auth }))).toMatchObject({ ok: true });
    const rb = await port.readBack!(mine.owner, B.visit, prov(line));
    expect(rb.items.length).toBeGreaterThan(0);
    const cs = await port.commit("countersign", { visit_id: B.visit, item_ids: rb.items.map((i) => i.stateId), items_digest: rb.itemsDigest!, read_back_at: rb.readBackAt, read_back_seal: rb.seal!, labels: [] }, `${line}-cs`, prov(line, { confirmation: auth }));
    results["changed_purpose"] = cs;
    expect(cs).toMatchObject({ ok: false, status: 403 });
    expect(states(B).filter((s) => s["countersigned_by"] !== null)).toHaveLength(0);
  }, 120_000);

  it("refuses the identical order sent again under a fresh key", async () => {
    const line = `g1-${run}-replay`;
    const auth = await matched("Send a malaria parasite test now.", line);
    expect(await port.commit("order_test", order(B, "malaria"), `${line}-a`, prov(line, { authorisation: auth }))).toMatchObject({ ok: true });
    const again = await port.commit("order_test", order(B, "malaria"), `${line}-b`, prov(line, { authorisation: auth }));
    results["identical_replay"] = again;
    expect(again).toMatchObject({ ok: false, status: 403 });
    expect(states(B).filter((s) => String(s["authorised_evidence"]) === `transcript:${line}`)).toHaveLength(1);
  }, 120_000);

  it("answers a retry under the same key with the original result after the first answer was lost", async () => {
    const line = `g1-${run}-retry`;
    const key = `${line}-k`;
    const auth = await matched("Send a full blood count please.", line);
    const first = await port.commit("order_test", order(D, "fbc"), key, prov(line, { authorisation: auth }));
    expect(first).toMatchObject({ ok: true });
    // The door's key store loses the answer, as it does when a write commits and its response fails.
    controlSql(sb, "forget_key", { key, agent: mine.agent! });
    const retry = await port.commit("order_test", order(D, "fbc"), key, prov(line, { authorisation: auth }));
    results["retry"] = { first, retry };
    expect(retry).toMatchObject({ ok: true, record_id: (first as { record_id: string }).record_id });
    expect(states(D)).toHaveLength(1);
  }, 120_000);

  it("gives one recording a token for one line only", async () => {
    const embed = sandboxEmbedder()!;
    const wav = speak(VOICES.owner, `Send an abdominal ultrasound. Run ${run}.`, join(process.env["HEY_PISGAH_G1_TMP"] ?? "/tmp", `g1-${run}`, "same.wav"));
    const raw = (await embed(wav))!;
    await paceAudio(raw);
    const print = voiceOf(raw);
    const first = await port.speaker!(mine.owner, print, prov(`g1-${run}-same-1`));
    const again = await port.speaker!(mine.owner, print, prov(`g1-${run}-same-2`));
    results["same_recording"] = { first: first.speaker, again: again.speaker };
    expect(first.speaker).toBe("owner");
    expect(again.speaker).toBe("unverified");
  }, 120_000);

  it.skipIf(!profile?.headers.authorisation_batch)("sends the tests one line named as its batch, and nothing outside that batch", async () => {
    const line = `g1-${run}-batch`;
    const auth = await matched("Send a urinalysis and a malaria parasite test.", line);
    const batch = [port.voiceItem("order_test", order(C, "urinalysis"))!, port.voiceItem("order_test", order(C, "malaria"))!].sort();
    const v = { authorisation: auth, batch };
    expect(await port.commit("order_test", order(C, "urinalysis"), `${line}-u`, prov(line, v))).toMatchObject({ ok: true });
    expect(await port.commit("order_test", order(C, "malaria"), `${line}-m`, prov(line, v))).toMatchObject({ ok: true });
    const outside = await port.commit("order_test", order(C, "fbc"), `${line}-f`, prov(line, v));
    const widened = await port.commit("order_test", order(C, "fbc"), `${line}-w`, prov(line, { authorisation: auth, batch: [...batch, port.voiceItem("order_test", order(C, "fbc"))!].sort() }));
    results["batch"] = { outside, widened };
    expect(outside).toMatchObject({ ok: false, status: 403 });
    expect(widened).toMatchObject({ ok: false, status: 403 });
    expect(states(C)).toHaveLength(2);
  }, 120_000);

  it.skipIf(!profile?.work["record_diagnosis"])("records a spoken diagnosis once, answers its retry with the original result, and refuses its lines on another visit", async () => {
    const instr = `g1-${run}-dx`, conf = `g1-${run}-dx-c`, key = `${instr}-k`;
    for (const v of [D, A]) expect(await port.commit("open_consult", { visit_id: v.visit, patient_id: v.patient }, `g1-${run}-open-${v.visit}`, prov(instr))).toMatchObject({ ok: true });
    const voice = { authorisation: await matched("The diagnosis is acute gastroenteritis.", instr), confirmation: await matched("Confirm.", conf) };
    const dx = (v: typeof A) => ({ visit_id: v.visit, patient_id: v.patient, diagnosis: "ZZ-TEST G1 acute gastroenteritis" });
    const first = await port.commit("record_diagnosis", dx(D), key, prov(instr, voice));
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
    controlSql(sb, "forget_key", { key, agent: mine.agent! });
    const retry = await port.commit("record_diagnosis", dx(D), key, prov(instr, voice));
    const elsewhere = await port.commit("record_diagnosis", dx(A), `${instr}-a`, prov(instr, voice));
    results["diagnosis"] = { first, retry, elsewhere };
    expect(retry).toMatchObject({ ok: true });
    expect(elsewhere).toMatchObject({ ok: false, status: 409 });
    expect(sandboxQuery(sb, "draft_diagnosis", { visit: A.visit })[0]?.["has_draft"]).toBe(false);
  }, 180_000);

  it.skipIf(!profile?.headers.authorisation_batch)("prescribes the two medicines one line named as its batch, and no third", async () => {
    const line = `g1-${run}-rx`;
    const auth = await matched("Give paracetamol five hundred milligrams and amoxicillin five hundred milligrams by mouth.", line);
    const rx = (drug: string, more: Record<string, unknown>) => ({ visit_id: D.visit, patient_id: D.patient, drug, dose: "500 mg", route: "oral", frequency: 3, ...more });
    const para = rx("paracetamol_oral", { quantity: 6 }), amox = rx("amoxicillin", { duration_days: 5, quantity: 15 });
    const batch = [port.voiceItem("prescribe", para)!, port.voiceItem("prescribe", amox)!].sort();
    const one = await port.commit("prescribe", para, `${line}-p`, prov(line, { authorisation: auth, batch }));
    const two = await port.commit("prescribe", amox, `${line}-a`, prov(line, { authorisation: auth, batch }));
    const third = await port.commit("prescribe", rx("paracetamol_iv", { quantity: 1 }), `${line}-iv`, prov(line, { authorisation: auth, batch }));
    // Control: the same third medicine on its own matched line is sent, so the batch alone refused it.
    const ownLine = `g1-${run}-rx-iv`;
    const alone = await port.commit("prescribe", rx("paracetamol_iv", { quantity: 1 }), `${ownLine}-k`, prov(ownLine, { authorisation: await matched("Give paracetamol one gram IV.", ownLine) }));
    results["prescribe_batch"] = { one, two, third, alone };
    expect(one, JSON.stringify(one)).toMatchObject({ ok: true });
    expect(two, JSON.stringify(two)).toMatchObject({ ok: true });
    expect(third).toMatchObject({ ok: false });
    expect(alone, JSON.stringify(alone)).toMatchObject({ ok: true });
  }, 180_000);

  it("signs exactly the read-back batch on the owner's spoken okay, sign them, through the runtime with no model call, and signs nothing after the batch changed", async () => {
    const embed = sandboxEmbedder()!;
    const root = mkdtempSync(join(tmpdir(), "g1-rt-"));
    // Every line here is settled by rule; a model call would throw and fail the run.
    const client = new ModelClient({ storeRoot: root, mode: "mock", mock: () => { throw new Error("G1 makes no model call"); } });
    const rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 500 });
    const dir = join(process.env["HEY_PISGAH_G1_TMP"] ?? "/tmp", `g1-${run}`);
    let n = 0;
    const say = async (v: typeof A, text: string) => {
      n += 1;
      const print = (await embed(speak(VOICES.owner, `${text} Run ${run}.`, join(dir, `rt-${n}.wav`))))!;
      await paceAudio(print);
      return rt.say({ owner: mine.owner, target: { patient_id: v.patient }, text, source: "audio", voiceprint: print });
    };
    try {
      const before = states(C).filter((x) => x["countersigned_by"] === null).map((x) => String(x["id"])).sort();
      expect(before.length).toBeGreaterThan(0);
      await say(C, "Sign everything.");
      await rt.settled(120_000);
      const yes = await say(C, "Okay, sign them.");
      await rt.settled(120_000);
      const signed = states(C).filter((x) => x["countersigned_by"] === mine.owner).map((x) => String(x["id"])).sort();
      const view = rt.view(yes.task_id) as EmrTaskView;
      results["runtime_countersign"] = { before, signed, notes: view.notes.map((x) => x.text).slice(-4), calls: view.calls, speed: view.speed.rows };
      expect(signed).toEqual(before);
      // Negative control: the batch read back on B changes in the hospital before the owner's yes, and nothing is signed.
      // Worded apart from C's line, since one recording earns one token.
      await say(B, "Sign them all.");
      await rt.settled(120_000);
      controlSql(sb, "simulate_change", { order: String(states(B).find((x) => x["diagnostic_order_id"])!["diagnostic_order_id"]) });
      const late = await say(B, "Yeah, go on.");
      await rt.settled(120_000);
      const lateView = rt.view(late.task_id) as EmrTaskView;
      results["runtime_changed_batch"] = { task: late.task_id === yes.task_id ? "same task as C" : "own task", patient: lateView.patient_id, signed: states(B).filter((x) => x["countersigned_by"] !== null).length, actions: lateView.actions.filter((a) => a.kind === "countersign").map((a) => [a.state, a.reason]), questions: lateView.questions.map((q) => q.text).slice(-2), notes: lateView.notes.map((x) => x.text).slice(-4), lines: lateView.transcript.map((l) => l.text).slice(-3), calls: lateView.calls };
      expect(states(B).filter((x) => x["countersigned_by"] !== null)).toHaveLength(0);
      // The owner's yes was taken for B's read-back, sent, and refused by the hospital because the batch changed.
      expect(lateView.actions.filter((a) => a.kind === "countersign").length).toBe(1);
      expect(lateView.actions.filter((a) => a.kind === "countersign").every((a) => a.state !== "completed")).toBe(true);
      expect(view.calls + lateView.calls).toBe(0);
    } finally {
      await rt.stop();
      client.close();
    }
  }, 300_000);

  it("writes what it saw", () => {
    const out = process.env["HEY_PISGAH_G1_OUT"];
    if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(results, null, 1)}\n`); }
  });
});
