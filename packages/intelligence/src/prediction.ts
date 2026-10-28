import type { HypothesisRecord, Metric, PredictionCheck } from "@hey-pisgah/contracts";
import { evalCondition, type Facts } from "@hey-pisgah/workflow";

type Prediction = HypothesisRecord["if_true"];
export type Interval = { lo: number; hi: number };

// The interval of intervention minus control a prediction allows; a strict direction needs at least one unit.
export function interval(p: Prediction): Interval {
  const t = p.tolerance_min;
  if (p.comparison === "intervention_lt_control") return { lo: -Infinity, hi: -Math.max(t, 1) };
  if (p.comparison === "intervention_gt_control") return { lo: Math.max(t, 1), hi: Infinity };
  return { lo: -t, hi: t };
}

export const disjoint = (a: Interval, b: Interval): boolean => a.hi < b.lo || b.hi < a.lo;

// The experiment cases a prediction is about: its listed cases, or the cases whose facts satisfy its condition.
export function scopedCases(p: Prediction, caseIds: readonly string[], factsOf: (id: string) => Facts | null): string[] {
  if ("cases" in p.scope) {
    const listed = new Set(p.scope.cases);
    return caseIds.filter((c) => listed.has(c));
  }
  const cond = p.scope.condition;
  return caseIds.filter((c) => { const f = factsOf(c); return f !== null && evalCondition(cond, f); });
}

// Deltas per case and metric: intervention minus control, null when either arm did not observe the metric.
export type Deltas = Record<string, Partial<Record<Metric, number | null>>>;

// Which active hypotheses an experiment speaks to and which pairs of them it can tell apart, computed before it runs.
export function checkBefore(hs: readonly HypothesisRecord[], caseIds: readonly string[], factsOf: (id: string) => Facts | null): PredictionCheck["before"] {
  const speaks = hs.filter((h) => scopedCases(h.if_true, caseIds, factsOf).length > 0 || scopedCases(h.if_false, caseIds, factsOf).length > 0);
  const pairs: [string, string][] = [];
  for (let i = 0; i < speaks.length; i++) {
    for (let j = i + 1; j < speaks.length; j++) {
      const a = speaks[i]!.if_true;
      const b = speaks[j]!.if_true;
      if (a.metric !== b.metric) continue;
      const sa = new Set(scopedCases(a, caseIds, factsOf));
      const shared = scopedCases(b, caseIds, factsOf).some((c) => sa.has(c));
      if (shared && disjoint(interval(a), interval(b))) pairs.push([speaks[i]!.hypothesis_id, speaks[j]!.hypothesis_id]);
    }
  }
  return { speaks_to: speaks.map((h) => h.hypothesis_id), distinguishes: pairs };
}

// True or false when the prediction was observed on at least one of its cases, null when it was not observed at all.
export function holds(p: Prediction, caseIds: readonly string[], deltas: Deltas, factsOf: (id: string) => Facts | null): boolean | null {
  const iv = interval(p);
  const observed = scopedCases(p, caseIds, factsOf).flatMap((c) => {
    const d = deltas[c]?.[p.metric];
    return d === null || d === undefined ? [] : [d];
  });
  if (!observed.length) return null;
  return observed.every((d) => d >= iv.lo && d <= iv.hi);
}

// Where each spoken-to hypothesis landed after the run; inconclusive covers neither, both, or an unobserved metric.
export function checkAfter(hs: readonly HypothesisRecord[], before: PredictionCheck["before"], caseIds: readonly string[], deltas: Deltas, factsOf: (id: string) => Facts | null): NonNullable<PredictionCheck["after"]> {
  const per: Record<string, { landed: "if_true" | "if_false" | "inconclusive" }> = {};
  const contradicted: string[] = [];
  for (const id of before.speaks_to) {
    const h = hs.find((x) => x.hypothesis_id === id);
    if (!h) continue;
    const t = holds(h.if_true, caseIds, deltas, factsOf);
    const f = holds(h.if_false, caseIds, deltas, factsOf);
    per[id] = { landed: t === true && f !== true ? "if_true" : f === true && t !== true ? "if_false" : "inconclusive" };
    if (t === false) contradicted.push(id);
  }
  return { per_hypothesis: per, contradicted };
}
