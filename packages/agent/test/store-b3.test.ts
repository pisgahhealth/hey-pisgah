import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunId } from "@hey-pisgah/contracts";
import { DaySpend, ModelClient, ModelError, type Budget, type DayCaps } from "@hey-pisgah/model";
import { configureSealing, listStreams, openStream, readStream } from "@hey-pisgah/store";
import { encodeWav } from "@hey-pisgah/voice";
import { EmrRuntime, type EmrTask } from "../src/emr/runtime.js";
import { SPEND_CAP_NOTE, arrivalRunId, modelFailNote, spendingTranscriber } from "../src/emr/spend.js";
import { finallyClosed, retainClosed } from "../src/emr/retention.js";
import { parallelReadings } from "../src/emr/listen.js";
import { startEmrServe } from "../src/emr/serve.js";
import { EMERGENCY_KIND } from "../src/emr/entry.js";
import { ADM, FakeEmr, OWNER, decider, emrRoot } from "./emr-helpers.js";

const KEY = "ab".repeat(32);
const PHRASE = "pulse 88 and the chest pain started at noon";
const caps = (o: Partial<DayCaps> = {}): DayCaps => ({ hospital: "general", usd: null, calls: null, alertFraction: 0.8, tz: "Africa/Lagos", reserveUsd: 0.01, ...o });
const budget = (day: DayCaps | null): Budget => ({ runUsd: 5, runMaxCalls: 200, weekUsd: 120, weekStopFraction: 0.8, weekSince: () => new Date(0), day });
const pulse = (said: string) => Number(/(\d+)/.exec(said)?.[1] ?? 0);

function boot(root: string, day: DayCaps | null = null, logs: string[] = []) {
  let rt: EmrRuntime | null = null;
  const port = new FakeEmr();
  const client = new ModelClient({ storeRoot: root, mode: "mock", budget: budget(day), spendLog: (l) => logs.push(l), mock: decider((said) => ({ decision: "record", pulse: pulse(said), summary: "Record" })), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1 });
  rt.start();
  return { rt, port, client };
}
const diskOf = (root: string) => listStreams(root, "emr").map((id) => readFileSync(join(root, `${id}.jsonl`), "utf8")).join("");

afterEach(() => configureSealing({ key: null }));

describe("sealed journal and retention at final closure", () => {
  it("keeps no heard words on disk, retains a proved closed task by digest and replays it after a restart with its label", async () => {
    configureSealing({ key: KEY });
    const root = emrRoot();
    const a = boot(root);
    const { task_id } = await a.rt.say({ owner: OWNER, target: { admission_id: ADM }, text: PHRASE });
    await a.rt.settled();
    expect(a.rt.task(task_id)!.state).toBe("done");
    expect(finallyClosed(a.rt.task(task_id)!)).toBe(true);
    const disk = diskOf(root);
    expect(disk).not.toContain("chest pain");
    expect(disk).not.toContain("Test Patient");
    expect(disk).toContain("store.retained");
    expect(disk).toContain(a.port.writes[0]!.id);
    await a.rt.stop();
    a.client.close();
    const b = boot(root);
    const t = b.rt.task(task_id)!;
    expect(t.label).toBe("Test Patient");
    expect(t.lines[0]!.text).toBe("");
    expect(t.lines[0]!.id).toBeTruthy();
    expect([...t.actions.values()][0]!.written?.record_id).toBe(a.port.writes[0]!.id);
    await b.rt.stop();
    b.client.close();
  });

  it("is not final closure while a question or an obligation is open or the task is not done", async () => {
    configureSealing({ key: KEY });
    const root = emrRoot();
    const a = boot(root);
    const { task_id } = await a.rt.say({ owner: OWNER, target: { admission_id: ADM }, text: PHRASE });
    await a.rt.settled();
    const t = a.rt.task(task_id)!;
    expect(finallyClosed({ ...t, questions: [{ question_id: "q-1", text: "Which?", line_id: "l", answered_by: null, at: "", choice: null, rule: null, pref_id: null, offer: null }] })).toBe(false);
    expect(finallyClosed({ ...t, obligations: [{ obligation_id: "o-1", state: "held" } as EmrTask["obligations"][number]] })).toBe(false);
    expect(finallyClosed({ ...t, state: "waiting" })).toBe(false);
    await a.rt.stop();
    a.client.close();
  });
});

describe("day spend caps", () => {
  it("reservations stop concurrent calls before they overshoot, and a restart keeps the day's total", () => {
    const root = emrRoot();
    const logs: string[] = [];
    const s = new DaySpend(root, caps({ usd: 0.05 }), () => new Date("2026-11-01T10:00:00Z"), (l) => logs.push(l));
    const h1 = s.reserve("model", 0.02);
    const h2 = s.reserve("model", 0.02);
    expect(() => s.reserve("model", 0.02)).toThrow(ModelError);
    h1.settle(0.02);
    h2.release();
    expect(s.status()).toMatchObject({ usd: 0.02, calls: 1, reserved_usd: 0, capped: ["day_usd"] });
    s.close();
    const again = new DaySpend(root, caps({ usd: 0.05 }), () => new Date("2026-11-01T11:00:00Z"), (l) => logs.push(l));
    expect(again.status()).toMatchObject({ usd: 0.02, calls: 1, capped: ["day_usd"] });
    again.close();
    const tomorrow = new DaySpend(root, caps({ usd: 0.05 }), () => new Date("2026-11-02T10:00:00Z"));
    expect(tomorrow.status()).toMatchObject({ day: "2026-11-02", usd: 0 });
    tomorrow.close();
    expect(logs.some((l) => l.startsWith("spend cap reached"))).toBe(true);
  });

  it("counts a cost it cannot refuse, alerts at 80% and notes the cap", () => {
    const root = emrRoot();
    const logs: string[] = [];
    const s = new DaySpend(root, caps({ usd: 1 }), () => new Date("2026-11-01T10:00:00Z"), (l) => logs.push(l));
    s.charge("reading", 0.85, { purpose: "interpret_speech" });
    expect(s.status().alerted).toEqual(["day_usd"]);
    s.charge("reading", 0.3);
    expect(s.status()).toMatchObject({ capped: ["day_usd"] });
    s.close();
    const notes = readStream(root, "spend/general-2026-11-01").map((e) => e.record_type);
    expect(notes.filter((t) => t === "spend.alert")).toHaveLength(1);
    expect(notes.filter((t) => t === "spend.capped")).toHaveLength(1);
    expect(logs[0]).toMatch(/^spend alert/);
  });

  it("refuses the model call at the cap with a ledger refusal and tells the clinician the cap stopped the decision", async () => {
    const root = emrRoot();
    const logs: string[] = [];
    const a = boot(root, caps({ calls: 1 }), logs);
    const first = await a.rt.say({ owner: OWNER, target: { admission_id: ADM }, text: "pulse 80" });
    await a.rt.settled();
    expect(a.port.writes).toHaveLength(1);
    await a.rt.say({ owner: OWNER, target: { admission_id: ADM }, text: "pulse 90" });
    await a.rt.settled();
    expect(a.port.writes).toHaveLength(1);
    const t = a.rt.task(first.task_id)!;
    expect(t.notes.at(-1)!.text).toBe(modelFailNote("budget_exhausted"));
    expect(t.notes.at(-1)!.text).toMatch(/spending limit for today/);
    const refused = readStream(root, `ledger/${t.run_id}`).filter((e) => e.record_type === "model.refused");
    expect(refused.at(-1)!.payload).toMatchObject({ reason: "budget_exhausted", scope: "day_calls" });
    expect(logs.some((l) => /spend cap reached/.test(l))).toBe(true);
    await a.rt.stop();
    a.client.close();
  });

  it("a speech clip holds its cost before the call and is refused at the cap", async () => {
    const root = emrRoot();
    const s = new DaySpend(root, caps({ usd: 0.0001 }), () => new Date("2026-11-01T10:00:00Z"), () => undefined);
    let calls = 0;
    const t = spendingTranscriber(async () => { calls += 1; return { final: true, text: "x", audio_ms: 1000, session_id: "s", cost_usd: 0.00005 }; }, s);
    const sec = encodeWav(new Float32Array(16_000), 16_000);
    await t(sec, [], "s");
    expect(s.status()).toMatchObject({ speech_ms: 1000, usd: 0.00005 });
    await expect(t(encodeWav(new Float32Array(16_000 * 60), 16_000), [], "s")).rejects.toThrow(/budget_exhausted/);
    expect(calls).toBe(1);
    s.close();
  });

  it("gives each owner a new arrival run id each hospital day", () => {
    const d1 = arrivalRunId(OWNER, new Date("2026-11-01T22:30:00Z"));
    const d2 = arrivalRunId(OWNER, new Date("2026-11-01T23:30:00Z"));
    expect(RunId.safeParse(d1).success).toBe(true);
    expect(d1).not.toBe(d2);
    expect(arrivalRunId(OWNER, new Date("2026-11-01T08:00:00Z"))).toBe(d1);
  });
});

describe("review fixes", () => {
  it("is not final closure while a line is undecided, and nothing is retained while a decision is in flight", async () => {
    configureSealing({ key: KEY });
    const root = emrRoot();
    const a = boot(root);
    const { task_id } = await a.rt.say({ owner: OWNER, target: { admission_id: ADM }, text: PHRASE });
    await a.rt.settled();
    const t = a.rt.task(task_id)!;
    expect(finallyClosed({ ...t, lines: [...t.lines, { ...t.lines[0]!, id: "l-late", decided: false }] })).toBe(false);
    await a.rt.stop();
    a.client.close();
    const root2 = emrRoot();
    const b = boot(root2);
    const r = await b.rt.say({ owner: OWNER, target: { admission_id: ADM }, text: PHRASE });
    await b.rt.settled();
    const s2 = openStream(root2, "emr/x-b3", { writer: true });
    s2.append("utterance.heard", { line_id: "l-1", text: PHRASE }, { recorded_at: 0, occurred_at: 0 });
    expect(retainClosed(s2, b.rt.task(r.task_id)!, undefined, true)).toBe(0);
    expect(retainClosed(s2, b.rt.task(r.task_id)!)).toBe(1);
    s2.close();
    await b.rt.stop();
    b.client.close();
  });

  it("reserves a conservative input plus bounded output cost per call, not a fixed floor", () => {
    const root = emrRoot();
    const c = new ModelClient({ storeRoot: root, mode: "mock", budget: budget(caps({ usd: 1, reserveUsd: 0.001 })) });
    const args = { provider: "modal", model: "m", effort: "low", messages: [], purpose: "p", run_id: null, task_id: null, task_state: null, thread: "main", affinity_key: null } as never;
    const small = c.reserveFor(args, { messages: [{ role: "user", content: "hi" }] });
    const big = c.reserveFor(args, { messages: [{ role: "user", content: "x".repeat(300_000) }] });
    expect(small).toBeGreaterThan(0.015);
    expect(big).toBeGreaterThan(small + 0.1);
    expect(c.reserveFor({ ...(args as object), max_completion_tokens: 100 } as never, { messages: [] })).toBeLessThan(0.01);
    c.close();
  });

  it("parallel readings over a billed transcriber reserve and settle once per reading", async () => {
    const root = emrRoot();
    const s = new DaySpend(root, caps({ usd: 1 }), () => new Date("2026-11-01T10:00:00Z"), () => undefined);
    let inFlight = 0;
    const seen: number[] = [];
    const t = spendingTranscriber(async (_w, _k, sid) => { seen.push(s.status().reserved_usd); inFlight += 1; return { final: true, text: "x", audio_ms: 1000, session_id: sid, cost_usd: 0.00005 }; }, s);
    await parallelReadings(t, 3)(encodeWav(new Float32Array(16_000), 16_000), [], "s");
    expect(inFlight).toBe(3);
    expect(s.status()).toMatchObject({ speech_ms: 3000, reserved_usd: 0 });
    expect(Math.max(...seen)).toBeGreaterThan(0.00009);
    s.close();
  });

  it("a typed arrival refused by the cap answers with the spending-limit note, never as no arrival", async () => {
    const root = emrRoot();
    const port = Object.assign(new FakeEmr(), { kindsFor: () => [EMERGENCY_KIND] });
    const client = new ModelClient({ storeRoot: root, mode: "mock", budget: budget(caps({ calls: 0 })), spendLog: () => undefined, mock: decider(() => ({ decision: "aside", summary: "x" })) });
    const s = await startEmrServe({ strip: { mode: "open" }, storeRoot: root, port, client, listenPort: 0, runtime: { holdMs: 0, proofRetryMs: 1 }, ears: "off" });
    const r = await fetch(`${s.url}/tasks/say`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3311" }, body: JSON.stringify({ owner: OWNER, text: "A man has just come in with chest pain." }) });
    expect(r.status).toBe(429);
    expect(((await r.json()) as { error: string }).error).toBe(SPEND_CAP_NOTE);
    await s.close();
    client.close();
  });
});
