import { readFileSync } from "node:fs";
import { z } from "zod";
import { WorkflowChangeProposal, hashJson, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { loadPool } from "@hey-pisgah/cases";
import type { Facts } from "@hey-pisgah/workflow";
import { proposalDefinition, validateProposal, type PipelineOptions, type ValidationReport } from "../pipeline.js";

export const PROPOSAL_ARMS = ["A2", "A3", "A4", "A-prior"] as const;
export type ProposalArm = (typeof PROPOSAL_ARMS)[number];

const Cost = z.strictObject({
  usd: z.strictObject({ discovery: z.number().min(0), experiments: z.number().min(0), repairs: z.number().min(0), execution: z.number().min(0) }),
  calls: z.number().int().min(0),
  latency_p50_ms: z.number().min(0).nullable()
});

// The proposal input to one arm: what L2.1's runs submitted, in submission order, with where it came from.
export const ProposalInput = z.strictObject({
  schema: z.literal("hey-pisgah/proposal-input/1"),
  arm: z.enum(PROPOSAL_ARMS),
  source: z.strictObject({
    kind: z.enum(["model_run", "fixture"]),
    mode: z.enum(["live", "replay", "mock", "fixture"]),
    provider: z.string().nullable(),
    model_id: z.string().nullable(),
    commitment_hashes: z.record(z.string(), z.string()),
    request_ids: z.array(z.string()),
    note: z.string().max(300)
  }),
  // One run for A2, A3 and A4 with up to 3 proposals; three runs of one proposal each for A-prior.
  runs: z.array(z.strictObject({ run_id: z.string().min(1), proposals: z.array(z.unknown()).max(3) })).min(1),
  // A2 only: the proposal a person adopted; the arm then runs that version.
  adopted: z.strictObject({ proposal_id: z.string(), approver_role: z.string(), adopted_at_wall: z.string() }).nullable(),
  cost: Cost.nullable()
}).superRefine((x, ctx) => {
  if (x.arm === "A-prior" && x.runs.some((r) => r.proposals.length > 1)) ctx.addIssue({ code: "custom", message: "A-prior runs carry one proposal each" });
  if (x.arm !== "A-prior" && x.runs.length !== 1) ctx.addIssue({ code: "custom", message: `${x.arm} carries one run` });
  if (x.arm === "A2" && x.adopted === null) ctx.addIssue({ code: "custom", message: "A2 needs the adopted proposal" });
});
export type ProposalInput = z.infer<typeof ProposalInput>;

export const loadProposalInput = (file: string): ProposalInput => ProposalInput.parse(JSON.parse(readFileSync(file, "utf8")));

export type ArmVersion = {
  arm: ProposalArm;
  input_hash: string;
  source: ProposalInput["source"];
  // The definition the arm runs; the base when no proposal passed the dev gate.
  definition: WD;
  chosen: { run_id: string; proposal_id: string } | null;
  equals_base: boolean;
  reports: { run_id: string; proposal_id: string | null; status: ValidationReport["status"]; gate_pass: boolean }[];
  validation: ValidationReport[];
  cost: ProposalInput["cost"];
  adopted: ProposalInput["adopted"];
};

// Resolves an arm's version: every proposal goes through the same dev gate; the arm runs the adopted one (A2) or the first dev-valid one, else the base.
export async function armVersion(input: ProposalInput, base: WD, opts: PipelineOptions = {}): Promise<ArmVersion> {
  const caseFacts = opts.caseFacts ?? loadPool("discovery").map((c) => c.schedule.facts as Facts);
  const validation: ValidationReport[] = [];
  const reports: ArmVersion["reports"] = [];
  let chosen: ArmVersion["chosen"] = null;
  let definition = base;
  for (const run of input.runs) {
    for (const raw of run.proposals) {
      const r = await validateProposal(raw, { ...opts, base, caseFacts });
      validation.push(r);
      reports.push({ run_id: run.run_id, proposal_id: r.proposal_id, status: r.status, gate_pass: r.gate?.pass ?? false });
      const wanted = input.arm === "A2" ? r.proposal_id === input.adopted?.proposal_id : true;
      if (!chosen && wanted && r.status === "dev_validated") {
        const p = WorkflowChangeProposal.parse(raw);
        const built = proposalDefinition(base, p, caseFacts);
        if (built.ok) { chosen = { run_id: run.run_id, proposal_id: p.proposal_id }; definition = built.def; }
      }
    }
  }
  return { arm: input.arm, input_hash: hashJson(input), source: input.source, definition, chosen, equals_base: chosen === null, reports, validation, cost: input.cost, adopted: input.adopted };
}
