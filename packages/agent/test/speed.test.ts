import { describe, expect, it } from "vitest";
import { ModelClient, type CallArgs, type CallResult, type ChatCompletion } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { EmrRuntime } from "../src/emr/runtime.js";
import { ListenSessions } from "../src/emr/listen.js";
import type { SecondEar } from "../src/emr/ears.js";
import type { EmrProof } from "../src/emr/port.js";
import { LEVERS_OFF, hedgedRead, holdLeftMs, leversFrom, sharedMeasures, willWriteNumber, type SpeedLevers } from "../src/emr/speed.js";
import { ADMIT, ClerkFake, DOC } from "./clerking-helpers.js";
import { emrRoot, ledgerRows, type C } from "./emr-helpers.js";
import { chunkWav, earOf } from "./mic-helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Seen = { tool: string; said: string; at: number; user: string };
const saidOf = (user: string) => JSON.parse(/clinician_said: (".*")$/m.exec(user)?.[1] ?? '""') as string;
const reply = (tool: string, args: unknown, model: string): ChatCompletion => ({
  id: `mock-${tool}`, object: "chat.completion", created: 0, model,
  choices: [{ index: 0, finish_reason: "tool_calls", logprobs: null, message: { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "call_1", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
});

// A mock model that answers the first look and the full gate from scripts, each after its own delay, and logs when each call started.
class SlowModel extends ModelClient {
  readonly seen: Seen[] = [];
  constructor(root: string, o: { full: (said: string) => C[]; first?: (said: string) => Record<string, unknown>; ms?: (tool: string, said: string) => number }, stateOf: () => EmrRuntime | null) {
    super({
      storeRoot: root, mode: "mock", taskStateOf: (id) => stateOf()?.stateOf(id) ?? null,
      mock: ({ body }) => {
        const tool = String(((body["tools"] as { function: { name: string } }[]) ?? [])[0]?.function.name ?? "");
        const user = String((body["messages"] as { role: string; content: string }[]).find((m) => m.role === "user")?.content ?? "");
        const said = saidOf(user);
        if (tool === "first_look") return reply(tool, o.first?.(said) ?? { look: "unsure", confidence: 0.9 }, String(body["model"]));
        return reply("gate", { clauses: o.full(said).map((c) => ({ words: said, ...c })) }, String(body["model"]));
      }
    });
    this.ms = o.ms ?? (() => 0);
  }
  private readonly ms: (tool: string, said: string) => number;
  override async call(args: CallArgs): Promise<CallResult> {
    const t = args.tools?.[0];
    const tool = t && t.type === "function" ? t.function.name : "";
    const user = String(args.messages.find((m) => m.role === "user")?.content ?? "");
    this.seen.push({ tool, said: saidOf(user), at: Date.now(), user });
    await sleep(this.ms(tool, saidOf(user)));
    return super.call(args);
  }
}

// A clerking doctor's task on an admitted patient, with the levers named and a listener in front of it.
function bootSpeed(levers: Partial<SpeedLevers>, o: { full: (said: string) => C[]; first?: (said: string) => Record<string, unknown>; ms?: (tool: string, said: string) => number; holdMs?: number; second?: SecondEar; prove?: (n: number, written: { record_id: string; record_version: number; event_ids: string[] }) => Promise<EmrProof | null>; transcripts?: Record<number, string>; numberMs?: number }) {
  const root = emrRoot();
  const port = new ClerkFake();
  port.admitted = true;
  let proves = 0;
  if (o.prove) port.prove = async (_k, _a, written) => o.prove!(++proves, written);
  let rt: EmrRuntime | null = null;
  const client = new SlowModel(root, o, () => rt);
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: o.holdMs ?? 0, proofRetryMs: 1, speed: { ...LEVERS_OFF, ...levers }, ...(o.second ? { secondEar: o.second } : {}) });
  rt.start();
  const listen = new ListenSessions(rt, { transcribe: earOf(o.transcripts ?? {}), numberJoinWaitMs: o.numberMs ?? 3000, strongJoinWaitMs: 3000 });
  const chunk = (seq: number, wav: Uint8Array, wait = true) => listen.chunk({ owner: DOC, target: { admission_id: ADMIT }, session_id: "s1", seq, wav }, wait);
  const sayText = (text: string, endedMsAgo = 0) => rt!.say({ owner: DOC, target: { admission_id: ADMIT }, text, source: "audio", spoken_at: new Date(Date.now() - endedMsAgo - 1000).toISOString(),
    ambient: { session_id: "s1", seqs: [0], raw_text: text, ended_at: new Date(Date.now() - endedMsAgo).toISOString(), final_at: new Date().toISOString(), trailing_silence_ms: 700, finished_by: "quiet_tail" }, clip: chunkWav(1000, 700) });
  return { rt, port, client, root, listen, chunk, sayText };
}
const obs = (v: Record<string, unknown>): C[] => [{ class: "instruction", kind: "record_observation", confidence: 0.95, ...v }];
const pulseOf = (said: string) => Number(/(\d+)/.exec(said)?.[1]);
const stream = (root: string, rt: EmrRuntime) => readStream(root, `emr/${rt.taskIds()[0]!}`);

describe("speed levers, each alone", () => {
  it("reads the lever list and keeps the hold length, measured from the anchor", () => {
    expect(leversFrom("none")).toEqual(LEVERS_OFF);
    expect(leversFrom("1,3")).toMatchObject({ holdFromSpeech: true, firstStage: false, proofBeside: true, parallelLines: 1 });
    expect(leversFrom("all").parallelLines).toBe(3);
    expect(holdLeftMs(4000, null, 10_000)).toBe(4000);
    expect(holdLeftMs(4000, 9_000, 10_000)).toBe(3000);
    expect(holdLeftMs(4000, 1_000, 10_000)).toBe(0);
    expect(holdLeftMs(4000, 20_000, 10_000)).toBe(4000);
    expect(willWriteNumber("Chart his pulse 116.")).toBe(true);
    expect(willWriteNumber("Bring a flask tomorrow at 7.")).toBe(false);
    expect(sharedMeasures("Chart his pulse 116.", "Pulse was 112")).toEqual(["pulse"]);
    expect(sharedMeasures("Chart his pulse 116.", "Temperature 38.3")).toEqual([]);
  });

  it("lever 1: the hold runs from the end of the line, so a decision slower than the hold writes at once, and a Stop inside the window still stops it", async () => {
    const slow = bootSpeed({ holdFromSpeech: true }, { full: (s) => obs({ pulse: pulseOf(s) }), ms: () => 150, holdMs: 400 });
    await slow.sayText("Chart his pulse 116.", 300);
    await slow.rt.settled();
    expect(slow.port.writes.map((w) => w.args["pulse"])).toEqual([116]);
    // The line ended 300 ms before it arrived and the gate took 150 ms, so the 400 ms window from the end of the line is over when the action is proposed.
    const v = slow.rt.view(slow.rt.taskIds()[0]!)!;
    expect(v.speed.rows[0]!.parts["hold_until"]).toBe(400);
    expect(v.speed.rows[0]!.parts["written"]! - v.speed.rows[0]!.parts["proposed"]!).toBeLessThan(200);

    const stop = bootSpeed({ holdFromSpeech: true }, { full: (s) => obs({ pulse: pulseOf(s) }), holdMs: 400 });
    await stop.sayText("Chart his pulse 112.", 0);
    await sleep(100);
    stop.rt.interrupt(stop.rt.taskIds()[0]!, DOC);
    await stop.rt.settled();
    expect(stop.port.writes).toEqual([]);

    // Without the lever the whole hold starts when the action is proposed.
    const off = bootSpeed({}, { full: (s) => obs({ pulse: pulseOf(s) }), ms: () => 150, holdMs: 400 });
    await off.sayText("Chart his pulse 108.", 300);
    await off.rt.settled();
    const w = off.rt.view(off.rt.taskIds()[0]!)!.speed.rows[0]!.parts;
    expect(w["written"]! - w["proposed"]!).toBeGreaterThanOrEqual(395);
    expect(w["hold_until"]).toBeNull();
  });

  it("lever 2: a plain vitals line is decided by the first look alone; a finding, an unsure look or an invalid reply goes to the full clerking prompt", async () => {
    const { rt, port, client, root } = bootSpeed({ firstStage: true }, {
      first: (s) => (s.startsWith("Chart") ? { look: "chart", pulse: pulseOf(s), confidence: 0.97 } : s.startsWith("Tender") ? { look: "finding", confidence: 0.9 } : s.startsWith("Odd") ? { look: "chart", confidence: 0.2 } : { look: "unsure", confidence: 0.9 }),
      full: (s) => (s.startsWith("Odd") ? obs({ pulse: 90 }) : [{ class: "aside" }])
    });
    await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Chart his pulse 116." });
    await rt.settled();
    await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Tender in the right iliac fossa." });
    await rt.settled();
    await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Odd one, pulse 90." });
    await rt.settled();
    expect(client.seen.map((x) => [x.tool, x.said])).toEqual([
      ["first_look", "Chart his pulse 116."], ["first_look", "Tender in the right iliac fossa."], ["gate", "Tender in the right iliac fossa."], ["first_look", "Odd one, pulse 90."], ["gate", "Odd one, pulse 90."]
    ]);
    expect(port.writes.map((w) => w.args["pulse"])).toEqual([116, 90]);
    const decided = stream(root, rt).filter((e) => e.record_type === "gate.decided").map((e) => [(e.payload as { stage: string }).stage, (e.payload as { calls: number }).calls]);
    expect(decided).toEqual([["first", 1], ["first+full", 2], ["first+full", 2]]);
    const run = rt.task(rt.taskIds()[0]!)!.run_id;
    expect(ledgerRows(root, run).map((r) => [r.purpose, r.effort])).toEqual([["emr.gate.first", "low"], ["emr.gate.first", "low"], ["emr.gate", "low"], ["emr.gate.first", "low"], ["emr.gate", "low"]]);
    // Negative control: a first look that names a value nobody said is still dropped by the runtime's own rule.
    const made = bootSpeed({ firstStage: true }, { first: () => ({ look: "chart", pulse: 99, confidence: 0.99 }), full: () => [] });
    await made.rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Chart his pulse 116." });
    await made.rt.settled();
    expect(made.port.writes).toEqual([]);
  });

  it("lever 3: a slow proof read does not hold up the next line's decision, and a second read at 500 ms proves it", async () => {
    const { rt, port, client } = bootSpeed({ proofBeside: true }, {
      full: (s) => obs(/temperature/.test(s) ? { temp_c: "38.3" } : { pulse: pulseOf(s) }),
      prove: async (n, written) => { if (n === 1) { await sleep(2500); return null; } return { ...written, record_hash: "0".repeat(64), verified_at: new Date().toISOString(), read: "fake" }; }
    });
    await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Chart his pulse 116." });
    await sleep(50);
    const t0 = Date.now();
    await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Chart his temperature 38.3." });
    await sleep(100);
    expect(client.seen.find((x) => x.said.includes("38.3"))!.at - t0).toBeLessThan(100);
    await rt.settled();
    const v = rt.view(rt.taskIds()[0]!)!;
    expect(v.actions.map((a) => [a.state, a.reason, a.summary]), JSON.stringify(v.transcript.map((x) => [x.text, x.classes]))).toEqual([["completed", null, expect.any(String)], ["completed", null, expect.any(String)]]);
    expect(v.speed.rows[0]!.parts["verify_ms"]).toBeGreaterThanOrEqual(480);
    expect(v.speed.rows[0]!.parts["verify_ms"]).toBeLessThan(1500);
    expect(await hedgedRead(async () => null, 20)).toBeNull();
  });

  it("lever 4: the second ear starts when the line arrives, beside the gate, and differing readings still stop the write", async () => {
    const ear: { at: number }[] = [];
    const second = (text: string): SecondEar => async () => { ear.push({ at: Date.now() }); await sleep(100); return { text, provider: "modal", model: "m", response_id: null, cost_usd: 0.002, fallback_reason: null }; };
    const { rt, port, client } = bootSpeed({ earWithGate: true }, { full: (s) => obs({ pulse: pulseOf(s) }), ms: () => 200, second: second("Chart his pulse 116.") });
    await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Chart his pulse 116.", source: "audio", clip: chunkWav(1000, 700) });
    await rt.settled();
    expect(ear[0]!.at - client.seen[0]!.at).toBeLessThan(50);
    expect(port.writes.map((w) => w.args["pulse"])).toEqual([116]);
    expect(rt.view(rt.taskIds()[0]!)!.ears).toMatchObject({ compared: 1, agreed: 1 });

    const differ = bootSpeed({ earWithGate: true }, { full: (s) => obs({ pulse: pulseOf(s) }), second: second("Chart his pulse 118.") });
    await differ.rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Chart his pulse 116.", source: "audio", clip: chunkWav(1000, 700) });
    await differ.rt.settled();
    expect(differ.port.writes).toEqual([]);
    expect(differ.rt.view(differ.rt.taskIds()[0]!)!.actions.map((a) => a.reason)).toEqual(["readings_differ"]);

    // A line the gate does not act on keeps its early reading's cost on the task.
    const aside = bootSpeed({ earWithGate: true }, { full: () => [{ class: "conditional" }], second: second("If the pulse goes over 120, call me.") });
    await aside.rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "If the pulse goes over 120, call me.", source: "audio", clip: chunkWav(1000, 700) });
    await aside.rt.settled();
    const t = aside.rt.view(aside.rt.taskIds()[0]!)!;
    expect(aside.port.writes).toEqual([]);
    expect(t.usd).toBeGreaterThanOrEqual(0.002);
  });

  it("lever 5: lines with no measure in common are decided at once, a shared measure waits its turn, and actions keep the order spoken", async () => {
    const { rt, port, client } = bootSpeed({ parallelLines: 3 }, { full: (s) => obs(/temperature/.test(s) ? { temp_c: /(\d+\.\d)/.exec(s)![1] } : /rate/.test(s) ? { resp_rate: pulseOf(s) } : { pulse: pulseOf(s) }), ms: () => 200 });
    for (const text of ["Chart his pulse 116.", "Chart his temperature 38.3.", "Chart his respiratory rate 24.", "Chart his pulse 112."]) await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text });
    await sleep(80);
    const started = client.seen.map((x) => x.said);
    expect(started).toEqual(["Chart his pulse 116.", "Chart his temperature 38.3.", "Chart his respiratory rate 24."]);
    await rt.settled();
    const at = (s: string) => client.seen.find((x) => x.said === s)!.at;
    expect(at("Chart his pulse 112.") - at("Chart his pulse 116.")).toBeGreaterThanOrEqual(190);
    expect(port.writes.map((w) => w.args)).toEqual([
      { admission_id: ADMIT, pulse: 116 }, { admission_id: ADMIT, temp_c: "38.3" }, { admission_id: ADMIT, resp_rate: 24 }, { admission_id: ADMIT, pulse: 112 }
    ]);
    // The call made before its turn leaves the undecided lines out of its recent words.
    expect(client.seen.find((x) => x.said.includes("24"))!.user).not.toMatch(/38\.3/);
  });

  it("lever 6: a line that ends on a number is decided while it waits for the next chunk, and a number carried on is decided again as the joined line", async () => {
    const full = (s: string) => obs(/temperature/.test(s) ? { temp_c: /(\d+\.\d)/.exec(s)?.[1] } : { pulse: pulseOf(s) });
    const a = bootSpeed({ decideWhileJoining: true, parallelLines: 3 }, { full, ms: () => 150, numberMs: 400, transcripts: { 1700: "Chart his pulse 116." } });
    await a.rt.open(DOC, { admission_id: ADMIT });
    const t0 = Date.now();
    await a.chunk(0, chunkWav(1000, 700));
    await sleep(50);
    expect(a.client.seen.map((x) => x.said)).toEqual(["Chart his pulse 116."]);
    await sleep(500);
    await a.rt.settled();
    expect(a.port.writes.map((w) => w.args["pulse"])).toEqual([116]);
    expect(a.client.seen).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(900);

    const b = bootSpeed({ decideWhileJoining: true, parallelLines: 3 }, { full, numberMs: 2000, transcripts: { 1700: "Chart his temperature 37.", 1200: "point six.", 2900: "Chart his temperature 37.6." } });
    await b.rt.open(DOC, { admission_id: ADMIT });
    await b.chunk(0, chunkWav(1000, 700));
    await b.chunk(1, chunkWav(500, 700));
    await b.listen.flush("s1");
    await b.rt.settled();
    expect(b.client.seen.map((x) => x.said)).toEqual(["Chart his temperature 37.", "Chart his temperature 37.6."]);
    expect(b.port.writes.map((w) => w.args["temp_c"])).toEqual(["37.6"]);
    const v = b.rt.view(b.rt.taskIds()[0]!)!;
    expect(v.calls).toBe(2);
  });
});
