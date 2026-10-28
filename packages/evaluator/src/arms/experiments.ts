import { externalSubLogHash, type ExternalSchedule } from "@hey-pisgah/simulator";
import { fencesHash, hashJson, permissionsHash, type Metric, type Operation, type RunMetrics, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { applyOperations, type Facts } from "@hey-pisgah/workflow";
import { expectedRulesHash, runCase } from "../pipeline.js";
import { keyedOrder, stream } from "./prng.js";
import { opKey, singleOperationSpace, SPACE_RULE } from "./space.js";
import type { ArmCase } from "./run.js";

// An experiment as the baselines draw it: operations on the base and discovery case ids, no hypothesis.
export type DrawnExperiment = { index: number; ops: Operation[]; case_ids: string[] };
export const A4_SEED = "a4-order-1";
export const A4_EXPERIMENTS = 8;
export const RANDOM_SEED = "random-experiments-1";
export const FUZZ_SEED = "fuzz-1";

const caseList = (seed: string, ids: readonly string[], n: number) => keyedOrder(seed, ids, (x) => x).slice(0, n).sort();

// A4: the published single-operation space in one committed order; the first eight are the arm's experiments, six cases each.
export function a4Order(base: WD, discovery: readonly { case_id: string; facts: Facts }[]) {
  const space = singleOperationSpace(base, discovery.map((d) => d.facts));
  const order = keyedOrder(A4_SEED, space.entries.map((e) => e.op), opKey);
  const ids = discovery.map((d) => d.case_id);
  const experiments: DrawnExperiment[] = order.slice(0, A4_EXPERIMENTS).map((op, i) => ({ index: i, ops: [op], case_ids: caseList(`${A4_SEED}|cases|${i}`, ids, 6) }));
  return { space_hash: space.hash, order, experiments };
}

export function a4CommitmentBody(base: WD, discovery: readonly { case_id: string; facts: Facts }[]): Record<string, unknown> {
  const a = a4Order(base, discovery);
  return { artifact: "a4", seed: A4_SEED, space_rule: [...SPACE_RULE], space_hash: a.space_hash, base_definition_hash: base.definition_hash, order_hash: hashJson(a.order), experiments: a.experiments };
}

// Draws valid operation sequences of one to three operations from the space; a combination that does not apply is redrawn.
export function randomValidSequences(base: WD, caseFacts: readonly Facts[], n: number, seed: string): { sequences: Operation[][]; redraws: number } {
  const space = singleOperationSpace(base, caseFacts).entries.map((e) => e.op);
  const r = stream(seed);
  const sequences: Operation[][] = [];
  let redraws = 0;
  while (sequences.length < n) {
    const k = r.int(1, 3);
    const ops = Array.from({ length: k }, () => r.pick(space));
    if (applyOperations(base, ops, { caseFacts }).ok) sequences.push(ops);
    else redraws += 1;
    if (redraws > n * 50) throw new Error("the space yields too few valid combinations");
  }
  return { sequences, redraws };
}

// The 30 random experiments for the prediction-check baseline: random valid operations on one to six discovery cases.
export function randomExperiments(base: WD, discovery: readonly { case_id: string; facts: Facts }[], n = 30, seed = RANDOM_SEED): DrawnExperiment[] {
  const { sequences } = randomValidSequences(base, discovery.map((d) => d.facts), n, seed);
  const r = stream(`${seed}|cases`);
  return sequences.map((ops, i) => ({ index: i, ops, case_ids: caseList(`${seed}|cases|${i}`, discovery.map((d) => d.case_id), r.int(1, 6)) }));
}

export type MatchedCase = { case_id: string; control: RunMetrics | null; intervention: RunMetrics | null; sublog_equal: boolean; aborted: boolean };

// Runs control and intervention on the same schedule, as the experiment tool does, with no model in the loop.
export function runMatched(base: WD, ops: readonly Operation[], schedules: readonly ExternalSchedule[], caseFacts: readonly Facts[]): { ok: true; cases: MatchedCase[] } | { ok: false; error: string } {
  const r = applyOperations(base, ops, { caseFacts });
  if (!r.ok) return { ok: false, error: r.errors[0]?.code ?? "invalid" };
  return {
    ok: true,
    cases: schedules.map((s) => {
      const a = runCase(base, s), b = runCase(r.definition, s);
      const ok = a.outcome === "ok" && b.outcome === "ok";
      return { case_id: s.case_id, control: a.outcome === "ok" ? a.metrics : null, intervention: b.outcome === "ok" ? b.metrics : null, sublog_equal: ok && externalSubLogHash(a.events) === externalSubLogHash(b.events), aborted: !ok };
    })
  };
}

export type FuzzReport = { seed: string; sequences: number; redraws: number; runs: number; aborted: number; sublog_mismatch: number; fences_changed: number; prohibited_executed: number; hash_drift: number; green: boolean };

// Random-valid-operation fuzzing: every drawn sequence runs on a drawn case and must keep fences, permissions, the external world, the hashes and the prohibited count.
export function fuzz(base: WD, cases: readonly ArmCase[], caseFacts: readonly Facts[], n = 200, seed = FUZZ_SEED): FuzzReport {
  const { sequences, redraws } = randomValidSequences(base, caseFacts, n, seed);
  const r = stream(`${seed}|case`);
  const out = { aborted: 0, sublog_mismatch: 0, fences_changed: 0, prohibited_executed: 0, hash_drift: 0 };
  for (const ops of sequences) {
    const c = r.pick(cases);
    const applied = applyOperations(base, ops, { caseFacts });
    if (!applied.ok) continue;
    if (fencesHash(applied.definition) !== fencesHash(base) || permissionsHash(applied.definition) !== permissionsHash(base)) out.fences_changed += 1;
    const a = runCase(base, c.schedule), b = runCase(applied.definition, c.schedule);
    if (b.rules_hash !== expectedRulesHash(c.schedule) || b.schedule_hash !== c.schedule_hash) out.hash_drift += 1;
    if (a.outcome !== "ok" || b.outcome !== "ok") { out.aborted += 1; continue; }
    if (externalSubLogHash(a.events) !== externalSubLogHash(b.events)) out.sublog_mismatch += 1;
    out.prohibited_executed += b.metrics.prohibited_executed;
  }
  const green = Object.values(out).every((v) => v === 0);
  return { seed, sequences: sequences.length, redraws, runs: sequences.length, ...out, green };
}

export type OracleNote = { response_by_family: Record<string, string[]>; mixes_differing_response: boolean; note: string };
const responseOf = (d: number | null) => (d === null ? "no_wait" : d <= -30 ? "large_cut" : d >= 10 ? "worse" : Math.abs(d) < 10 ? "under_10" : "moderate_cut");

// The evaluator-only external note: whether an experiment's cases mix families whose response to the change differs, read from matched runs.
export function oracleNote(cases: readonly MatchedCase[], familyOf: (caseId: string) => string, metric: Metric = "post_signoff_wait_min"): OracleNote {
  const by: Record<string, Set<string>> = {};
  for (const c of cases) {
    const a = c.control?.[metric], b = c.intervention?.[metric];
    const d = typeof a === "number" && typeof b === "number" ? b - a : null;
    (by[familyOf(c.case_id)] ??= new Set()).add(responseOf(d));
  }
  const response_by_family = Object.fromEntries(Object.entries(by).sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, s]) => [f, [...s].sort()]));
  const distinct = new Set(Object.values(response_by_family).map((x) => x.join("+")));
  const mixes = Object.keys(response_by_family).length > 1 && distinct.size > 1;
  return { response_by_family, mixes_differing_response: mixes, note: mixes ? "the cases mix families whose response to this change differs" : "the cases do not mix families with differing responses" };
}
