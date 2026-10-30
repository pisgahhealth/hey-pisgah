type Row = Record<string, unknown>;
type CaseRow = { case_id: string; in_scope: boolean; delta: { post_signoff_wait_min: number | null; rework_min: number | null } };

// The lower median, the same one the dev gate's summary reports.
const median = (xs: number[]): number | null => { if (!xs.length) return null; const y = [...xs].sort((a, b) => a - b); return y[Math.floor((y.length - 1) / 2)]!; };

// The adopted version's per-case wait and rework changes on the dev cases, read from the gate's stored report and never re-run.
export function devDistribution(report: { proposal_id?: string | null; status?: string; cases: CaseRow[] }): Row {
  const waits = report.cases.map((c) => c.delta.post_signoff_wait_min ?? 0);
  const moved = report.cases.filter((c) => (c.delta.post_signoff_wait_min ?? 0) !== 0);
  return {
    proposal_id: report.proposal_id ?? null, status: report.status ?? null,
    cases: report.cases.length, in_scope: report.cases.filter((c) => c.in_scope).length,
    median_wait_delta_min: median(waits), moved: moved.length,
    shorter: moved.filter((c) => c.delta.post_signoff_wait_min! < 0).length, longer: moved.filter((c) => c.delta.post_signoff_wait_min! > 0).length,
    wait_deltas_min: report.cases.map((c) => ({ case_id: c.case_id, in_scope: c.in_scope, wait: c.delta.post_signoff_wait_min, rework: c.delta.rework_min })),
    rework_added_min: report.cases.reduce((n, c) => n + Math.max(0, c.delta.rework_min ?? 0), 0),
    source: "the dev gate's stored validation report for the adopted version, not re-run"
  };
}

// The flat fields the improve claim's wording reads, beside the fresh-case figure.
export function devFields(dist: Row): Row {
  const longest = Math.max(0, ...((dist["wait_deltas_min"] as { wait: number | null }[] | undefined) ?? []).map((x) => x.wait ?? 0));
  return { dev_cases: dist["cases"], dev_median_wait_delta_min: dist["median_wait_delta_min"], dev_moved: dist["moved"], dev_shorter: dist["shorter"], dev_longer: dist["longer"], dev_slowest_min: longest };
}
