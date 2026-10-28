import type { HypothesisRecord, Metric, PredictionCheck, RunMetrics } from "@hey-pisgah/contracts";
import { evalCondition, type Facts } from "@hey-pisgah/workflow";

type Prediction = HypothesisRecord["if_true"];
type Interval = { lo: number; loOpen: boolean; hi: number; hiOpen: boolean };
export type CaseResult = { case_id: string; facts: Facts; control: RunMetrics | null; intervention: RunMetrics | null };
export type CheckHypothesis = Pick<HypothesisRecord, "hypothesis_id" | "if_true" | "if_false">;

// The interval of intervention minus control that a prediction allows.
export function interval(p: Prediction): Interval {
  const t = p.tolerance_min;
  if (p.comparison === "intervention_lt_control") return { lo: -Infinity, loOpen: true, hi: -t, hiOpen: true };
  if (p.comparison === "intervention_gt_control") return { lo: t, loOpen: true, hi: Infinity, hiOpen: true };
  return { lo: -t, loOpen: false, hi: t, hiOpen: false };
}
const inside = (x: number, i: Interval) => (i.loOpen ? x > i.lo : x >= i.lo) && (i.hiOpen ? x < i.hi : x <= i.hi);
export function disjoint(a: Interval, b: Interval): boolean {
  const [l, r] = a.lo <= b.lo ? [a, b] : [b, a];
  return l.hi < r.lo || (l.hi === r.lo && (l.hiOpen || r.loOpen));
}

const casesOf = (p: Prediction, ids: readonly string[], facts: (id: string) => Facts | undefined) =>
  ids.filter((id) => ("cases" in p.scope ? p.scope.cases.includes(id) : facts(id) !== undefined && evalCondition(p.scope.condition, facts(id)!)));

// The app-side check before a run: which hypotheses the experiment speaks to and which pairs its cases can tell apart.
export function predictionBefore(hs: readonly CheckHypothesis[], caseIds: readonly string[], facts: (id: string) => Facts | undefined): PredictionCheck["before"] {
  const speaks = hs.filter((h) => casesOf(h.if_true, caseIds, facts).length > 0 || casesOf(h.if_false, caseIds, facts).length > 0).map((h) => h.hypothesis_id);
  const pairs: [string, string][] = [];
  for (const [i, a] of hs.entries()) for (const b of hs.slice(i + 1)) {
    if (a.if_true.metric !== b.if_true.metric) continue;
    const shared = casesOf(a.if_true, caseIds, facts).filter((id) => casesOf(b.if_true, caseIds, facts).includes(id));
    if (shared.length && disjoint(interval(a.if_true), interval(b.if_true))) pairs.push([a.hypothesis_id, b.hypothesis_id]);
  }
  return { speaks_to: speaks, distinguishes: pairs };
}

const median = (xs: number[]) => { const y = [...xs].sort((a, b) => a - b); return y.length ? y[Math.floor((y.length - 1) / 2)]! : null; };
function observed(p: Prediction, results: readonly CaseResult[]): number | null {
  const ids = casesOf(p, results.map((r) => r.case_id), (id) => results.find((r) => r.case_id === id)?.facts);
  const ds = results.filter((r) => ids.includes(r.case_id)).map((r) => {
    const a = r.control?.[p.metric as Metric & keyof RunMetrics], b = r.intervention?.[p.metric as Metric & keyof RunMetrics];
    return typeof a === "number" && typeof b === "number" ? b - a : null;
  }).filter((x): x is number => x !== null);
  return median(ds);
}

// The check after a run: where each hypothesis landed, with inconclusive when neither or both predictions hold or the metric was not seen.
export function predictionAfter(hs: readonly CheckHypothesis[], results: readonly CaseResult[]): NonNullable<PredictionCheck["after"]> {
  const per: Record<string, { landed: "if_true" | "if_false" | "inconclusive" }> = {};
  for (const h of hs) {
    const t = observed(h.if_true, results), f = observed(h.if_false, results);
    const holdsT = t !== null && inside(t, interval(h.if_true)), holdsF = f !== null && inside(f, interval(h.if_false));
    per[h.hypothesis_id] = { landed: holdsT && !holdsF ? "if_true" : holdsF && !holdsT ? "if_false" : "inconclusive" };
  }
  return { per_hypothesis: per, contradicted: Object.entries(per).filter(([, v]) => v.landed === "if_false").map(([k]) => k).sort() };
}

export type CheckedExperiment = { label: string; before: PredictionCheck["before"]; after: PredictionCheck["after"] };
export type PredictionSummary = { source: string; experiments: number; distinguishing: number; speaking: number; landed_if_true: number; contradicted: number; inconclusive: number };

export function summariseChecks(source: string, xs: readonly CheckedExperiment[]): PredictionSummary {
  const landed = xs.flatMap((x) => Object.values(x.after?.per_hypothesis ?? {}).map((v) => v.landed));
  return {
    source, experiments: xs.length, distinguishing: xs.filter((x) => x.before.distinguishes.length > 0).length, speaking: xs.filter((x) => x.before.speaks_to.length > 0).length,
    landed_if_true: landed.filter((l) => l === "if_true").length, contradicted: landed.filter((l) => l === "if_false").length, inconclusive: landed.filter((l) => l === "inconclusive").length
  };
}
