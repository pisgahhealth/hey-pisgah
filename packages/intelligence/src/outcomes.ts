import type { SimEvent, WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import type { DiscoveryPool, OutcomeCase, PoolCase } from "./pool.js";

// One case's figures read from its own events: the wait from the clinical sign-off to departure, and how many document revisions it took.
export type CaseFigures = { post_signoff_wait_min: number | null; rework_events: number };
export type OutcomeRow = CaseFigures & { case_id: string; ward_id: string; source: "outcome"; workflow_version: number | null; before_median_wait_min: number | null; wait_delta_min: number | null; before_median_rework: number | null; rework_delta: number | null; direction: "better" | "worse" | "unchanged" | "unknown" };
export type ObservedRow = { case_id: string; ward_id: string; source: "observed"; events: number; steps_observed: number; signoff_to_cleared_min: number | null };
export type BeforeRow = { ward_id: string; histories: number; median_post_signoff_wait_min: number | null; median_rework_events: number | null };
// Before and after adoption, side by side: the histories each ward had, the verified outcomes under a version, and the observed journeys.
export type OutcomeComparison = {
  base_version: number; before: BeforeRow[]; after: OutcomeRow[]; observed: ObservedRow[];
  // True when an outcome under a version other than the base did worse than the histories of its ward.
  contradicts_adopted: boolean; supports_adopted: boolean; read_case_ids: string[];
};

const median = (xs: readonly number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

export function caseFigures(def: WD, events: readonly SimEvent[]): CaseFigures {
  const signoff = new Set(def.steps.filter((s) => s.produces.includes("signoff_record" as never)).map((s) => s.step_id));
  const departure = new Set(def.steps.filter((s) => s.action_kind === "record_departure").map((s) => s.step_id));
  const first = (ids: Set<string>) => events.filter((e) => e.kind === "step.completed" && ids.has(String(e.subject))).map((e) => e.occurred_at).sort((a, b) => a - b)[0];
  const a = first(signoff), b = first(departure);
  return { post_signoff_wait_min: a !== undefined && b !== undefined && b >= a ? b - a : null, rework_events: events.filter((e) => e.kind === "document.revised").length };
}

// The comparison the second cycle reads first; it uses only the pool's own events and the version each outcome ran under.
export function outcomeComparison(pool: DiscoveryPool, def: WD): OutcomeComparison {
  const cases = pool.ids().map((id) => pool.get(id)!);
  const histories = cases.filter((c) => c.source === "history");
  const fig = new Map(histories.map((c) => [c.case_id, caseFigures(def, c.events)]));
  const wards = [...new Set(histories.map((c) => c.ward_id))].sort();
  const beforeOf = (hs: readonly PoolCase[]) => ({ histories: hs.length, median_post_signoff_wait_min: median(hs.map((h) => fig.get(h.case_id)!.post_signoff_wait_min).filter((x): x is number => x !== null)), median_rework_events: median(hs.map((h) => fig.get(h.case_id)!.rework_events)) });
  const before: BeforeRow[] = wards.map((w) => ({ ward_id: w, ...beforeOf(histories.filter((h) => h.ward_id === w)) }));
  const all = beforeOf(histories);
  const after: OutcomeRow[] = cases.filter((c) => c.source === "outcome").map((c) => {
    const f = caseFigures(def, c.events);
    const b = before.find((x) => x.ward_id === c.ward_id && x.histories > 0) ?? { ward_id: c.ward_id, ...all };
    const dw = f.post_signoff_wait_min !== null && b.median_post_signoff_wait_min !== null ? f.post_signoff_wait_min - b.median_post_signoff_wait_min : null;
    const dr = b.median_rework_events !== null ? f.rework_events - b.median_rework_events : null;
    const direction = dw === null ? "unknown" : dw < 0 ? "better" : dw > 0 ? "worse" : "unchanged";
    return { case_id: c.case_id, ward_id: c.ward_id, source: "outcome", workflow_version: c.workflow_version ?? null, ...f, before_median_wait_min: b.median_post_signoff_wait_min, wait_delta_min: dw, before_median_rework: b.median_rework_events, rework_delta: dr, direction };
  });
  const observed: ObservedRow[] = cases.filter((c) => c.source === "observed").map((c) => {
    const at = (step: string) => c.events.find((e) => e.kind === "step.observed" && e.subject === step)?.occurred_at;
    const a = at("st05"), b = at("st13");
    return { case_id: c.case_id, ward_id: c.ward_id, source: "observed", events: c.events.length, steps_observed: new Set(c.events.filter((e) => e.kind === "step.observed").map((e) => e.subject)).size, signoff_to_cleared_min: a !== undefined && b !== undefined && b >= a ? b - a : null };
  });
  const adopted = after.filter((r) => r.workflow_version !== null && r.workflow_version !== def.version);
  return {
    base_version: def.version, before, after, observed,
    contradicts_adopted: adopted.some((r) => r.direction === "worse"), supports_adopted: adopted.length > 0 && adopted.every((r) => r.direction === "better"),
    read_case_ids: [...after.map((r) => r.case_id), ...observed.map((r) => r.case_id)]
  };
}

// Counter-evidence for the test the review asks for: each outcome's departure and everything after it moves so its wait lands as far above its ward's histories as it was below them.
export function reverseOutcomes(outcomes: readonly OutcomeCase[], pool: DiscoveryPool, def: WD): OutcomeCase[] {
  const cmp = outcomeComparison(pool, def);
  return outcomes.map((o) => {
    const f = caseFigures(def, o.events);
    const b = (cmp.before.find((x) => x.ward_id === o.ward_id && x.histories > 0) ?? null)?.median_post_signoff_wait_min ?? null;
    if (f.post_signoff_wait_min === null || b === null || f.post_signoff_wait_min >= b) return o;
    const shift = Math.round(2 * (b - f.post_signoff_wait_min));
    const departs = Math.max(...o.events.filter((e) => e.kind === "step.completed" && def.steps.some((s) => s.step_id === e.subject && s.action_kind === "record_departure")).map((e) => e.occurred_at));
    return { ...o, events: o.events.map((e) => (e.occurred_at >= departs ? { ...e, occurred_at: e.occurred_at + shift, recorded_at: e.recorded_at + shift } : e)) };
  });
}
