import { z } from "zod";
import { CaseId, RunId, Sha256 } from "./ids.js";
import { Envelope } from "./envelope.js";

// Draft (v0): what one simulator run returns; acceptance results are added by the evaluator, never here.

export const RunMetrics = z.object({
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
  terminal_state: z.enum(["departed", "blocked_external"])
});
export type RunMetrics = z.infer<typeof RunMetrics>;

export const RunResult = z.object({
  run_id: RunId,
  case_id: CaseId,
  version_hash: Sha256,
  executor: z.enum(["historical", "definition", "model_agent"]),
  rules_hash: Sha256,
  schedule_hash: Sha256,
  final_state: z.unknown(),
  events: z.array(Envelope),
  step_times: z.record(z.string(), z.object({ started_occ: z.number().int().nullable(), completed_occ: z.number().int().nullable(), completed_rec: z.number().int().nullable() })),
  metrics: RunMetrics,
  decided_by_counts: z.object({ model: z.number().int(), runtime: z.number().int(), person: z.number().int() }),
  effect_set_hash: Sha256,
  invariant_violations: z.array(z.string())
});
export type RunResult = z.infer<typeof RunResult>;
