import { describe, expect, it } from "vitest";
import { type WorkflowDefinition } from "@hey-pisgah/contracts";
import { runDefinition } from "@hey-pisgah/simulator";
import { applyOperations } from "@hey-pisgah/workflow";
import { loadV1 } from "./definition.js";
import { loadHandCase } from "./fixtures.js";
import { worldRules } from "./world.js";

const hand = loadHandCase();
const v1 = loadV1();
const world = worldRules();
const apply = (ops: unknown[]): WorkflowDefinition => {
  const r = applyOperations(v1, ops);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join("; "));
  return r.definition;
};
const run = (def: WorkflowDefinition, use_agent: boolean) => {
  const r = runDefinition(def, hand.schedule, { use_agent, world });
  if (r.outcome !== "ok") throw new Error(r.invariant_violations.join("; "));
  return r;
};
const wait = (def: WorkflowDefinition, use_agent: boolean) => run(def, use_agent).metrics.post_signoff_wait_min!;
const changed = apply(hand.g2.ops);

describe("G2 on the hand case, definition executor", () => {
  it("keeps the stored fences when the learned change applies", () => {
    expect(changed.metadata.fences_hash).toBe(v1.metadata.fences_hash);
  });
  it("cuts the wait by 60 or more with the agent preparing", () => {
    const e = hand.g2.expected;
    const [a, b] = [wait(v1, true), wait(changed, true)];
    expect([a, b, a - b]).toEqual([e.agent.v1_wait_min, e.agent.changed_wait_min, e.agent.cut_min]);
    expect(a - b).toBeGreaterThanOrEqual(e.min_cut_agent);
    expect(a).toBeGreaterThanOrEqual(e.min_control_wait);
  });
  it("cuts the wait with staff preparing too", () => {
    const e = hand.g2.expected.staff;
    const [a, b] = [wait(v1, false), wait(changed, false)];
    expect([a, b, a - b]).toEqual([e.v1_wait_min, e.changed_wait_min, e.cut_min]);
  });
  it("changes nothing when only the soft edge goes, because the v1 trigger mirrors it", () => {
    for (const agent of [true, false]) expect(wait(v1, agent) - wait(apply(hand.g2.edge_only_ops), agent)).toBe(hand.g2.expected.edge_only_cut);
  });
  it("gives the same cut with one revision fewer when the draft waits for the take-home order", () => {
    const viaRound = run(changed, true);
    const viaOrder = run(apply(hand.g2.after_order_ops), true);
    expect(viaOrder.metrics.post_signoff_wait_min).toBe(viaRound.metrics.post_signoff_wait_min);
    expect(viaRound.metrics.rework_events - viaOrder.metrics.rework_events).toBe(1);
  });
  it("still holds the final summary until the clinical discharge", () => {
    const r = run(changed, true);
    expect(r.step_times["st06"]!.completed_occ!).toBeLessThan(r.step_times["st05"]!.completed_occ!);
    expect(r.step_times["st07"]!.completed_occ!).toBeGreaterThanOrEqual(r.step_times["st05"]!.completed_occ!);
  });
  it("takes 20 minutes to check an unseen summary and 5 to check one seen while pending", () => {
    const dur = (def: WorkflowDefinition) => { const t = run(def, true).step_times["st08"]!; return t.completed_occ! - t.started_occ!; };
    expect([dur(v1), dur(changed)]).toEqual([20, 5]);
  });
});
