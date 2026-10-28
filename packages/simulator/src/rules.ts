import { hashJson } from "@hey-pisgah/contracts";
import { z } from "zod";

// Bump this string, and add a changelog line, whenever engine behaviour changes a golden hash.
export const RULES_VERSION = "sim-rules-1";
export const HORIZON_MIN = 2880;

// Engine parameter defaults; a schedule may override them and the run's rules_hash then reflects the override.
export const SimParams = z.strictObject({
  agent_prep_min: z.number().int().min(1),
  draft_verification: z.strictObject({ on: z.boolean(), min: z.number().int().min(0) }),
  markers: z.strictObject({ signoff_record: z.string(), departure_action: z.string(), bed_release_action: z.string() })
});
export type SimParams = z.infer<typeof SimParams>;

export const DEFAULT_PARAMS: SimParams = Object.freeze({
  agent_prep_min: 1,
  draft_verification: Object.freeze({ on: true, min: 4 }),
  markers: Object.freeze({ signoff_record: "signoff_record", departure_action: "record_departure", bed_release_action: "financial_clearance" })
}) as SimParams;

export function rulesHashFor(params: SimParams): string {
  return hashJson({ rules_version: RULES_VERSION, horizon: HORIZON_MIN, params });
}

// The hash hospital metadata carries; it covers the rules version and every default parameter.
export const RULES_HASH: string = rulesHashFor(DEFAULT_PARAMS);

export const ParamOverrides = z.strictObject({
  agent_prep_min: SimParams.shape.agent_prep_min.optional(),
  draft_verification: SimParams.shape.draft_verification.optional(),
  markers: SimParams.shape.markers.optional()
});
export type ParamOverrides = z.infer<typeof ParamOverrides>;

export function effectiveParams(o: ParamOverrides | undefined): SimParams {
  return {
    agent_prep_min: o?.agent_prep_min ?? DEFAULT_PARAMS.agent_prep_min,
    draft_verification: structuredClone(o?.draft_verification ?? DEFAULT_PARAMS.draft_verification),
    markers: structuredClone(o?.markers ?? DEFAULT_PARAMS.markers)
  };
}
