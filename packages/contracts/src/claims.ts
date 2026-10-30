import { z } from "zod";
import { ClaimId } from "./ids.js";

// Draft (v0): the claims registry; the demo and the video script read claim wording only from a measured status.
export const ClaimStatus = z.enum(["green", "amber", "red", "not_measured"]);

export const Claim = z.strictObject({
  claim_id: ClaimId,
  question: z.string(),
  demo_surface: z.strictObject({ step: z.string(), component: z.string() }),
  evaluation_view: z.strictObject({ tab: z.string(), table: z.string() }),
  acceptance: z.strictObject({ command: z.string(), result_path: z.string(), predicate: z.string(), measured_on: z.enum(["dev", "reserved", "all_runs"]) }),
  wording: z.strictObject({ pass: z.string(), partial: z.string(), fail: z.string(), not_measured: z.string() }),
  evidence_links: z.array(z.string())
});
export type Claim = z.infer<typeof Claim>;

export const ClaimStatusEntry = z.strictObject({ claim_id: ClaimId, status: ClaimStatus, values: z.record(z.string(), z.unknown()), measured_at: z.iso.datetime().nullable() });
export const ClaimsStatusFile = z.strictObject({ generated_at: z.iso.datetime(), commit: z.string(), claims: z.array(ClaimStatusEntry).length(28) });
