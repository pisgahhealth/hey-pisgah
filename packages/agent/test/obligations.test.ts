import { describe, expect, it } from "vitest";
import { readStream } from "@hey-pisgah/store";
import { afterSaid, minutesSaid } from "../src/emr/work.js";
import { percentile } from "../src/emr/runtime.js";
import type { OrderResult, Orderables } from "../src/emr/port.js";
import { ADMIT, ClerkFake, DOC, PAT, clerkBoot, ins } from "./clerking-helpers.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FBC_ORDER = "ffffffff-1111-4222-8333-444444444444";
// The clerking hospital with one blood count already on the visit, read by its id with its result state.
class ResultFake extends ClerkFake {
  fbc = "SENT";
  orderables(): Orderables { return { tests: { fbc: ["full blood count", "blood count"] }, drugs: {} }; }
  resultStates(): readonly string[] { return ["resulted"]; }
  async orderResults(): Promise<OrderResult[]> { return [{ id: FBC_ORDER, test: "fbc", state: this.fbc }]; }
}
const fired = (root: string, taskId: string) => readStream(root, `emr/${taskId}`).filter((e) => e.record_type === "obligation.fired");

describe("obligations held for a time or a condition", () => {
  it("reads the time and the condition from the words, never from the model", () => {
    expect(minutesSaid("Review him again in one hour.")).toBe(60);
    expect(minutesSaid("in 30 minutes please")).toBe(30);
    expect(minutesSaid("in half an hour")).toBe(30);
    expect(minutesSaid("review him soon")).toBeNull();
    expect(afterSaid("admission", "once he is admitted, start four hourly obs")).toBe(true);
    expect(afterSaid("result", "when the blood count comes back, tell me")).toBe(true);
    expect(afterSaid("result", "start four hourly obs")).toBe(false);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4, 6, 7, 8, 9, 10], 90)).toBe(9);
  });

  it("holds a review for one hour, puts it on the ward board at once, and fires exactly once after a restart", async () => {
    const clock = { now: Date.now() };
    const port = new ClerkFake();
    port.admitted = true;
    const a = clerkBoot(() => [ins("schedule_review", { title: "review his abdomen", in_minutes: 60 })], { port, clock });
    const said = await a.rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Review his abdomen again in one hour." });
    await a.rt.settled();
    const v1 = a.rt.view(said.task_id)!;
    expect(v1.obligations).toMatchObject([{ kind: "schedule_review", state: "held", due_at: new Date(Date.parse(v1.obligations[0]!.held_at) - Date.parse(v1.obligations[0]!.held_at) + clock.now + 3_600_000).toISOString() }]);
    expect(port.writes.map((w) => w.kind)).toEqual(["schedule_review"]);
    expect(port.writes[0]!.args).toMatchObject({ admission_id: ADMIT, title: "review his abdomen", due_at: v1.obligations[0]!.due_at });
    await a.rt.stop();

    // Time passes while nothing runs; a new runtime on the same store fires it from its own timer.
    clock.now += 61 * 60_000;
    const b = clerkBoot(() => [], { root: a.root, port, clock });
    await wait(200);
    await b.rt.settled();
    const v2 = b.rt.view(said.task_id)!;
    expect(v2.obligations[0]).toMatchObject({ state: "done", fired_by: "timer" });
    expect(v2.notes.at(-1)?.text).toBe("Review due now: review his abdomen. It is on the ward board.");
    expect(v2.notes.at(-1)?.kind).toBe("info");
    expect(v1.notes.find((n) => n.text.startsWith("Held"))?.kind).toBe("hold");
    expect(fired(a.root, said.task_id)).toHaveLength(1);
    await b.rt.stop();

    // Negative control: another restart later does not fire it again or write the board item twice.
    clock.now += 60 * 60_000;
    const c = clerkBoot(() => [], { root: a.root, port, clock });
    await wait(200);
    await c.rt.settled();
    expect(fired(a.root, said.task_id)).toHaveLength(1);
    expect(port.writes.map((w) => w.kind)).toEqual(["schedule_review"]);
    await c.rt.stop();
  });

  it("holds work until the admission exists and does it then, even across a restart", async () => {
    const clock = { now: Date.now() };
    const port = new ClerkFake();
    const a = clerkBoot(() => [ins("add_care_plan_item", { title: "observations", item_kind: "observation", cadence: "q4h", after: "admission" })], { port, clock });
    const said = await a.rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Once he is admitted, start four hourly observations." });
    await a.rt.settled();
    expect(a.rt.view(said.task_id)!.obligations).toMatchObject([{ kind: "add_care_plan_item", after: "admission", state: "held" }]);
    expect(port.writes).toEqual([]);
    await a.rt.stop();
    a.client.close();
    const b = clerkBoot((s) => (s.startsWith("Admit") ? [ins("admit_patient", { ward: "a_and_e", admission_type: "emergency", text: "observation" })] : []), { root: a.root, port, clock });
    await b.rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Admit him as an emergency to A and E for observation." });
    await b.rt.settled();
    for (let i = 0; i < 100 && !port.writes.some((w) => w.kind === "add_care_plan_item"); i++) await wait(20);
    await b.rt.settled();
    expect(port.writes.map((w) => w.kind)).toEqual(["admit_patient", "add_care_plan_item"]);
    expect(port.writes[1]!.args).toEqual({ admission_id: ADMIT, title: "observations", item_kind: "observation", cadence: "q4h" });
    const v = b.rt.view(said.task_id)!;
    expect(v.obligations[0]).toMatchObject({ state: "done", fired_by: "condition" });
    // The held work cites the line that asked for it, so its provenance is that line.
    expect(port.writes[1]!.prov.evidence).toBe(`transcript:${said.line_id}`);
    await b.rt.stop();
  });

  it("holds work until a result comes back, watching the record with no model call", async () => {
    const clock = { now: Date.now() };
    const port = new ResultFake();
    port.admitted = true;
    let calls = 0;
    const a = clerkBoot(() => { calls += 1; return [ins("record_note", { note_type: "progress", text: "blood count back, reviewed", after: "result" })]; }, { port, clock, watchMs: 20 });
    const said = await a.rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "When the blood count comes back, write a progress note: blood count back, reviewed." });
    await a.rt.settled();
    await wait(100);
    expect(port.writes).toEqual([]);
    // The work waits on the visit's blood count by its id; the screen's test list changing alone fires nothing.
    expect(a.rt.view(said.task_id)!.obligations[0]).toMatchObject({ condition: { orders: [FBC_ORDER], tests: ["fbc"] } });
    port.tests = '[{"name":"FBC","status":"resulted"}]';
    await wait(100);
    expect(port.writes).toEqual([]);
    port.fbc = "resulted";
    for (let i = 0; i < 100 && !port.writes.length; i++) await wait(20);
    await a.rt.settled();
    expect(port.writes.map((w) => w.kind)).toEqual(["record_note"]);
    expect(calls).toBe(1);
    expect(a.rt.view(said.task_id)!.obligations[0]).toMatchObject({ state: "done", fired_by: "condition" });
    await a.rt.stop();
  });

  it("logs the speed of every verified action from the end of its words, with errors beside it", async () => {
    const port = new ClerkFake();
    port.admitted = true;
    const a = clerkBoot(() => [ins("record_observation", { pulse: 104 })], { port });
    const said = await a.rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Chart pulse 104." });
    await a.rt.settled();
    const v = a.rt.view(said.task_id)!;
    expect(v.speed.rows).toHaveLength(1);
    expect(v.speed.rows[0]).toMatchObject({ kind: "record_observation", line_id: said.line_id });
    expect(v.speed.rows[0]!.ms).toBeGreaterThanOrEqual(0);
    expect(v.speed.by_kind["record_observation"]).toMatchObject({ n: 1 });
    expect(v.speed.errors).toEqual({ failed: 0, refused: 0, unverified: 0 });
    await a.rt.stop();
  });
});
