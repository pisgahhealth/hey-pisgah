import { hashJson, type Operation, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import type { Facts } from "@hey-pisgah/workflow";
import { validateProposal, type BaseRuns, type ValidationCase, type ValidationReport } from "../pipeline.js";
import { opKey, singleOperationSpace } from "./space.js";

// Wraps operations as a proposal so a sweep entry goes through exactly the pipeline a model proposal does.
export function proposalFor(ops: readonly Operation[], base: WD, tag: string): Record<string, unknown> {
  return {
    proposal_id: `p-${hashJson({ tag, ops }).slice(0, 8)}`, parent_proposal_id: null, base_version: base.version, ops: [...ops],
    scope: { wards: "all", condition: null }, rationale: `${tag} entry`, evidence: { hypothesis_ids: [], experiment_ids: [], event_ids: [] },
    expected_effects: [], known_exceptions: [], viewed_case_ids: [], status: "submitted", hash: "0".repeat(64)
  };
}

type Delta = Record<string, number | null>;
const deltas = (r: ValidationReport): Delta => Object.fromEntries(r.cases.map((c) => [c.case_id, c.delta.post_signoff_wait_min]));
const sameDeltas = (a: Delta, b: Delta) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

export type SweepEntry = { op: Operation; status: ValidationReport["status"]; gate_pass: boolean; median_wait_delta: number | null; best_cut: number; identical_cases: number };
export type SweepResult = {
  space_hash: string; candidates: number; valid: number; distinct_definitions: number; invalid: Record<string, number>;
  validated: number; passing: number; passing_and_cutting: number; cut_threshold_min: number;
  top: SweepEntry[];
  reference: { ops: Operation[]; status: ValidationReport["status"]; best_cut: number; in_space: false; single_op_with_same_effect: Operation | null; finding: string } | null;
  entries: SweepEntry[];
};

// Every valid single operation through the dev gate; reports how many pass, how many also cut a wait, and whether any matches a reference change.
export async function singleOperationSweep(base: WD, cases: ValidationCase[], caseFacts: readonly Facts[], opts: { reference?: readonly Operation[]; cutThreshold?: number; limit?: number; filter?: (op: Operation) => boolean } = {}): Promise<SweepResult> {
  const space = singleOperationSpace(base, caseFacts);
  const kept = opts.filter ? space.entries.filter((e) => opts.filter!(e.op)) : space.entries;
  const entriesIn = opts.limit === undefined ? kept : kept.slice(0, opts.limit);
  const baseRuns: BaseRuns = new Map();
  const byDef = new Map<string, ValidationReport>();
  const threshold = opts.cutThreshold ?? 30;
  const entries: SweepEntry[] = [];
  const opDeltas = new Map<string, Delta>();
  for (const e of entriesIn) {
    let r = byDef.get(e.definition_hash);
    if (!r) { r = await validateProposal(proposalFor([e.op], base, "sweep"), { base, cases, caseFacts, baseRuns }); byDef.set(e.definition_hash, r); }
    const cuts = r.cases.map((c) => -(c.delta.post_signoff_wait_min ?? 0));
    entries.push({ op: e.op, status: r.status, gate_pass: r.gate?.pass ?? false, median_wait_delta: r.summary?.median_wait_delta ?? null, best_cut: Math.max(0, ...cuts), identical_cases: r.cases.filter((c) => c.identical_log).length });
    opDeltas.set(opKey(e.op), deltas(r));
  }
  const passing = entries.filter((e) => e.gate_pass);
  let reference: SweepResult["reference"] = null;
  if (opts.reference) {
    const r = await validateProposal(proposalFor(opts.reference, base, "reference"), { base, cases, caseFacts, baseRuns });
    const ref = deltas(r);
    const match = passing.find((e) => sameDeltas(opDeltas.get(opKey(e.op))!, ref))?.op ?? null;
    const best = Math.max(0, ...r.cases.map((c) => -(c.delta.post_signoff_wait_min ?? 0)));
    reference = {
      ops: [...opts.reference], status: r.status, best_cut: best, in_space: false, single_op_with_same_effect: match,
      finding: match ? "a single operation reproduces the reference change's per-case waits" : `no single operation reproduces it; the reference is ${opts.reference.length} operations and the space holds single operations only`
    };
  }
  return {
    space_hash: space.hash, candidates: space.candidates, valid: space.entries.length, distinct_definitions: new Set(space.entries.map((e) => e.definition_hash)).size, invalid: space.invalid,
    validated: entries.length, passing: passing.length, passing_and_cutting: passing.filter((e) => e.best_cut >= threshold).length, cut_threshold_min: threshold,
    top: [...passing].sort((a, b) => b.best_cut - a.best_cut || (a.median_wait_delta ?? 0) - (b.median_wait_delta ?? 0)).slice(0, 5),
    reference, entries
  };
}
