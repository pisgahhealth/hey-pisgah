import type { z } from "zod";

type Shape = { type: string; example: unknown };

// The expected shape of each record_hypothesis field, shown on a schema error; examples use the refund voucher steps and the edge e99, never the discharge steps.
export const HYPOTHESIS_SHAPES: Record<string, Shape> = {
  statement: { type: "string, 1 to 300 characters", example: "The refund voucher draft st17a waits on edge e99." },
  mechanism: { type: "string, 1 to 300 characters", example: "Edge e99 holds st17a until the deposit record exists." },
  subject_refs: { type: "array of up to 12 strings, each up to 60 characters", example: ["st17a", "e99"] },
  competing: { type: "array of at least one hypothesis id from this session, or an object with none_identified_reason (string, up to 200 characters)", example: { none_identified_reason: "no other reading of st17a found yet" } },
  evidence: { type: "array of 3 to 12 objects {event_id, case_id, stance: supports | contradicts | context, note: string up to 140 characters}, spanning at least 2 cases; each event_id must be an event of its case_id", example: [{ event_id: "ev-00000000", case_id: "c-00000000", stance: "supports", note: "st17a started after the deposit record" }] },
  if_true: { type: "object {metric, comparison: intervention_lt_control | intervention_gt_control | no_difference, tolerance_min: integer 0 to 60 (counts at most 3), scope: {cases: [case ids]} or {condition}}; if_true and if_false differ on metric or comparison", example: { metric: "rework_min", comparison: "no_difference", tolerance_min: 5, scope: { cases: ["c-00000000"] } } },
  if_false: { type: "same shape as if_true", example: { metric: "rework_min", comparison: "intervention_gt_control", tolerance_min: 5, scope: { cases: ["c-00000000"] } } },
  refuted_if: { type: "string, 1 to 300 characters", example: "Removing e99 leaves st17a's start minute unchanged." },
  revises: { type: "a hypothesis id from this session, or null", example: null }
};

// One entry per failing top-level field, in issue order; a rule that spans the record names the fields it reads.
export function expectedShapes(error: z.ZodError): { field: string; type: string; example: unknown }[] {
  const out = new Map<string, Shape>();
  for (const i of error.issues) {
    const head = i.path[0];
    const fields = typeof head === "string" ? [head] : i.message.includes("if_true") ? ["if_true", "if_false"] : i.message.includes("evidence") ? ["evidence"] : [];
    for (const f of fields) if (HYPOTHESIS_SHAPES[f] && !out.has(f)) out.set(f, HYPOTHESIS_SHAPES[f]);
  }
  return [...out.entries()].map(([field, s]) => ({ field, ...s }));
}

// The ledger fields record_hypothesis takes in the investigation cycle, shown on a schema error.
export const LEDGER_SHAPES: Record<string, Shape> = {
  predicted_magnitude_min: { type: "integer 0 to 600, the size of the effect if_true predicts", example: 20 },
  falsifying_experiment: { type: "string, 1 to 300 characters", example: "Remove e99 and retrigger st17a on the deposit record; the voucher wait stays." },
  if_null: { type: "string, 1 to 300 characters, what you conclude if the experiment delivers the change and the outcome does not move", example: "The voucher wait is set by the clerk's queue, not by e99." }
};
