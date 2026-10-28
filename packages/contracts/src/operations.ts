import { z } from "zod";
import { EdgeId, StepId } from "./ids.js";
import { ConditionExpr, EventPredicate, SourceRef, StepRef } from "./workflow.js";

// Draft (v0): the six operations a proposal or experiment may apply; only soft structure is reachable.
export const Operation = z.union([
  z.object({ op: z.literal("remove_soft_edge"), edge_id: EdgeId }),
  z.object({ op: z.literal("add_soft_edge"), from: StepRef, to: StepRef, gate: z.enum(["start", "complete"]) }),
  z.object({ op: z.literal("move_step_after"), step: StepRef, after: StepRef, gate: z.enum(["start", "complete"]) }),
  z.object({ op: z.literal("set_prep_trigger"), target: StepRef, when: EventPredicate }),
  z.object({ op: z.literal("add_condition"), op_index: z.union([z.number().int().min(0), z.literal("all")]), condition: ConditionExpr }),
  z.object({ op: z.literal("rebind_section"), document_id: z.string(), section_id: z.string(), source: SourceRef })
]);
export type Operation = z.infer<typeof Operation>;
export const OPS_PER_REQUEST_MAX = 3;
export { StepId };
