import type { ArmRow } from "./arms/run.js";

export const PRIMARY_ARMS = ["A0", "A1", "A2", "A2a", "A3", "A4", "A-prior"] as const;
export type Cost = { usd: { discovery: number; experiments: number; repairs: number; execution: number }; calls: number; latency_p50_ms: number | null } | null;
export type PrimaryRow = {
  arm: string; status: "measured" | "equals_A0" | "not_run"; note: string | null; n: number; pass: number; required_step_pct: number | null;
  prohibited_attempted: number; prohibited_executed: number; planned_checks: number; unplanned_interventions: number; unnecessary_docs: number;
  duplicates: number; stale: number; rework_events: number; rework_min: number; wait_median_min: number | null; wait_p90_min: number | null;
  bed_release_median_min: number | null; cost: Cost; decided_by: { model: number; runtime: number; person: number };
};

const q = (xs: number[], f: number) => { const y = [...xs].sort((a, b) => a - b); return y.length ? y[Math.min(y.length - 1, Math.ceil(f * y.length) - 1)]! : null; };
export const median = (xs: number[]) => { const y = [...xs].sort((a, b) => a - b); return y.length ? y[Math.floor((y.length - 1) / 2)]! : null; };
const nums = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => typeof x === "number");

// One primary-table row over an arm's per-case rows; simulated minutes throughout.
export function primaryRow(arm: string, rows: readonly ArmRow[] | null, o: { status?: PrimaryRow["status"]; note?: string | null; cost?: Cost } = {}): PrimaryRow {
  const r = rows ?? [];
  const m = r.map((x) => x.metrics).filter((x) => x !== null);
  const sum = (f: (x: NonNullable<ArmRow["metrics"]>) => number) => m.reduce((s, x) => s + f(x), 0);
  const req = sum((x) => x.required_steps_total);
  const waits = nums(m.map((x) => x.post_signoff_wait_min));
  return {
    arm, status: rows === null ? "not_run" : o.status ?? "measured", note: o.note ?? null, n: r.length, pass: r.filter((x) => x.pass).length,
    required_step_pct: req ? Math.round((1000 * sum((x) => x.required_steps_done)) / req) / 10 : null,
    prohibited_attempted: sum((x) => x.prohibited_attempted), prohibited_executed: sum((x) => x.prohibited_executed), planned_checks: sum((x) => x.planned_checks),
    unplanned_interventions: sum((x) => x.unplanned_interventions), unnecessary_docs: sum((x) => x.unnecessary_docs), duplicates: sum((x) => x.duplicates),
    stale: sum((x) => x.stale_actions), rework_events: sum((x) => x.rework_events), rework_min: sum((x) => x.rework_min),
    wait_median_min: median(waits), wait_p90_min: q(waits, 0.9), bed_release_median_min: median(nums(m.map((x) => x.bed_release_delay_min))),
    cost: o.cost ?? null,
    decided_by: r.reduce((s, x) => ({ model: s.model + (x.decided_by?.model ?? 0), runtime: s.runtime + (x.decided_by?.runtime ?? 0), person: s.person + (x.decided_by?.person ?? 0) }), { model: 0, runtime: 0, person: 0 })
  };
}

// Exact two-sided sign test over wins and losses; ties are dropped, as the plan states.
export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let c = 1, tail = 0;
  for (let i = 0; i <= k; i++) { tail += c; c = (c * (n - i)) / (i + 1); }
  return Math.min(1, (2 * tail) / 2 ** n);
}

export type PairedMetric = "post_signoff_wait_min" | "rework_min" | "unnecessary_docs" | "bed_release_delay_min";
export type PairedRow = { arm: string; metric: PairedMetric; n: number; wins: number; ties: number; losses: number; sign_test_p: number; small_n: boolean };

// Paired against A1 case by case; lower is better on every metric listed.
export function pairedVsA1(arm: string, rows: readonly ArmRow[], a1: readonly ArmRow[], metric: PairedMetric): PairedRow {
  const by = new Map(a1.map((r) => [r.case_id, r]));
  let wins = 0, ties = 0, losses = 0;
  for (const r of rows) {
    const x = r.metrics?.[metric], y = by.get(r.case_id)?.metrics?.[metric];
    if (typeof x !== "number" || typeof y !== "number") continue;
    if (x < y) wins += 1; else if (x > y) losses += 1; else ties += 1;
  }
  const n = wins + ties + losses;
  return { arm, metric, n, wins, ties, losses, sign_test_p: Math.round(signTest(wins, losses) * 10000) / 10000, small_n: wins + losses < 10 };
}

// A plain markdown table; null renders as a dash.
export function markdownTable(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const cell = (v: unknown) => (v === null || v === undefined ? "-" : typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/\|/g, "/");
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

export function primaryMarkdown(rows: readonly PrimaryRow[]): string {
  return markdownTable(
    ["Arm", "Status", "Cases", "Pass", "Required steps %", "Prohibited attempted", "Prohibited executed", "Planned checks", "Unplanned", "Unnecessary docs", "Duplicates", "Stale", "Rework (events, min)", "Wait median (sim min)", "Wait p90 (sim min)", "Bed release median (sim min)", "Model cost USD", "Decided by (model, runtime, person)"],
    rows.map((r) => r.status === "not_run" ? [r.arm, r.status, ...Array(16).fill(null)] : [r.arm, r.status, r.n, r.pass, r.required_step_pct, r.prohibited_attempted, r.prohibited_executed, r.planned_checks, r.unplanned_interventions, r.unnecessary_docs, r.duplicates, r.stale, `${r.rework_events}, ${r.rework_min}`, r.wait_median_min, r.wait_p90_min, r.bed_release_median_min,
      r.cost ? Math.round(100 * (r.cost.usd.discovery + r.cost.usd.experiments + r.cost.usd.repairs + r.cost.usd.execution)) / 100 : null, `${r.decided_by.model}, ${r.decided_by.runtime}, ${r.decided_by.person}`])
  );
}
