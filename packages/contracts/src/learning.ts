import { z } from "zod";
import { CaseId, EventId, ExperimentId, HypothesisId, ProposalId, Sha256, VersionNumber } from "./ids.js";
import { Operation } from "./operations.js";
import { CappedCondition, Clocks } from "./workflow.js";

// Draft (v0): hypothesis, experiment and proposal records as the intelligence layer writes them and the evaluator reads them.

export const Metric = z.enum([
  "required_steps_done", "prohibited_attempted", "prohibited_executed", "planned_checks", "unplanned_interventions",
  "unnecessary_docs", "unnecessary_min", "duplicates", "stale_actions", "rework_events", "rework_min",
  "post_signoff_wait_min", "bed_release_delay_min"
]);
export type Metric = z.infer<typeof Metric>;

export const Prediction = z.strictObject({
  metric: Metric,
  comparison: z.enum(["intervention_lt_control", "intervention_gt_control", "no_difference"]),
  tolerance_min: z.number().int().min(0).max(60),
  scope: z.union([z.strictObject({ cases: z.array(CaseId).min(1) }), z.strictObject({ condition: CappedCondition })])
});

export const HypothesisStatus = z.enum(["open", "retained", "rejected", "revised", "insufficient_evidence"]);

export const HypothesisRecordBase = z.strictObject({
  hypothesis_id: HypothesisId,
  session_id: z.string(),
  created: Clocks,
  hash: Sha256,
  statement: z.string().max(300),
  mechanism: z.string().max(300),
  subject_refs: z.array(z.string()),
  competing: z.union([z.array(HypothesisId).min(1), z.strictObject({ none_identified_reason: z.string().max(200) })]),
  evidence: z.array(z.strictObject({ event_id: EventId, case_id: CaseId, stance: z.enum(["supports", "contradicts", "context"]), note: z.string().max(140) })).min(3),
  if_true: Prediction,
  if_false: Prediction,
  refuted_if: z.string().max(300),
  revises: HypothesisId.nullable(),
  status: HypothesisStatus,
  status_history: z.array(z.strictObject({ status: HypothesisStatus, at: Clocks, evidence_event_ids: z.array(EventId), experiment_ids: z.array(ExperimentId), note: z.string().max(300) }))
});
export const HypothesisRecord = HypothesisRecordBase.refine((h) => h.if_true.metric !== h.if_false.metric || h.if_true.comparison !== h.if_false.comparison, {
  message: "if_true and if_false must differ on at least one metric or comparison"
}).refine((h) => new Set(h.evidence.map((e) => e.case_id)).size >= 2, { message: "evidence must span at least 2 cases" });
export type HypothesisRecord = z.infer<typeof HypothesisRecordBase>;

export const InsufficientEvidence = z.strictObject({
  missing_measurement: z.string().max(200),
  distinguishes: z.array(HypothesisId).min(2),
  why_it_matters: z.string().max(300)
});

export const PredictionCheck = z.strictObject({
  before: z.strictObject({ speaks_to: z.array(HypothesisId), distinguishes: z.array(z.tuple([HypothesisId, HypothesisId])) }),
  after: z.strictObject({
    per_hypothesis: z.record(HypothesisId, z.strictObject({ landed: z.enum(["if_true", "if_false", "inconclusive"]) })),
    contradicted: z.array(HypothesisId)
  }).nullable()
});
export type PredictionCheck = z.infer<typeof PredictionCheck>;

export const ExperimentRequest = z.strictObject({
  hypothesis_id: HypothesisId,
  distinguishes: z.array(HypothesisId),
  base: z.union([z.strictObject({ version: VersionNumber }), z.strictObject({ proposal_id: ProposalId })]),
  ops: z.array(Operation).min(1).max(3),
  case_ids: z.array(CaseId).min(1).max(6),
  note: z.string().max(300)
});
export type ExperimentRequest = z.infer<typeof ExperimentRequest>;

export const ExperimentBudget = { experiments: 8, casesPerExperiment: 6, invalidRequestsBeforeLockout: 3, proposals: 3 } as const;

export const WorkflowChangeProposal = z.strictObject({
  proposal_id: ProposalId,
  parent_proposal_id: ProposalId.nullable(),
  base_version: VersionNumber,
  ops: z.array(Operation).min(1).max(3),
  scope: z.strictObject({ wards: z.union([z.array(z.string()).min(1), z.literal("all")]), condition: CappedCondition.nullable() }),
  rationale: z.string().max(600),
  evidence: z.strictObject({ hypothesis_ids: z.array(HypothesisId), experiment_ids: z.array(ExperimentId), event_ids: z.array(EventId) }),
  expected_effects: z.array(z.strictObject({ metric: Metric, direction: z.enum(["down", "up", "same"]), subgroup_condition: CappedCondition.nullable() })),
  known_exceptions: z.array(z.strictObject({ condition: CappedCondition, behaviour: z.literal("not_applied") })),
  viewed_case_ids: z.array(CaseId),
  status: z.enum(["submitted", "dev_validated", "dev_failed", "withdrawn"]),
  hash: Sha256
});
export type WorkflowChangeProposal = z.infer<typeof WorkflowChangeProposal>;
