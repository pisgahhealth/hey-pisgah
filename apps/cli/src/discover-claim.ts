import { readFileSync, writeFileSync } from "node:fs";

type Row = Record<string, unknown>;
type Run = { run_id: string; outcome: string; commitment?: { revision?: number }; needs?: { deny_list?: boolean }; proposal_shares?: { proposal_id: string; share_of_planted?: number }[]; variant?: string };

// The answer-invariance gate exists from this commitment revision on; runs before it cannot count for the discovery claim.
export const INVARIANCE_FROM_REVISION = 10;

// Adds the discovery claim's summary to discovery.json from the runs already in it; nothing is re-scored and the runs are untouched.
export function discoverSummary(d: Row, o: { invariancePass: boolean; adopted: string | null; tradeOffs: { metric: string; sum_delta: number }[] }): Row {
  const a = d["adaptive_runs"] as Row;
  const groups = ["runs", "cycle_runs", "variant_runs", "rev11_runs", "rev12_runs"].map((k) => a[k]).filter(Boolean);
  const runs = groups.flatMap((g) => (Array.isArray(g) ? g : ((g as Row)["runs"] as Run[]) ?? [])) as Run[];
  const gated = runs.filter((r) => (r.commitment?.revision ?? 0) >= INVARIANCE_FROM_REVISION);
  const valid = (rs: Run[]) => rs.filter((r) => r.outcome === "dev_valid_proposal");
  const share = runs.flatMap((r) => r.proposal_shares ?? []).find((s) => s.proposal_id === o.adopted)?.share_of_planted ?? null;
  const delta = (m: string) => o.tradeOffs.find((t) => t.metric === m)?.sum_delta ?? null;
  return {
    discover_runs_listed: runs.length, discover_dev_valid_any: valid(runs).length,
    discover_runs: gated.length, discover_dev_valid: valid(gated).length, discover_invariance_from_revision: INVARIANCE_FROM_REVISION,
    discover_invariance_pass: o.invariancePass, discover_deny_clean: gated.every((r) => r.needs?.deny_list === true),
    discover_dev_valid_runs: valid(gated).map((r) => ({ run_id: r.run_id, revision: r.commitment?.revision ?? null, variant: r.variant ?? null })),
    discover_adopted: o.adopted, discover_share: share, discover_rework_events: delta("rework_events"), discover_rework_min: delta("rework_min"),
    discover_note: "Counts read from the runs already in this file; a change that helps at a stated cost, not the best change. The answer-invariance test is the one in the intelligence package, run on this commit."
  };
}

// npx tsx apps/cli/src/discover-claim.ts --file evaluation/results/discovery.json --invariance pass|fail --adopted p-x --trade-offs '[...]'
if (process.argv[1]?.endsWith("discover-claim.ts")) {
  const argv = process.argv.slice(2);
  const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const file = flag("file") ?? "evaluation/results/discovery.json";
  const d = JSON.parse(readFileSync(file, "utf8")) as Row;
  const s = discoverSummary(d, { invariancePass: flag("invariance") === "pass", adopted: flag("adopted") ?? null, tradeOffs: JSON.parse(flag("trade-offs") ?? "[]") });
  const kept = Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith("discover_")));
  writeFileSync(file, `${JSON.stringify({ ...kept, ...s }, null, 1)}\n`);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => k !== "discover_dev_valid_runs"))));
}
