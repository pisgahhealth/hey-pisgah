import { describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import { wholeInRange } from "@hey-pisgah/voice";
import { ListenSessions } from "../src/emr/listen.js";
import { EmrRuntime, releasable } from "../src/emr/runtime.js";
import { KEPT_LEVERS, leversFrom } from "../src/emr/speed.js";
import { ADM, FakeEmr, OWNER, emrRoot, gater, until } from "./emr-helpers.js";
import { chunkWav, earOf, obs, say, secondOf } from "./mic-helpers.js";

const HOLD = 2000, WAIT = 1500;
// The gate as a script: the pulse, resp rate or temperature said becomes one observation.
const gate = (said: string) => {
  const p = /pulse (\d+)/.exec(said), r = /rate (\d+)/.exec(said), t = /temperature (\d+\.\d)/.exec(said);
  return p ? obs(said, { pulse: Number(p[1]) }) : r ? obs(said, { resp_rate: Number(r[1]) }) : t ? obs(said, { temp_c: t[1] }) : [{ class: "aside" as const }];
};

function boot(first: Record<number, string>, second: Record<number, string>, release = true, levers = false) {
  const root = emrRoot();
  const port = new FakeEmr();
  let rt: EmrRuntime | null = null;
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater(gate), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: HOLD, proofRetryMs: 1, secondEar: secondOf(second), ...(release ? { releaseWhole: true } : {}), ...(levers ? { speed: leversFrom(KEPT_LEVERS) } : {}) });
  rt.start();
  const listen = new ListenSessions(rt, { transcribe: earOf(first), numberJoinWaitMs: WAIT, strongJoinWaitMs: 5000, ...(release ? { releaseWhole: true } : {}) });
  const settle = async () => { await listen.flush("s1"); await rt!.settled(); };
  return { rt, port, listen, settle };
}

// A model client whose gate call for a respiratory line answers late, so an earlier line's write finishes while that call is out.
class SlowRateGate extends ModelClient {
  override async call(a: Parameters<ModelClient["call"]>[0]): ReturnType<ModelClient["call"]> {
    if (JSON.stringify(a.messages).includes("rate 22")) await new Promise((r) => setTimeout(r, 400));
    return super.call(a);
  }
}

describe("a line decided while the task went idle", () => {
  it("is still acted on when an earlier line's write finished during its gate call", async () => {
    const root = emrRoot();
    const port = new FakeEmr();
    let rt: EmrRuntime | null = null;
    const client = new SlowRateGate({ storeRoot: root, mode: "mock", mock: gater(gate), taskStateOf: (id) => rt?.stateOf(id) ?? null });
    rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1, speed: leversFrom(KEPT_LEVERS) });
    rt.start();
    await rt.say({ owner: OWNER, target: { admission_id: ADM }, text: "Chart the pulse 80", source: "audio", ambient: { session_id: "s1", seqs: [0], raw_text: "", ended_at: new Date().toISOString(), final_at: new Date().toISOString(), trailing_silence_ms: 700, finished_by: "quiet_tail" } });
    await rt.say({ owner: OWNER, target: { admission_id: ADM }, text: "Chart the respiratory rate 22", source: "audio", ambient: { session_id: "s1", seqs: [1], raw_text: "", ended_at: new Date().toISOString(), final_at: new Date().toISOString(), trailing_silence_ms: 700, finished_by: "quiet_tail" } });
    await rt.settled();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 80 }, { admission_id: ADM, resp_rate: 22 }]);
  });
});

describe("D17: which values are released", () => {
  it("takes whole numbers in range and leaves decimals, temperatures and out-of-range values to wait", () => {
    expect(wholeInRange("pulse 80")).toBe(true);
    expect(wholeInRange("resp rate 22")).toBe(true);
    expect(wholeInRange("sats 91")).toBe(true);
    expect(wholeInRange("BP 120 over 80")).toBe(true);
    expect(wholeInRange("temperature 37")).toBe(false);
    expect(wholeInRange("pulse 8.5")).toBe(false);
    expect(wholeInRange("resp rate 70")).toBe(false);
    expect(wholeInRange("pulse 25")).toBe(false);
    expect(wholeInRange("Emeka hand me 20 gloves")).toBe(false);
    expect(releasable({ admission_id: ADM, pulse: 80 })).toBe(true);
    expect(releasable({ admission_id: ADM, pulse: 80, temp_c: "37.2" })).toBe(false);
  });
});

describe("D17: a whole-number vital is written at once", () => {
  it("writes the pulse before the number wait or the hold would have ended, once the second reading agrees", async () => {
    const { rt, port, listen, settle } = boot({ 2200: "Chart the pulse eighty" }, { 2200: "pulse 80" });
    const t0 = Date.now();
    await say(listen, 0, chunkWav(1500, 700));
    await until(() => port.writes.length > 0, 5000);
    expect(Date.now() - t0).toBeLessThan(WAIT);
    await settle();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 80 }]);
    const v = rt.views(OWNER)[0]!;
    expect(v.speed.rows[0]).toMatchObject({ released: true });
    expect(v.speed.corrections).toBe(0);
  });

  it("with the serve's kept speed levers on, writes the released pulse and settles", async () => {
    const { port, listen, settle } = boot({ 2200: "Chart the pulse eighty", 3000: "Chart the temperature 37.6" }, { 2200: "pulse 80", 3000: "temperature 37.6" }, true, true);
    await say(listen, 0, chunkWav(1500, 700));
    await say(listen, 1, chunkWav(2300, 700));
    await settle();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 80 }, { admission_id: ADM, temp_c: "37.6" }]);
  });

  it("still holds a temperature, which carries a decimal", async () => {
    const { port, listen, settle } = boot({ 2200: "Chart the temperature 37.6" }, { 2200: "temperature 37.6" });
    const t0 = Date.now();
    await say(listen, 0, chunkWav(1500, 700));
    await settle();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, temp_c: "37.6" }]);
    // The hold ran in full; the test's flush ends the number wait early, so only the hold is timed here.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(HOLD - 100);
  });

  it("still holds a value outside the ward range", async () => {
    const { port, listen, settle, rt } = boot({ 2200: "Chart the resp rate seventy" }, { 2200: "resp rate 70" });
    await say(listen, 0, chunkWav(1500, 700));
    await settle();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, resp_rate: 70 }]);
    expect(rt.views(OWNER)[0]!.speed.rows[0]!.released).toBeUndefined();
  });

  it("amends the written pulse once when the number carries on inside the old window, with no second plain entry", async () => {
    const { rt, port, listen, settle } = boot({ 2200: "Chart the pulse eighty", 1100: "two", 3300: "Chart the pulse eighty two" }, { 2200: "pulse 80", 3300: "pulse 82" });
    await say(listen, 0, chunkWav(1500, 700));
    await until(() => port.writes.length === 1, 5000);
    await say(listen, 1, chunkWav(400, 700));
    await settle();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 80 }, { admission_id: ADM, pulse: 82, corrects_record_id: "obs-1" }]);
    const v = rt.views(OWNER)[0]!;
    expect(v.actions.map((a) => [a.state, a.corrects_action_id !== null])).toEqual([["completed", false], ["completed", true]]);
    expect(v.speed.corrections).toBe(1);
    expect(v.speed.rows[1]).toMatchObject({ amends: v.actions[0]!.action_id });
  });

  it("asks rather than writes when the second reading does not agree", async () => {
    const { rt, port, listen, settle } = boot({ 2200: "Chart the pulse eighty" }, { 2200: "pulse 90" });
    await say(listen, 0, chunkWav(1500, 700));
    await settle();
    expect(port.writes).toEqual([]);
    expect(rt.views(OWNER)[0]!.questions[0]!.text).toBe("Pulse: one reading heard 80, the other 90. Say 80 or 90.");
  });

  it("is off unless switched on: the same pulse waits for the number and the hold", async () => {
    const { port, listen, settle } = boot({ 2200: "Chart the pulse eighty" }, { 2200: "pulse 80" }, false);
    const t0 = Date.now();
    await say(listen, 0, chunkWav(1500, 700));
    await settle();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 80 }]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(HOLD - 100);
  });
});
