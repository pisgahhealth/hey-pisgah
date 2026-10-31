import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashJson } from "@hey-pisgah/contracts";
import { ModelClient } from "@hey-pisgah/model";
import { encodeWav, type FinalTranscript } from "@hey-pisgah/voice";
import { EmrRuntime } from "../src/emr/runtime.js";
import { ListenSessions, recordingTranscriber, replayTranscriber, type Transcriber } from "../src/emr/listen.js";
import { ROUND_RULE, gateCommitment, gateCommitmentBody, gateMessage, gatePrompt, denyHits } from "../src/emr/gate.js";
import { createHash } from "node:crypto";
import { GATE_COMMITMENT_FILE, committedGateHash } from "../src/emr/gate.commit.js";
import { startEmrServe } from "../src/emr/serve.js";
import { ADM, FakeEmr, OWNER, emrRoot, gater, type C } from "./emr-helpers.js";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const RATE = 16_000;
// A chunk the way the strip sends it: tone for speech, then an optional quiet tail.
const chunkWav = (talkMs: number, quietMs: number, pitch = 220) => {
  const a = new Float32Array(((talkMs + quietMs) * RATE) / 1000);
  for (let i = 0; i < (talkMs * RATE) / 1000; i++) a[i] = 0.3 * Math.sin((2 * Math.PI * pitch * i) / RATE);
  return encodeWav(a, RATE);
};

function boot(script: (said: string, user: string) => C[], ear: Transcriber, holdMs = 0) {
  const root = emrRoot();
  const port = new FakeEmr();
  let rt: EmrRuntime | null = null;
  const seen: string[] = [];
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater(script, seen), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs, proofRetryMs: 1 });
  rt.start();
  const listen = new ListenSessions(rt, { transcribe: ear });
  // A line that ends on a number waits for the next chunk; settling finishes it the way the end of listening does.
  const settled = rt.settled.bind(rt);
  rt.settled = async (ms?: number) => { await listen.flush("s1"); return settled(ms); };
  return { rt, port, listen, seen, client };
}
// An ear that reads a script by the chunk's speech length (its length less a 700 ms tail) or its whole length, and counts what it was sent.
const earOf = (byMs: Record<number, string>, sent: number[] = []): Transcriber => async (wav, _k, sessionId): Promise<FinalTranscript> => {
  const ms = Math.round(((wav.length - 44) / 2 / RATE) * 1000);
  sent.push(ms);
  return { final: true, text: byMs[ms - 700] ?? byMs[ms] ?? "", audio_ms: ms, session_id: sessionId, cost_usd: 0 };
};
const say = (l: ListenSessions, seq: number, wav: Uint8Array, session = "s1") => l.chunk({ owner: OWNER, target: { admission_id: ADM }, session_id: session, seq, wav }, true);

describe("speech gate", () => {
  it("is frozen in its commitment, holds no denied term and never shows vitals or record ids", () => {
    expect(committedGateHash()).toBe(hashJson(gateCommitment()));
    const last = JSON.parse(readFileSync(GATE_COMMITMENT_FILE, "utf8")).revisions.at(-1).body;
    expect(last.deny_hits).toEqual([]);
    expect(last.clerking.deny_hits).toEqual([]);
    // The observation gate the labelled talk was scored on is unchanged by the clerking revision.
    const rev2 = JSON.parse(readFileSync(GATE_COMMITMENT_FILE, "utf8")).revisions[1].body;
    expect([last.prompt_sha256, last.tool_sha256]).toEqual([rev2.prompt_sha256, rev2.tool_sha256]);
    // Revision 11 adds only the round-entry rule to every owner who clerks and holds record_note; without that line each prompt is its earlier revision's bytes.
    const before11 = (prompt: string) => sha256(prompt.replace(`\n${ROUND_RULE}`, ""));
    expect(last.clerking.prompt).toContain(ROUND_RULE);
    // The clerking owner's full prompt is otherwise still revision 3's bytes; the first stage added in revision 4 is scanned too.
    const rev3 = JSON.parse(readFileSync(GATE_COMMITMENT_FILE, "utf8")).revisions[2].body;
    expect([before11(last.clerking.prompt), last.clerking.tool_sha256]).toEqual([rev3.clerking.prompt_sha256, rev3.clerking.tool_sha256]);
    expect(last.first_stage.deny_hits).toEqual([]);
    // Revision 6 adds the home owners only; the clerking and order owners' prompts without release_home stay revision 5's bytes.
    const rev5 = JSON.parse(readFileSync(GATE_COMMITMENT_FILE, "utf8")).revisions[4].body;
    expect([before11(last.orders.prompt), last.orders.tool_sha256]).toEqual([rev5.orders.prompt_sha256, rev5.orders.tool_sha256]);
    for (const k of ["plain", "orders"]) {
      expect(last.home[k].deny_hits).toEqual([]);
      expect(last.home[k].prompt).not.toMatch(/sending the patient home[^.]*stay with staff/);
    }
    // Revision 7 adds the owner who may state the diagnosis; the home owners stay revision 6's bytes.
    const rev6 = JSON.parse(readFileSync(GATE_COMMITMENT_FILE, "utf8")).revisions[5].body;
    for (const k of ["plain", "orders"]) expect([before11(last.home[k].prompt), last.home[k].tool_sha256]).toEqual([rev6.home[k].prompt_sha256, rev6.home[k].tool_sha256]);
    const rev10 = JSON.parse(readFileSync(GATE_COMMITMENT_FILE, "utf8")).revisions[9].body;
    expect([before11(last.diagnosis.prompt), last.diagnosis.tool_sha256]).toEqual([rev10.diagnosis.prompt_sha256, rev10.diagnosis.tool_sha256]);
    expect(last.summary).toEqual(rev10.summary);
    expect(last.diagnosis.deny_hits).toEqual([]);
    expect(gateCommitmentBody().prompt_sha256).toBe(rev2.prompt_sha256);
    expect(denyHits(gatePrompt(["record_observation"]))).toEqual([]);
    expect(denyHits("we did it earlier")).not.toEqual([]);
    const m = gateMessage({
      kinds: ["record_observation"], openQuestion: null, recent: [], said: "Chart pulse 90",
      context: { admission_id: ADM, patient_id: null, label: "Test Patient", facts: { ward: "Ward A", bed: "A1", pulse: "77" }, keywords: [] },
      actions: [{ n: 1, kind: "record_observation", args: { admission_id: ADM, pulse: 88, corrects_record_id: "obs-1" }, state: "active", corrects: null }]
    });
    expect(m).toContain("#1 record_observation pulse 88: active");
    expect(m).not.toContain(ADM);
    expect(m).not.toContain("77");
    expect(m).not.toContain("obs-1");
  });

  it("acts only on permitted instructions, splits mixed lines, and asks below the floor", async () => {
    const { rt, port, listen } = boot((said) => {
      if (said.startsWith("Chart pulse 96")) return [{ class: "instruction", kind: "record_observation", pulse: 96, confidence: 0.95 }, { class: "aside", words: "hand me the gloves" }];
      if (said.startsWith("We could")) return [{ class: "option" }];
      if (said.startsWith("If her")) return [{ class: "conditional" }];
      if (said.startsWith("Sister")) return [{ class: "question_to_staff" }];
      if (said.startsWith("Stop the")) return [{ class: "instruction", kind: null, asked_for: "stop the IV fluids", confidence: 0.9 }];
      if (said.startsWith("Prescribe")) return [{ class: "instruction", kind: "prescribe", confidence: 0.9 }];
      if (said.startsWith("Maybe chart")) return [{ class: "instruction", kind: "record_observation", resp_rate: 20, confidence: 0.5 }];
      return [{ class: "aside" }];
    }, earOf({ 1000: "Chart pulse 96 and hand me the gloves.", 1100: "We could start oral antibiotics.", 1200: "If her temperature is 38.5 call me.", 1300: "Sister, has she passed urine?", 1400: "Stop the IV fluids.", 1500: "Prescribe paracetamol 1 g.", 1600: "Maybe chart respiratory rate 20." }));
    for (const [i, ms] of [1000, 1100, 1200, 1300, 1400, 1500, 1600].entries()) await say(listen, i, chunkWav(ms, 700));
    await rt.settled();
    const v = rt.views(OWNER)[0]!;
    expect(port.writes.map((w) => w.args.pulse)).toEqual([96]);
    expect(port.calls.find((c) => c.op === "commit")!.prov.evidence).toBe(`transcript:${v.transcript[0]!.id}`);
    expect(v.transcript.map((t) => t.classes)).toEqual([["instruction", "aside"], ["option"], ["conditional"], ["question_to_staff"], ["instruction"], ["instruction"], ["instruction"]]);
    expect(v.transcript[0]!.class).toBe("instruction");
    expect(v.actions[0]!.line_id).toBe(v.transcript[0]!.id);
    expect(v.refusals.map((r) => r.kind)).toEqual([null, "prescribe"]);
    expect(v.asked.map((q) => q.line_id)).toEqual([v.transcript[6]!.id]);
  });

  it("corrects the latest action unless one is named, carries values over and cites the record", async () => {
    const { rt, port, listen } = boot((said) => {
      if (said.startsWith("Chart temp")) return [{ class: "instruction", kind: "record_observation", temp_c: "37.9", pulse: 96, confidence: 0.95 }];
      if (said.startsWith("Chart blood")) return [{ class: "instruction", kind: "record_observation", bp: "128/76", confidence: 0.95 }];
      if (said.startsWith("Sorry the pulse")) return [{ class: "correction", kind: "record_observation", pulse: 104, target: "#1", confidence: 0.9 }];
      if (said.startsWith("No, 130")) return [{ class: "correction", kind: "record_observation", bp: "130/76", confidence: 0.9 }];
      return [{ class: "aside" }];
    }, earOf({ 1000: "Chart temp 37.9 and pulse 96.", 1100: "Chart blood pressure 128 over 76.", 1200: "No, 130 over 76.", 1300: "Sorry the pulse is 104, not 96." }));
    // Each line lands after the one before is written, as on a ward where words come seconds apart.
    for (const [i, ms] of [1000, 1100, 1200, 1300].entries()) { await say(listen, i, chunkWav(ms, 700)); await rt.settled(); }
    expect(port.writes.map((w) => w.args)).toEqual([
      { admission_id: ADM, temp_c: "37.9", pulse: 96 },
      { admission_id: ADM, bp: "128/76" },
      { admission_id: ADM, bp: "130/76", corrects_record_id: "obs-2" },
      { admission_id: ADM, temp_c: "37.9", pulse: 104, corrects_record_id: "obs-1" }
    ]);
  });

  it("replaces a correction's target that is still on hold instead of citing it", async () => {
    const { rt, port, listen } = boot((said) => (said.startsWith("Chart") ? [{ class: "instruction", kind: "record_observation", pulse: 96, confidence: 0.95 }] : [{ class: "correction", kind: "record_observation", pulse: 104, confidence: 0.9 }]),
      earOf({ 1000: "Chart pulse 96.", 1100: "Sorry, 104 not 96." }), 300);
    await say(listen, 0, chunkWav(1000, 700));
    await say(listen, 1, chunkWav(1100, 700));
    await rt.settled();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 104 }]);
    expect(rt.views(OWNER)[0]!.actions.map((a) => a.state)).toEqual(["cancelled", "completed"]);
  });

  it("keeps a question open through talk that is not for the agent, and closes it on the answer", async () => {
    const { rt, listen } = boot((said) => {
      if (said.startsWith("Chart the rate")) return [{ class: "unclear", question: "18 or 22?" }];
      if (said.startsWith("Rate 22")) return [{ class: "instruction", kind: "record_observation", resp_rate: 22, confidence: 0.9 }];
      return [{ class: "aside" }];
    }, earOf({ 1000: "Chart the rate, 18 or was it 22.", 1100: "Nice weather today.", 1200: "Rate 22." }));
    await say(listen, 0, chunkWav(1000, 700));
    await say(listen, 1, chunkWav(1100, 700));
    await rt.settled();
    let v = rt.views(OWNER)[0]!;
    expect(v.questions).toHaveLength(1);
    expect(v.state).toBe("waiting");
    await say(listen, 2, chunkWav(1200, 700));
    await rt.settled();
    v = rt.views(OWNER)[0]!;
    expect(v.questions).toHaveLength(0);
    expect(v.asked[0]!.answered_by).toBe(v.transcript[2]!.id);
    expect(v.actions.map((a) => a.args)).toEqual([{ resp_rate: 22 }]);
  });

  it("applies only clauses whose words come from the line, and a correction with no value said asks instead of copying", async () => {
    const { rt, port, listen } = boot((said) => {
      if (said.startsWith("Chart pulse 96")) return [{ class: "instruction", kind: "record_observation", pulse: 96, confidence: 0.95, words: "Chart pulse 96." }];
      if (said.startsWith("Respiratory rate 22")) return [
        { class: "instruction", kind: "record_observation", pulse: 96, confidence: 0.95, words: "Chart pulse 96." },
        { class: "instruction", kind: "record_observation", resp_rate: 22, confidence: 0.95, words: "respiratory rate 22, put that down" }
      ];
      return [{ class: "correction", kind: "record_observation", pulse: 104, target: "#1", confidence: 0.9, words: said }];
    }, earOf({ 1000: "Chart pulse 96.", 1100: "Respiratory rate 22, put that down.", 1200: "No, that one is wrong." }));
    for (const [i, ms] of [1000, 1100, 1200].entries()) { await say(listen, i, chunkWav(ms, 700)); await rt.settled(); }
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 96 }, { admission_id: ADM, resp_rate: 22 }]);
    const v = rt.views(OWNER)[0]!;
    expect(v.transcript[1]!.classes).toEqual(["instruction"]);
    expect(v.asked.map((q) => q.text)).toEqual(["Which value should I correct? Please say it again."]);
  });

  it("charts one spoken set of observations as one entry, and asks when one value is given twice", async () => {
    const { rt, port, listen } = boot((said) => (said.startsWith("Let's chart") ? [
      { class: "instruction", kind: "record_observation", confidence: 0.9, words: "Let's chart her observations." },
      { class: "instruction", kind: "record_observation", temp_c: "37.9", confidence: 0.95, words: "Temperature 37.9." },
      { class: "instruction", kind: "record_observation", pulse: 96, confidence: 0.95, words: "Pulse 96." },
      { class: "aside", words: "Thanks." }
    ] : [
      { class: "instruction", kind: "record_observation", pulse: 88, confidence: 0.95, words: "Pulse 88." },
      { class: "instruction", kind: "record_observation", pulse: 90, confidence: 0.95, words: "pulse 90." }
    ]), earOf({ 1000: "Let's chart her observations. Temperature 37.9. Pulse 96. Thanks.", 1100: "Pulse 88. No wait, pulse 90." }));
    for (const [i, ms] of [1000, 1100].entries()) { await say(listen, i, chunkWav(ms, 700)); await rt.settled(); }
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, temp_c: "37.9", pulse: 96 }]);
    expect(rt.views(OWNER)[0]!.asked.map((q) => q.text)).toEqual(['I heard "Pulse 88. pulse 90.". Say 88 or 90.']);
  });

  it("shows the gate only words said before the line, even when later lines are already heard", async () => {
    const users: string[] = [];
    const { rt, listen } = boot((_said, user) => { users.push(user); return [{ class: "aside" }]; }, earOf({ 1000: "First line.", 1100: "Second line.", 1200: "Third line." }), 0);
    void listen;
    const ctx = { admission_id: ADM, patient_id: null, label: "Test Patient", facts: { ward: "Ward A" }, keywords: [] };
    const meta = (seq: number) => ({ session_id: "s1", seqs: [seq], raw_text: "", ended_at: new Date().toISOString(), final_at: new Date().toISOString(), trailing_silence_ms: 700, finished_by: "quiet_tail" });
    // Three lines land before the first decision runs, so the queue holds all of them at once.
    const said = ["First line.", "Second line.", "Third line."].map((text, i) => rt.say({ owner: OWNER, target: { admission_id: ADM }, text, source: "audio", ambient: meta(i), context: ctx }));
    await Promise.all(said);
    await rt.settled();
    expect(rt.views(OWNER)[0]!.transcript).toHaveLength(3);
    const first = users.find((u) => u.includes('clinician_said: "First line."'))!;
    expect(first).not.toContain("Second line.");
    expect(users.find((u) => u.includes('clinician_said: "Second line."'))).not.toContain("Third line.");
  });

  it("drops a value the clinician did not say", async () => {
    const { rt, port, listen } = boot(() => [{ class: "instruction", kind: "record_observation", pulse: 96, resp_rate: 20, confidence: 0.95 }], earOf({ 1000: "Chart pulse 96." }));
    await say(listen, 0, chunkWav(1000, 700));
    await rt.settled();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 96 }]);
  });
});

describe("listening", () => {
  it("holds a capped chunk as audio and transcribes it joined with the next one", async () => {
    const sent: number[] = [];
    const { rt, port, listen, seen } = boot(() => [{ class: "instruction", kind: "record_observation", pulse: 90, confidence: 0.9 }], earOf({ 7700: "Chart pulse 90 for her please." }, sent));
    const first = await say(listen, 0, chunkWav(6000, 0));
    expect(first.outcome).toMatchObject({ final: false, why: "held_for_join" });
    expect(sent).toEqual([]);
    expect(seen).toEqual([]);
    const second = await say(listen, 1, chunkWav(1000, 700));
    expect(second.outcome).toMatchObject({ final: true, why: "quiet_tail", utterance: { seqs: [0, 1] } });
    expect(sent).toEqual([7700]);
    await rt.settled();
    expect(port.writes).toHaveLength(1);
    expect(rt.views(OWNER)[0]!.transcript[0]!.ambient).toMatchObject({ session_id: "s1", seqs: [0, 1], trailing_silence_ms: 700, finished_by: "quiet_tail" });
    // The session read the patient once; the line reused it instead of reading again.
    expect(port.calls.filter((c) => c.op === "resolve")).toHaveLength(1);
  });

  it("finishes held audio alone when the cap fell in the pause after speech", async () => {
    const sent: number[] = [];
    const { rt, listen, seen } = boot(() => [{ class: "aside" }], earOf({ 6000: "Bring a flask tomorrow.", 2700: "Hand me the gloves." }, sent));
    await say(listen, 0, chunkWav(5920, 80));
    const lead = new Float32Array((2700 * RATE) / 1000);
    for (let i = (1000 * RATE) / 1000; i < (2000 * RATE) / 1000; i++) lead[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE);
    const next = await say(listen, 1, encodeWav(lead, RATE));
    expect(next.outcome).toMatchObject({ why: "quiet_tail", utterance: { seqs: [1] } });
    expect(sent).toEqual([6000, 2700]);
    await rt.settled();
    expect(seen).toEqual(["Bring a flask tomorrow.", "Hand me the gloves."]);
  });

  it("never transcribes or acts on held audio when a chunk goes missing or the talk runs on", async () => {
    const sent: number[] = [];
    const { rt, port, listen, seen } = boot(() => [{ class: "instruction", kind: "record_observation", pulse: 90, confidence: 0.9 }], earOf({ 1000: "and pulse 90." }, sent));
    await say(listen, 0, chunkWav(6000, 0));
    const gap = await say(listen, 2, chunkWav(1000, 700));
    // The line after the gap ends on a number, so it waits; capped audio after it cannot carry the number on, so it goes alone.
    expect(gap.outcome).toMatchObject({ why: "held_for_number", transcript: "and pulse 90." });
    expect(sent).toEqual([1700]);
    const next = await say(listen, 3, chunkWav(6000, 0));
    expect(next.outcome).toMatchObject({ why: "held_for_join", utterance: { seqs: [2] } });
    for (let i = 4; i < 9; i++) await say(listen, i, chunkWav(6000, 0));
    expect(listen.session("s1")).toMatchObject({ dropped: 2 });
    await rt.settled();
    expect(seen).toEqual(["and pulse 90."]);
    expect(port.writes).toHaveLength(1);
  });

  it("answers duplicates from memory, refuses another owner's session, and a quiet-tail chunk with no words makes no line", async () => {
    const { rt, listen } = boot(() => [{ class: "aside" }], earOf({ 1000: "Hello there." }));
    await say(listen, 0, chunkWav(1000, 700));
    expect((await say(listen, 0, chunkWav(1000, 700))).outcome?.why).toBe("duplicate");
    expect((await say(listen, 1, chunkWav(1100, 700))).outcome?.why).toBe("empty");
    await expect(listen.chunk({ owner: "someone-else", target: { admission_id: ADM }, session_id: "s1", seq: 2, wav: chunkWav(1000, 700) })).rejects.toThrow(/another owner/);
    await rt.settled();
    expect(rt.views(OWNER)[0]!.transcript).toHaveLength(1);
  });

  it("keeps transcripts by audio hash and replays them without the service", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "hp-ear-")), "transcripts.json");
    const wav = chunkWav(1000, 700);
    const live = recordingTranscriber(earOf({ 1000: "Chart pulse 90." }), file);
    expect((await live(wav, [], "a")).text).toBe("Chart pulse 90.");
    expect((await replayTranscriber(file)(wav, [], "b")).text).toBe("Chart pulse 90.");
    await expect(replayTranscriber(file)(chunkWav(900, 700), [], "c")).rejects.toThrow(/no kept transcript/);
  });
});

describe("POST /tasks/listen", () => {
  it("answers at once, then reports the utterance with its class, and the task view carries class and line_id", async () => {
    const root = emrRoot();
    const port = new FakeEmr();
    let rt: EmrRuntime | null = null;
    const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater(() => [{ class: "instruction", kind: "record_observation", pulse: 92, confidence: 0.9 }]), taskStateOf: (id) => rt?.stateOf(id) ?? null });
    let release: () => void = () => undefined;
    const gateOpen = new Promise<void>((r) => { release = r; });
    const s = await startEmrServe({
      storeRoot: root, port, client, listenPort: 0, runtime: { holdMs: 0, proofRetryMs: 1 },
      transcribe: async (_w, _k, id) => { await gateOpen; return { final: true, text: "Chart pulse 92.", audio_ms: 1000, session_id: id, cost_usd: 0 }; }
    });
    rt = s.runtime;
    const form = (seq: number) => {
      const f = new FormData();
      f.append("audio", new Blob([chunkWav(1000, 700)], { type: "audio/wav" }), "c.wav");
      f.append("owner", OWNER); f.append("admissionId", ADM); f.append("session_id", "press-1"); f.append("seq", String(seq));
      return f;
    };
    const r1 = await fetch(`${s.url}/tasks/listen`, { method: "POST", body: form(0), headers: { origin: "http://localhost:3311" } });
    expect(r1.status).toBe(202);
    expect(r1.headers.get("access-control-allow-origin")).toBe("http://localhost:3311");
    expect(await r1.json()).toMatchObject({ session_id: "press-1", seq: 0, accepted: true, utterances: [], partial: null });
    release();
    await s.listening.drain("press-1");
    await s.runtime.settled();
    const r2 = (await (await fetch(`${s.url}/tasks/listen?wait=1`, { method: "POST", body: form(1) })).json()) as { utterances: { id: string; class: string }[] };
    expect(r2.utterances[0]).toMatchObject({ class: "instruction", text: "Chart pulse 92." });
    await s.runtime.settled();
    const v = ((await (await fetch(`${s.url}/tasks?owner=${OWNER}`)).json()) as any[])[0];
    expect(v.transcript[0]).toMatchObject({ id: r2.utterances[0]!.id, line_id: r2.utterances[0]!.id, class: "instruction" });
    expect(v.actions[0].line_id).toBe(v.transcript[0].id);
    const bad = await fetch(`${s.url}/tasks/listen`, { method: "POST", body: (() => { const f = form(2); f.delete("session_id"); return f; })() });
    expect(bad.status).toBe(400);
    await s.close();
    client.close();
  });
});
