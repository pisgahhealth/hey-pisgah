import { z } from "zod";
import { CaseId, RunId, Sha256 } from "./ids.js";
import { SimEvent } from "./envelope.js";

// Draft (v0): what one simulator run returns; acceptance results are added by the evaluator, never here.

export const RunMetrics = z.strictObject({
  required_steps_done: z.number().int().min(0),
  required_steps_total: z.number().int().min(0),
  prohibited_attempted: z.number().int().min(0),
  prohibited_executed: z.number().int().min(0),
  planned_checks: z.number().int().min(0),
  unplanned_interventions: z.number().int().min(0),
  unnecessary_docs: z.number().int().min(0),
  unnecessary_min: z.number().int().min(0),
  duplicates: z.number().int().min(0),
  stale_actions: z.number().int().min(0),
  rework_events: z.number().int().min(0),
  rework_min: z.number().int().min(0),
  staff_min_by_role: z.record(z.string(), z.number().int().min(0)),
  agent_actions: z.number().int().min(0),
  post_signoff_wait_min: z.number().int().min(0).nullable(),
  bed_release_delay_min: z.number().int().min(0).nullable(),
  terminal_state: z.enum(["departed", "blocked_external", "horizon_reached"])
});
export type RunMetrics = z.infer<typeof RunMetrics>;

const RunResultOk = z.strictObject({
  outcome: z.literal("ok"),
  run_id: RunId,
  case_id: CaseId,
  version_hash: Sha256,
  executor: z.enum(["historical", "definition", "model_agent"]),
  rules_hash: Sha256,
  schedule_hash: Sha256,
  final_state: z.unknown(),
  events: z.array(SimEvent),
  step_times: z.record(z.string(), z.strictObject({ started_occ: z.number().int().nullable(), completed_occ: z.number().int().nullable(), completed_rec: z.number().int().nullable() })),
  metrics: RunMetrics,
  decided_by_counts: z.strictObject({ model: z.number().int(), runtime: z.number().int(), person: z.number().int() }),
  effect_set_hash: Sha256,
  invariant_violations: z.array(z.string()).length(0)
});
const RunResultAborted = z.strictObject({
  outcome: z.literal("aborted"),
  run_id: RunId,
  case_id: CaseId,
  version_hash: Sha256,
  executor: z.enum(["historical", "definition", "model_agent"]),
  rules_hash: Sha256,
  schedule_hash: Sha256,
  invariant_violations: z.array(z.string()).min(1),
  aborted_at: z.number().int().min(0)
});
// A run either completes with metrics or aborts on an invariant violation with none.
export const RunResult = z.discriminatedUnion("outcome", [RunResultOk, RunResultAborted]);
export type RunResult = z.infer<typeof RunResult>;
