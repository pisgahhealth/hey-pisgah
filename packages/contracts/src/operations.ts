import { z } from "zod";
import { EdgeId } from "./ids.js";
import { CappedCondition, CappedPredicate, DocumentId, SectionId, SourceRef, StepRef } from "./workflow.js";

// Draft (v0): the six operations a proposal or experiment may apply; only soft structure is reachable.
export const ConditionTarget = z.union([
  z.strictObject({ step: StepRef }),
  z.strictObject({ trigger_index: z.number().int().min(0) }),
  z.literal("scope")
]);

export const Operation = z.union([
  z.strictObject({ op: z.literal("remove_soft_edge"), edge_id: EdgeId }),
  z.strictObject({ op: z.literal("add_soft_edge"), from: StepRef, to: StepRef, gate: z.enum(["start", "complete"]) }),
  z.strictObject({ op: z.literal("move_step_after"), step: StepRef, after: StepRef, gate: z.enum(["start", "complete"]) }),
  z.strictObject({ op: z.literal("set_prep_trigger"), target: StepRef, when: CappedPredicate }),
  z.strictObject({ op: z.literal("add_condition"), target: ConditionTarget, condition: CappedCondition }),
  z.strictObject({ op: z.literal("rebind_section"), document_id: DocumentId, section_id: SectionId, source: SourceRef })
]);
export type Operation = z.infer<typeof Operation>;
export const OPS_PER_REQUEST_MAX = 3;
