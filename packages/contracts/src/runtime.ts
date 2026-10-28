import { z } from "zod";
import { ActionId, CaseId, EventId, RecordId, Sha256, TaskId, VersionNumber, WakeId } from "./ids.js";
import { ActionKind, Clocks, EventPredicate } from "./workflow.js";

// Draft (v0): the personal agent's durable task, wake, proof and completion records (plan 4.11).

export const TaskState = z.enum(["running", "waiting", "needs_input", "paused", "cancelled", "done", "failed"]);
export type TaskState = z.infer<typeof TaskState>;

export const ActionState = z.enum(["intended", "written", "completed", "refused", "retrying", "failed"]);

export const Wake = z.strictObject({
  wake_id: WakeId,
  predicate: EventPredicate,
  record_ids: z.array(RecordId),
  deadline_simulated_min: z.number().int().min(0).max(2880).nullable(),
  registered_by: z.enum(["runtime", "model"]),
  registered_at: Clocks,
  consumed_by: z.string().nullable()
}).refine((w) => w.registered_by !== "model" || w.deadline_simulated_min !== null, { message: "a model-registered wake carries a deadline" });
export type Wake = z.infer<typeof Wake>;

export const Proof = z.strictObject({
  verified_at: Clocks,
  record_id: RecordId,
  record_version: z.number().int().min(1),
  record_hash: Sha256,
  produced_event_ids: z.array(EventId).min(1),
  source_refs: z.array(z.strictObject({ record_id: RecordId, version: z.number().int().min(1) })),
  intent_key: Sha256,
  tool_call_ids: z.array(z.string()),
  model_response_id: z.string().nullable()
});
export type Proof = z.infer<typeof Proof>;

export const AgentAction = z.strictObject({
  action_id: ActionId,
  action_kind: ActionKind,
  args_hash: Sha256,
  intent_key: Sha256,
  state: ActionState,
  proof: Proof.nullable(),
  decided_by: z.enum(["model", "runtime", "person"])
}).refine((a) => a.state !== "completed" || a.proof !== null, { message: "completed requires a proof" });
export type AgentAction = z.infer<typeof AgentAction>;

export const AcceptanceCondition = z.strictObject({ condition_id: z.string(), description: z.string().max(200), proof_action_id: ActionId.nullable() });

export const AgentTask = z.strictObject({
  task_id: TaskId,
  owner: z.string(),
  case_id: CaseId,
  goal: z.string().max(500),
  acceptance_conditions: z.array(AcceptanceCondition),
  workflow_version: VersionNumber,
  state: TaskState,
  actions: z.array(AgentAction),
  wakes: z.array(Wake),
  budget: z.strictObject({ max_calls: z.number().int().min(1), max_usd: z.number().min(0), calls_used: z.number().int().min(0), usd_used: z.number().min(0) }),
  created: Clocks,
  updated: Clocks
}).superRefine((t, ctx) => {
  if (t.state !== "done") return;
  if (t.acceptance_conditions.length === 0) ctx.addIssue({ code: "custom", message: "done requires at least one acceptance condition" });
  for (const c of t.acceptance_conditions) {
    const a = t.actions.find((x) => x.action_id === c.proof_action_id);
    if (!a || a.state !== "completed" || a.proof === null) ctx.addIssue({ code: "custom", message: `${c.condition_id} lacks a completed, proved action` });
  }
});
export type AgentTask = z.infer<typeof AgentTask>;

export const RUNTIME_EVENT_TYPES = [
  "task.opened", "task.state_changed", "task.resumed", "action.intent", "action.written", "action.completed", "action.refused",
  "action.retry", "completion.attempt_refused", "wake.registered", "wake.fired", "version.check_failed",
  "version.suspension_proposed", "version.revision_proposed"
] as const;
