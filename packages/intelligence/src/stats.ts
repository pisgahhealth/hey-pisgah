import type { SimEvent, WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { deriveDataIntegrityFences } from "@hey-pisgah/workflow";
import type { PoolCase } from "./pool.js";

type Row = Record<string, unknown>;
export type Segment = { from: string | null; to: string; wait_min: number; work_min: number; from_event_id: string | null; to_event_id: string };
export type CasePath = { case_id: string; signoff_at: number | null; departure_at: number | null; path: Segment[] };

// Every step whose completion can hold another step back: start edges, complete edges, derived gates and after predicates in triggers.
export function predecessors(def: WD): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>(def.steps.map((s) => [s.step_id, new Set<string>()]));
  const add = (to: string, from: string) => out.get(to)?.add(from);
  for (const e of def.edges) add(e.to.step, e.from.step);
  for (const d of deriveDataIntegrityFences(def)) add(d.to.step, d.from.step);
  const leaves = (p: unknown): string[] => {
    const q = p as Record<string, unknown>;
    if (q && typeof q === "object" && "after" in q) return [String((q.after as { step: string }).step)];
    if (q && typeof q === "object" && ("all_of" in q || "any_of" in q)) return ((q.all_of ?? q.any_of) as unknown[]).flatMap(leaves);
    return [];
  };
  for (const t of def.triggers) for (const s of leaves(t.when)) add(t.target.step, s);
  return out;
}

type Times = { start: number; done: number; started_id: string | null; done_id: string };

// First start and first completion of each step in one event log, on the occurred clock.
export function stepTimes(events: readonly SimEvent[]): Map<string, Times> {
  const started = new Map<string, SimEvent>();
  const out = new Map<string, Times>();
  for (const e of events) {
    const id = e.subject;
    if (!id) continue;
    if (e.kind === "step.started" && !started.has(id)) started.set(id, e);
    if (e.kind === "step.completed" && !out.has(id)) {
      const s = started.get(id);
      out.set(id, { start: s ? s.occurred_at : e.occurred_at, done: e.occurred_at, started_id: s?.event_id ?? null, done_id: e.event_id });
    }
  }
  return out;
}

// The chain of latest-finishing predecessors from departure back to the clinical sign-off, read from one case's events.
export function criticalPath(def: WD, events: readonly SimEvent[], marks = { signoff: "st05", departure: "st16" }): CasePath & { case_id: string } {
  const times = stepTimes(events);
  const preds = predecessors(def);
  const dep = times.get(marks.departure);
  const sign = times.get(marks.signoff);
  const path: Segment[] = [];
  let cur = dep ? marks.departure : null;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const t = times.get(cur)!;
    let best: string | null = null;
    for (const p of preds.get(cur) ?? []) {
      const pt = times.get(p);
      if (!pt || pt.done > t.done) continue;
      if (best === null || pt.done > times.get(best)!.done) best = p;
    }
    const from = best ? times.get(best)! : null;
    path.push({ from: best, to: cur, wait_min: Math.max(0, t.start - (from?.done ?? t.start)), work_min: t.done - t.start, from_event_id: from?.done_id ?? null, to_event_id: t.done_id });
    if (cur === marks.signoff || !best) break;
    cur = best;
  }
  return { case_id: events[0]?.case_id ?? "", signoff_at: sign?.done ?? null, departure_at: dep?.done ?? null, path: path.reverse() };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const y = [...xs].sort((a, b) => a - b);
  const m = Math.floor(y.length / 2);
  return y.length % 2 ? y[m]! : (y[m - 1]! + y[m]!) / 2;
};

export type RankedSegment = { segment: string; from: string | null; to: string; cases: number; total_wait_min: number; median_wait_min: number | null; total_work_min: number; after_signoff: number; example_events: { event_id: string; case_id: string }[] };

// Per-step waiting, critical-path membership and the ranking of critical segments after the sign-off, over every case in the pool.
export function derivedStatistics(def: WD, cases: readonly PoolCase[], top = 8): Row {
  const paths = cases.map((c) => ({ c, p: criticalPath(def, c.events) }));
  const perStep = new Map<string, { wait: number[]; work: number[]; on_path: number }>();
  const seg = new Map<string, RankedSegment>();
  for (const { c, p } of paths) {
    const times = stepTimes(c.events);
    const preds = predecessors(def);
    for (const [step, t] of times) {
      const ready = Math.max(-Infinity, ...[...(preds.get(step) ?? [])].map((q) => times.get(q)?.done ?? -Infinity));
      const row = perStep.get(step) ?? { wait: [], work: [], on_path: 0 };
      if (Number.isFinite(ready)) row.wait.push(Math.max(0, t.start - ready));
      row.work.push(t.done - t.start);
      perStep.set(step, row);
    }
    for (const s of p.path) {
      perStep.get(s.to)!.on_path += 1;
      if (s.from === null) continue;
      const key = `${s.from}>${s.to}`;
      const r = seg.get(key) ?? { segment: key, from: s.from, to: s.to, cases: 0, total_wait_min: 0, median_wait_min: null, total_work_min: 0, after_signoff: 0, example_events: [] };
      r.cases += 1;
      r.total_wait_min += s.wait_min;
      r.total_work_min += s.work_min;
      if (p.signoff_at !== null && (s.from_event_id ? c.events.find((e) => e.event_id === s.from_event_id)!.occurred_at >= p.signoff_at : false)) r.after_signoff += 1;
      if (r.example_events.length < 4) r.example_events.push({ event_id: s.to_event_id, case_id: c.case_id });
      seg.set(key, r);
    }
  }
  for (const r of seg.values()) {
    const waits = paths.flatMap(({ p }) => p.path.filter((s) => s.from === r.from && s.to === r.to).map((s) => s.wait_min));
    r.median_wait_min = median(waits);
  }
  const ranking = [...seg.values()].sort((a, b) => b.total_wait_min + b.total_work_min - (a.total_wait_min + a.total_work_min) || a.segment.localeCompare(b.segment)).slice(0, top);
  return {
    cases: cases.length,
    note_on_method: "Critical path: from departure back to the clinical sign-off, each step's latest-finishing predecessor in the definition (edges, derived gates and trigger after-steps); wait is predecessor completion to start, work is start to completion, occurred clock.",
    per_step: Object.fromEntries([...perStep.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { cases: v.work.length, median_wait_min: median(v.wait), median_work_min: median(v.work), on_critical_path: v.on_path }])),
    ranking: ranking.map((r, i) => ({ rank: i + 1, ...r })),
    paths: paths.map(({ p }) => ({ case_id: p.case_id, signoff_at: p.signoff_at, departure_at: p.departure_at, path: p.path.map((s) => `${s.from ?? "-"}>${s.to} wait ${s.wait_min} work ${s.work_min}`) }))
  };
}
