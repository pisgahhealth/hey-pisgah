import { z } from "zod";

// Frozen: id shapes. Dev and reserved cases share one shape so an id never reveals its pool.
const tail = "[a-z0-9]{8}";
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-${tail}$`));
export const CaseId = id("c");
export const EventId = id("ev");
export const RecordId = id("rec");
export const TaskId = id("t");
export const RunId = id("run");
export const WakeId = id("w");
export const HypothesisId = id("h");
export const ExperimentId = id("x");
export const ProposalId = id("p");
export const ActionId = id("a");
// A letter suffix lets one hospital step split into single-kind steps (st12a payment, st12b waiver) without renumbering.
export const StepId = z.string().regex(/^st\d{2}[a-z]?$/);
export const EdgeId = z.string().regex(/^e\d{2}[a-z]?$/);
export const ClaimId = z.string().regex(/^C-\d{2}$/);
export const StreamId = z.string().regex(/^[a-z][a-z0-9_]*(\/[a-z0-9_-]+)*$/);
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const VersionNumber = z.number().int().min(1);
export const IsoDateTime = z.iso.datetime();

export type CaseId = z.infer<typeof CaseId>;
export type EventId = z.infer<typeof EventId>;
export type RecordId = z.infer<typeof RecordId>;
export type TaskId = z.infer<typeof TaskId>;
export type RunId = z.infer<typeof RunId>;
export type WakeId = z.infer<typeof WakeId>;
export type HypothesisId = z.infer<typeof HypothesisId>;
export type ExperimentId = z.infer<typeof ExperimentId>;
export type ProposalId = z.infer<typeof ProposalId>;
export type ActionId = z.infer<typeof ActionId>;
export type StepId = z.infer<typeof StepId>;
export type EdgeId = z.infer<typeof EdgeId>;
export type ClaimId = z.infer<typeof ClaimId>;
export type StreamId = z.infer<typeof StreamId>;
