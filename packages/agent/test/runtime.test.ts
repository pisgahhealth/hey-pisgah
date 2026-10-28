import { describe, expect, it } from "vitest";
import { ModelError } from "@hey-pisgah/model";
import { worldRules } from "@hey-pisgah/hospital";
import { readStream } from "@hey-pisgah/store";
import { callsWhileWaiting } from "../src/checks.js";
import { scriptedAgent } from "../src/mock.js";
import { HospitalPort } from "../src/port.js";
import { TaskWriter, TickConflict, guardCompletion, project } from "../src/task.js";
import { GOAL, OWNER, baseCase, harness, ofType, r2, registry, taskRecords, tempRoot, variant } from "./helpers.js";

describe("agent runtime on the v1 case (mock model)", () => {
  it("pauses when the task's own call budget runs out, and a person can lift the pause", async () => {
    const root = tempRoot();
    const h = harness(root);
    h.rt.start();
    const id = h.rt.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER, budget: { max_calls: 3, max_usd: 1 } });
    await h.rt.settled();
    expect(h.rt.projection(id).state).toBe("paused");
    expect(h.rt.projection(id).reason).toBe("task_budget_exhausted");
    expect(h.rt.projection(id).counts.model_calls).toBe(3);
    await h.close();
  });

  it("finishes done with a fresh-read proof for every runtime-derived condition", async () => {
    const root = tempRoot();
    const h = harness(root, { mock: scriptedAgent({ notify: true }) });
    h.rt.start();
    const id = h.rt.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER });
    await h.rt.settled();
    const s = h.rt.status(id) as { state: string; conditions: { condition_id: string; met: boolean }[]; closed: { effect_set_hash: string; metrics: { terminal_state: string } } };
    expect(s.state).toBe("done");
    expect(s.conditions.map((c) => c.condition_id)).toEqual(["discharge_summary.draft", "discharge_summary.final", "refund_voucher.draft", "refund_voucher.final"]);
    expect(s.conditions.every((c) => c.met)).toBe(true);
    expect(s.closed.effect_set_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.closed.metrics.terminal_state).toBe("departed");
    const p = project(taskRecords(root, id));
    for (const a of p.actions.values()) {
      expect(a.state).toBe("completed");
      expect(a.proof!.intent_key).toBe(a.intent_key);
      expect(a.proof!.produced_event_ids.length).toBeGreaterThan(0);
    }
    expect(ofType(root, id, "acceptance.derived").length).toBeGreaterThan(0);
    await h.close();
  });

  it("makes zero model calls while waiting, across a full run", async () => {
    const root = tempRoot();
    const h = harness(root);
    h.rt.start();
    const id = h.rt.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER });
    await h.rt.settled();
    const p = h.rt.projection(id);
    expect(ofType(root, id, "task.resumed").length).toBeGreaterThan(3);
    expect(callsWhileWaiting(root, id, p.run_id)).toEqual([]);
    const rows = readStream(root, `ledger/${p.run_id}`).filter((e) => e.record_type === "model.call");
    expect(rows.length).toBe(p.counts.model_calls);
    await h.close();
  });

  it("negative control: one call forced during waiting is refused by the gate and turns the check red", async () => {
    const root = tempRoot();
    const h = harness(root, { runtime: { clock: "manual" } });
    h.rt.start();
    const id = h.rt.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER });
    await h.rt.settled(20_000, { orWaiting: true });
    const p = h.rt.projection(id);
    expect(p.state).toBe("waiting");
    expect(callsWhileWaiting(root, id, p.run_id)).toEqual([]);
    const args = { provider: "modal" as const, model: h.rt.model, effort: "low" as const, messages: [{ role: "user" as const, content: "status?" }], purpose: "forced", run_id: p.run_id, task_id: id, task_state: "running" as const, affinity_key: null };
    await expect(h.client.call({ ...args, thread: "main" })).rejects.toBeInstanceOf(ModelError);
    expect(callsWhileWaiting(root, id, p.run_id).length).toBe(1);
    await h.client.call({ ...args, thread: "side" });
    expect(callsWhileWaiting(root, id, p.run_id).length).toBe(2);
    await h.close();
  });

  it("answers status from the projection with no model call", async () => {
    const root = tempRoot();
    const h = harness(root, { runtime: { clock: "manual" } });
    h.rt.start();
    const id = h.rt.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER });
    await h.rt.settled(20_000, { orWaiting: true });
    const before = h.bodies.length;
    const ledger = readStream(root, `ledger/${h.rt.projection(id).run_id}`).length;
    for (let i = 0; i < 5; i++) expect((h.rt.status(id) as { state: string }).state).toBe("waiting");
    expect(h.bodies.length).toBe(before);
    expect(readStream(root, `ledger/${h.rt.projection(id).run_id}`).length).toBe(ledger);
    await h.close();
  });

  it("refuses completed without a proof, and counts every refused attempt", async () => {
    const root = tempRoot();
    const h = harness(root, { mock: scriptedAgent({ liar: true }) });
    h.rt.start();
    const id = h.rt.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER });
    await h.rt.settled();
    const refusedTask = ofType(root, id, "completion.attempt_refused");
    expect(refusedTask.length).toBe(1);
    expect((refusedTask[0]!.payload as { target: string; unmet: string[] }).unmet.length).toBe(4);
    const live = (h.rt as unknown as { tasks: Map<string, { stream: import("@hey-pisgah/store").Stream }> }).tasks.get(id)!;
    const w = new TaskWriter(live.stream, project(live.stream.records()));
    const a = [...w.proj.actions.values()][0]!;
    expect(h.rt.complete(w, a, null, 0)).toBe(false);
    expect(h.rt.complete(w, a, { ...a.proof!, intent_key: "0".repeat(64) }, 0)).toBe(false);
    expect(h.rt.complete(w, a, { not: "a proof" }, 0)).toBe(false);
    expect(w.proj.counts.completion_refused).toBe(4);
    expect(guardCompletion({ intent_key: a.intent_key, written: null }, a.proof)).toEqual({ ok: false, reason: "not_written" });
    expect(h.rt.projection(id).state).toBe("done");
    await h.close();
  });

  it("ends needs_input listing the one unmet condition", async () => {
    const root = tempRoot();
    const h = harness(root, { mock: scriptedAgent({ skip: ["refund_voucher.final"] }) });
    h.rt.start();
    const id = h.rt.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER });
    await h.rt.settled();
    const p = h.rt.projection(id);
    expect(p.state).toBe("needs_input");
    expect(p.unmet).toEqual(["refund_voucher.final"]);
    expect(p.reason).toBe("work_left_undone");
    expect(ofType(root, id, "tick.started").some((e) => (e.payload as { reason: { kind: string } }).reason.kind === "nudge")).toBe(true);
    await h.close();
  });

  it("times out at the horizon with a timeout fact when an awaited event never comes, then needs_input", async () => {
    const root = tempRoot();
    const c = variant("c-agent002", (w) => { w.schedule.steps["st05"] = { ...w.schedule.steps["st05"]!, due: "never" }; });
    const h = harness(root, { cases: [c] });
    h.rt.start();
    const id = h.rt.openTask({ case_id: c.case_id, goal: GOAL, owner: OWNER });
    await h.rt.settled();
    const p = h.rt.projection(id);
    expect(p.state).toBe("needs_input");
    expect(p.reason).toBe("horizon_reached");
    const resumed = ofType(root, id, "task.resumed").map((e) => (e.payload as { trigger: string }).trigger);
    expect(resumed.at(-1)).toBe("timeout");
    const lastTick = ofType(root, id, "tick.started").at(-1)!.payload as { user: string };
    expect(lastTick.user).toMatch(/reached its deadline .* the awaited event has not been recorded/);
    await h.close();
  });

  it("wait_until must carry a deadline, and a model wake times out with a timeout fact", async () => {
    const root = tempRoot();
    const h = harness(root, { mock: scriptedAgent({ waitMinutes: 30 }) });
    h.rt.start();
    const id = h.rt.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER, budget: { max_calls: 200, max_usd: 1 } });
    await h.rt.settled();
    const wakes = ofType(root, id, "wake.registered").map((e) => (e.payload as { wake: { registered_by: string; deadline_simulated_min: number | null } }).wake);
    const model = wakes.filter((w) => w.registered_by === "model");
    expect(model.length).toBeGreaterThan(0);
    expect(model.every((w) => w.deadline_simulated_min !== null)).toBe(true);
    expect(ofType(root, id, "task.resumed").some((e) => (e.payload as { trigger: string }).trigger === "timeout")).toBe(true);
    expect(h.rt.projection(id).state).toBe("done");
    const { ARGS } = await import("../src/schemas.js");
    expect(ARGS.wait_until.safeParse({ step_id: "st05" }).success).toBe(false);
    await h.close();
  });

  it("an always-on requirements wake resumes a waiting task when the ward requirements change", async () => {
    const root = tempRoot();
    const c = variant("c-agent003", (w) => { w.requirements.push({ at: 700, set: r2() }); });
    const h = harness(root, { cases: [c] });
    h.rt.start();
    const id = h.rt.openTask({ case_id: c.case_id, goal: GOAL, owner: OWNER });
    await h.rt.settled();
    const wakes = ofType(root, id, "wake.registered").map((e) => (e.payload as { wake: { wake_id: string; predicate: unknown } }).wake);
    const reqWakes = new Set(wakes.filter((w) => JSON.stringify(w.predicate) === JSON.stringify({ on: "requirements.changed" })).map((w) => w.wake_id));
    const at700 = ofType(root, id, "task.resumed").find((e) => e.recorded_at === 700);
    expect(at700).toBeDefined();
    expect(reqWakes.has((at700!.payload as { wake_id: string }).wake_id)).toBe(true);
    expect(h.rt.projection(id).state).toBe("done");
    await h.close();
  });

  it("refuses a second task.resumed for one wake", async () => {
    const root = tempRoot();
    const h = harness(root, { runtime: { clock: "manual" } });
    h.rt.start();
    const id = h.rt.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER });
    await h.rt.settled(20_000, { orWaiting: true });
    const wake = h.rt.projection(id).wakes.find((w) => w.consumed_by === null)!;
    await h.rt.stop();
    const h2 = harness(root, { runtime: { clock: "manual" } });
    h2.rt.start();
    expect(h2.rt.appendResumed(id, { wake_id: wake.wake_id, trigger: "ev-00000000" })).toBe(true);
    expect(h2.rt.appendResumed(id, { wake_id: wake.wake_id, trigger: "ev-00000000" })).toBe(false);
    expect(h2.rt.refusedResumeCount()).toBe(1);
    expect(ofType(root, id, "task.resumed").length).toBe(1);
    await h2.close();
    h.client.close();
  });

  it("a tick commits only while the stream head is where it started", async () => {
    const root = tempRoot();
    const h = harness(root, { runtime: { clock: "manual" } });
    h.rt.start();
    const id = h.rt.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER });
    await h.rt.settled(20_000, { orWaiting: true });
    const live = (h.rt as unknown as { tasks: Map<string, { stream: import("@hey-pisgah/store").Stream }> }).tasks.get(id)!;
    const a = new TaskWriter(live.stream, project(live.stream.records()));
    const b = new TaskWriter(live.stream, project(live.stream.records()));
    a.append("resumer.cursor", { world_seq: 1, now: 480 }, 480);
    expect(() => b.append("resumer.cursor", { world_seq: 1, now: 480 }, 480)).toThrow(TickConflict);
    await h.close();
  });

  it("returns tool results in call order and sends every call at effort low with parallel tool calls off", async () => {
    const root = tempRoot();
    const h = harness(root, { mock: scriptedAgent({ pairFirst: true }) });
    h.rt.start();
    const id = h.rt.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER });
    await h.rt.settled();
    for (const b of h.bodies) {
      expect(b["reasoning_effort"]).toBe("low");
      expect(b["parallel_tool_calls"]).toBe(false);
    }
    const second = h.bodies[1]!["messages"] as { role: string; tool_call_id?: string }[];
    expect(second.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(["call_0a", "call_0b"]);
    const results = ofType(root, id, "tool.result").slice(0, 2).map((e) => (e.payload as { name: string; index: number }).index);
    expect(results).toEqual([0, 1]);
    await h.close();
  });

  it("restart rebuilds the task, keeps the version and the clock, and finishes", async () => {
    const root = tempRoot();
    const h = harness(root, { runtime: { clock: "manual" } });
    h.rt.start();
    const id = h.rt.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER });
    await h.rt.settled(20_000, { orWaiting: true });
    await h.rt.stop();
    h.client.close();
    const h2 = harness(root);
    h2.rt.start();
    await h2.rt.settled();
    expect(h2.rt.projection(id).state).toBe("done");
    expect(readStream(root, "world/c-agent001").filter((e) => e.record_type === "port.opened").length).toBe(1);
    await h2.close();
  });

  it("the port refuses a world that changed under an existing stream", () => {
    const root = tempRoot();
    const port = HospitalPort.open(root, baseCase(), registry(), worldRules());
    port.close();
    const changed = baseCase();
    changed.opened_at = 490;
    expect(() => HospitalPort.open(root, changed, registry(), worldRules())).toThrow(/case world differs/);
    expect(() => HospitalPort.open(root, baseCase(), registry(), null)).toThrow(/world rules differ/);
  });
});
