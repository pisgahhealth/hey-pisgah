import { describe, expect, it } from "vitest";
import { Proof, RUNTIME_EVENT_TYPES, TaskState } from "@hey-pisgah/contracts";
import { applyOperations } from "@hey-pisgah/workflow";
import { completionMatrix, recordStateFromRun, verifyCompletion, type RecordState, type RuntimeEvent, type TaskStreamReader } from "../src/completion.js";
import { runCase } from "../src/pipeline.js";
import { caseOf, v1 } from "./helpers.js";

const hex = (c: string) => c.repeat(64);
const clocks = { occurred_at: 700, recorded_at: 700, wall_at: "2026-10-28T10:00:00.000Z" };
const proof = Proof.parse({ verified_at: clocks, record_id: "rec-aaaaaaaa", record_version: 1, record_hash: hex("a"), produced_event_ids: ["ev-aaaaaaaa"], source_refs: [], intent_key: hex("b"), tool_call_ids: ["call_1"], model_response_id: null });

// A hand-built task stream in the runtime's record types; the runtime itself is built in parallel.
function stream(final: TaskState | null, extra: { type: string; payload: unknown }[] = []): RuntimeEvent[] {
  const list = [{ type: "task.opened", payload: { task_id: "t-aaaaaaaa" } }, { type: "action.completed", payload: { action_id: "a-aaaaaaaa", proof } }, ...extra];
  if (final) list.push({ type: "task.state_changed", payload: { from: "running", to: final, reason: "fixture" } });
  return list.map((e, i) => ({ seq: i + 1, record_type: e.type, payload: e.payload }));
}

const ref = (k: string, v = 1, cur = v) => ({ record_kind: k, version: v, current_version: cur });
const stage = (document_id: string, st: "draft" | "final", status: "complete" | "pending" | "absent" = "complete", refs = [ref("admission_record")]) => ({ document_id, stage: st, status, version: 1, source_refs: refs, handed_over: st === "final" });
const facts = { ward_id: "A", payer_type: "self_pay", has_take_home_order: "true", ward_requires: ["discharge_summary", "stay_bill", "clearance_slip", "refund_voucher"] };
const good = (caseId: string): RecordState => ({
  case_id: caseId, ward_id: "A", requirement_version: "r1", facts,
  stages: [stage("discharge_summary", "draft"), stage("discharge_summary", "final"), stage("refund_voucher", "draft"), stage("refund_voucher", "final")]
});

describe("FR-5 verifier over the record state", () => {
  it("passes a complete, current record and fails each kind of shortfall", () => {
    expect(verifyCompletion(v1, good("c-aaaaaaaa"), "c-aaaaaaaa")).toMatchObject({ pass: true, unmet: [] });
    const dropped = { ...good("c-aaaaaaaa"), stages: good("c-aaaaaaaa").stages.filter((s) => !(s.document_id === "discharge_summary" && s.stage === "final")) };
    expect(verifyCompletion(v1, dropped, "c-aaaaaaaa").unmet).toEqual([{ condition: "discharge_summary.final", reason: "absent" }]);
    const stale = { ...good("c-aaaaaaaa"), stages: [...good("c-aaaaaaaa").stages.slice(0, 1), stage("discharge_summary", "final", "complete", [ref("take_home_order", 1, 2)]), ...good("c-aaaaaaaa").stages.slice(2)] };
    expect(verifyCompletion(v1, stale, "c-aaaaaaaa").unmet).toEqual([{ condition: "discharge_summary.final", reason: "stale_source" }]);
    const pending = { ...good("c-aaaaaaaa"), stages: [...good("c-aaaaaaaa").stages.slice(0, 3), stage("refund_voucher", "final", "pending")] };
    expect(verifyCompletion(v1, pending, "c-aaaaaaaa").unmet).toEqual([{ condition: "refund_voucher.final", reason: "not_complete" }]);
    expect(verifyCompletion(v1, null, "c-aaaaaaaa")).toMatchObject({ pass: false, unmet: [{ reason: "record_unavailable" }] });
  });
  it("accepts a stale draft once its own final is complete and current", () => {
    const s = good("c-aaaaaaaa");
    s.stages[0] = stage("discharge_summary", "draft", "complete", [ref("take_home_order", 1, 2)]);
    s.stages[0]!.status = "pending";
    expect(verifyCompletion(v1, s, "c-aaaaaaaa").pass).toBe(true);
  });
  it("applies the Ward B r2 content rule to the final", () => {
    const fv = caseOf("variation", "c-830e004c");
    const blind = recordStateFromRun(runCase(v1, fv.file.schedule), v1, fv.manifest);
    expect(verifyCompletion(v1, blind, fv.file.case_id).unmet).toContainEqual({ condition: "discharge_summary.final", reason: "content_rule" });
    const rebound = applyOperations(v1, [{ op: "rebind_section", document_id: "discharge_summary", section_id: "medicines", source: { record_kind: "dispense_record", field_path: "items", version_policy: "current" } }]);
    if (!rebound.ok) throw new Error("ops");
    const adapted = recordStateFromRun(runCase(rebound.definition, fv.file.schedule), rebound.definition, fv.manifest);
    expect(verifyCompletion(rebound.definition, adapted, fv.file.case_id).pass).toBe(true);
  });
  it("verifies sim runs through the same record state, and every dev case passes on v1", () => {
    for (const id of ["c-1d4adfd6", "c-efe5d0a3", "c-f1f15bd9", "c-5bbb4174"]) {
      const c = caseOf("dev", id);
      expect(verifyCompletion(v1, recordStateFromRun(runCase(v1, c.file.schedule), v1, c.manifest), id)).toMatchObject({ pass: true });
    }
  });
});

describe("FR-5 agreement matrix", () => {
  const records = new Map<string, RecordState | null>();
  const streams = new Map<string, RuntimeEvent[]>();
  const add = (task: string, s: RuntimeEvent[], r: RecordState | null) => { streams.set(task, s); records.set(task.replace("t-", "c-"), r); };
  const drop = (s: RecordState): RecordState => ({ ...s, stages: s.stages.filter((x) => x.stage !== "final" || x.document_id !== "discharge_summary") });
  add("t-00000001", stream("done"), good("c-00000001"));
  add("t-00000002", stream("done", [{ type: "completion.attempt_refused", payload: { target: "action", action_id: "a-aaaaaaaa", reason: "no_proof" } }]), drop(good("c-00000002")));
  add("t-00000003", stream("needs_input", [{ type: "completion.attempt_refused", payload: { target: "task", reason: "unmet_conditions" } }]), good("c-00000003"));
  add("t-00000004", stream("needs_input"), drop(good("c-00000004")));
  add("t-00000005", stream("waiting"), drop(good("c-00000005")));
  add("t-00000006", stream("cancelled"), drop(good("c-00000006")));
  add("t-00000007", stream("done", [{ type: "action.retry", payload: { action_id: "a-aaaaaaaa", reason: "no_effect_found_at_port" } }, { type: "action.retry", payload: { action_id: "a-aaaaaaaa", reason: "no_effect_found_at_port" } }, { type: "completion.attempt_refused", payload: { target: "action", action_id: "a-aaaaaaaa", reason: "stale" } }]), good("c-00000007"));
  add("t-00000008", stream(null), null);
  const reader = (override?: TaskState): TaskStreamReader => ({
    taskIds: () => [...streams.keys()],
    caseOf: (t) => t.replace("t-", "c-"),
    events: (t) => override ? stream(override) : streams.get(t)!
  });
  const recs = { recordState: (c: string) => records.get(c) ?? null };

  it("uses only runtime record types and contract proofs in its fixtures", () => {
    const types = new Set<string>(RUNTIME_EVENT_TYPES);
    for (const s of streams.values()) for (const e of s) expect(types.has(e.record_type)).toBe(true);
  });
  it("fills the 2x2 matrix, counts premature attempts and keeps the other states apart", () => {
    const m = completionMatrix(reader(), recs, () => v1);
    expect(m.matrix).toEqual({ done_pass: 2, done_fail: 1, needs_input_pass: 1, needs_input_fail: 1 });
    expect([m.off_diagonal, m.false_done]).toEqual([2, 1]);
    expect([m.premature_attempts, m.premature_by_target]).toEqual([3, { action: 2, task: 1 }]);
    expect(m.states).toMatchObject({ done: 3, needs_input: 2, waiting: 1, cancelled: 1, running: 1, paused: 0, failed: 0 });
    expect(m.retrying).toEqual({ events: 2, tasks: 1 });
    expect(m.rows.find((r) => r.task_id === "t-00000002")).toMatchObject({ cell: "done_fail", verdict: { unmet: [{ reason: "absent" }] } });
  });
  it("gives the same verdicts whatever the task streams claim", () => {
    const honest = completionMatrix(reader(), recs, () => v1).rows.map((r) => r.verdict);
    const claimsDone = completionMatrix(reader("done"), recs, () => v1);
    expect(claimsDone.rows.map((r) => r.verdict)).toEqual(honest);
    expect(claimsDone.matrix.done_fail).toBe(honest.filter((v) => !v.pass).length);
  });
});
