import { readFileSync, writeFileSync } from "node:fs";

type Row = Record<string, unknown>;
type Run = { run_id: string; outcome: string; found_planted?: boolean; commitment?: { revision?: number }; needs?: { deny_list?: boolean }; proposal_shares?: { proposal_id: string; share_of_planted?: number }[]; variant?: string; effort?: string };

// The answer-invariance gate exists from this commitment revision on; runs before it cannot count for the discovery claim.
export const INVARIANCE_FROM_REVISION = 10;

// The world the hospital's records come from; its planted answer needs two operations, so it is the pair.
export const COMMITTED_WORLD = "pair";

// From this commitment revision the dev gate assesses extra rework against the per-case budget approved at adoption; earlier runs are not re-scored.
export const REWORK_BUDGET_FROM_REVISION = 15;

// What the answer-invariance test holds byte-identical across the three worlds, and what it leaves free to differ.
export const INVARIANCE_COVERS = "the instructions (system prompt, opening request, stage texts, app-written texts) and the tool interface (tool definitions per stage, precondition table, registries, statistics method, sweep rule)";
export const INVARIANCE_EXCLUDES = "the evidence (case records, statistics values, experiment and sweep results) and the workflow definition (steps, edges, triggers), which vary by world";

const OPS: Record<string, string> = { single: "one-operation", pair: "two-operation", triple: "three-operation" };

// Probability of at most k successes in n trials at rate p.
function binomCdf(k: number, n: number, p: number): number {
  let sum = 0;
  let choose = 1;
  for (let i = 0; i <= k; i++) {
    sum += choose * p ** i * (1 - p) ** (n - i);
    choose = (choose * (n - i)) / (i + 1);
  }
  return Math.min(1, sum);
}

// Bisects a function that falls as p rises, on [0, 1], for the point where it equals the target.
function solve(f: (p: number) => number, target: number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (f(mid) > target) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

// The exact (Clopper-Pearson) two-sided 95% interval for k successes in n runs.
export function exactInterval(k: number, n: number): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const lower = k === 0 ? 0 : solve((p) => binomCdf(k - 1, n, p), 0.975);
  const upper = k === n ? 1 : solve((p) => binomCdf(k, n, p), 0.025);
  return { lower, upper };
}

// The Wilson score 95% interval for k successes in n runs.
export function wilsonInterval(k: number, n: number): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const z = 1.959964, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lower: Math.max(0, c - h), upper: Math.min(1, c + h) };
}

// The effort whose configuration the claim's predicate reads; other efforts at the same revision are shown beside it.
export const CLAIM_EFFORT = "medium";

const round2 = (x: number) => Math.round(x * 100) / 100;
const worldOf = (r: Run) => r.variant ?? COMMITTED_WORLD;

// Groups runs by commitment revision, world and effort, with k of n dev-valid and its exact interval.
export function configurations(runs: Run[]): Row[] {
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const key = JSON.stringify([r.commitment?.revision ?? 0, worldOf(r), r.effort ?? "unknown"]);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].map(([key, rs]) => {
    const [revision, world, effort] = JSON.parse(key) as [number, string, string];
    const k = rs.filter((r) => r.outcome === "dev_valid_proposal").length;
    const ci = exactInterval(k, rs.length), w = wilsonInterval(k, rs.length);
    const planted = rs.filter((r) => r.found_planted === true).length, pw = wilsonInterval(planted, rs.length);
    return { revision, world, effort, runs: rs.length, dev_valid: k, rate: round2(k / rs.length), lower_95: round2(ci.lower), upper_95: round2(ci.upper), wilson_lower_95: round2(w.lower), wilson_upper_95: round2(w.upper), planted, planted_wilson_lower_95: round2(pw.lower), planted_wilson_upper_95: round2(pw.upper), run_ids: rs.map((r) => r.run_id) };
  }).sort((a, b) => a.revision - b.revision || String(a.world).localeCompare(String(b.world)) || String(a.effort).localeCompare(String(b.effort)));
}

const kOf = (cs: Row[], f: (c: Row) => boolean) => {
  const sel = cs.filter(f);
  return { k: sel.reduce((n, c) => n + Number(c["dev_valid"]), 0), n: sel.reduce((n, c) => n + Number(c["runs"]), 0) };
};

// Adds the discovery claim's summary to discovery.json from the runs already in it; nothing is re-scored and the runs are untouched.
export function discoverSummary(d: Row, o: { invariancePass: boolean; adopted: string | null; tradeOffs: { metric: string; sum_delta: number }[]; currentRevision?: number }): Row {
  const a = d["adaptive_runs"] as Row;
  const groups = ["runs", "cycle_runs", "variant_runs", "rev11_runs", "rev12_runs", "rev12_low_runs"].map((k) => a[k]).filter(Boolean);
  const runs = groups.flatMap((g) => (Array.isArray(g) ? g : ((g as Row)["runs"] as Run[]) ?? [])) as Run[];
  const summaryOnly = ((a["summary_only_runs"] as Row | undefined)?.["runs"] as Run[] | undefined) ?? [];
  const history = [...summaryOnly, ...runs];
  const gated = runs.filter((r) => (r.commitment?.revision ?? 0) >= INVARIANCE_FROM_REVISION);
  const valid = (rs: Run[]) => rs.filter((r) => r.outcome === "dev_valid_proposal");
  const share = runs.flatMap((r) => r.proposal_shares ?? []).find((s) => s.proposal_id === o.adopted)?.share_of_planted ?? null;
  const delta = (m: string) => o.tradeOffs.find((t) => t.metric === m)?.sum_delta ?? null;

  const configs = configurations(history);
  const latestRev = Math.max(...configs.filter((c) => c["world"] === COMMITTED_WORLD).map((c) => Number(c["revision"])));
  const latest = configs.filter((c) => c["world"] === COMMITTED_WORLD && c["revision"] === latestRev).sort((x, y) => Number(y["effort"] === CLAIM_EFFORT) - Number(x["effort"] === CLAIM_EFFORT) || Number(y["runs"]) - Number(x["runs"]))[0]!;
  const efforts = configs.filter((c) => c["world"] === COMMITTED_WORLD && c["revision"] === latestRev).sort((x, y) => Number(y === latest) - Number(x === latest));
  const low = efforts.find((c) => c["effort"] === "low") ?? null;
  const rowText = (c: Row) => `${String(c["effort"])} ${String(c["dev_valid"])} of ${String(c["runs"])} dev-valid (Wilson 95% ${String(c["wilson_lower_95"])} to ${String(c["wilson_upper_95"])}) and ${String(c["planted"])} of ${String(c["runs"])} the planted form (${String(c["planted_wilson_lower_95"])} to ${String(c["planted_wilson_upper_95"])})`;
  const byRevision = [...new Set(history.map((r) => r.commitment?.revision ?? 0))].sort((x, y) => x - y).map((rev) => {
    const rs = history.filter((r) => (r.commitment?.revision ?? 0) === rev);
    return { revision: rev, runs: rs.length, dev_valid: valid(rs).length, summary_only: rs.filter((r) => summaryOnly.includes(r)).length };
  });

  const rev9 = configs.filter((c) => c["revision"] === 9 && c["world"] === COMMITTED_WORLD);
  const high = kOf(rev9, (c) => c["effort"] === "high"), medium = kOf(rev9, (c) => c["effort"] === "medium");
  const variantRev = configs.filter((c) => c["revision"] === INVARIANCE_FROM_REVISION);
  const at = (w: string) => kOf(variantRev, (c) => c["world"] === w);
  const committed = configs.filter((c) => c["world"] === COMMITTED_WORLD && Number(c["dev_valid"]) > 0 && c["revision"] !== INVARIANCE_FROM_REVISION);
  const findings = [
    `Effort is a finding: at revision 9 on the committed world, high effort was ${high.k} of ${high.n} dev-valid against medium ${medium.k} of ${medium.n}, with the same tools, world and call cap.`,
    `Found on the ${OPS["single"]} variant (${at("single").k} of ${at("single").n}) and the ${OPS["triple"]} variant (${at("triple").k} of ${at("triple").n}) at revision ${INVARIANCE_FROM_REVISION}. The ${OPS["pair"]} world is the committed world, found there at ${committed.map((c) => `revision ${String(c["revision"])} (${String(c["dev_valid"])} of ${String(c["runs"])}, ${String(c["effort"])})`).join(" and ")}; the pair variant at revision ${INVARIANCE_FROM_REVISION} was ${at("pair").k} of ${at("pair").n}.`
  ];

  return {
    discover_history_runs: history.length, discover_history_dev_valid: valid(history).length, discover_history_by_revision: byRevision,
    discover_runs_listed: runs.length, discover_dev_valid_any: valid(runs).length,
    discover_runs: gated.length, discover_dev_valid: valid(gated).length, discover_invariance_from_revision: INVARIANCE_FROM_REVISION,
    discover_reconciliation: `${valid(history).length} of ${history.length} is the development history across commitment revisions, not a success rate: the ${runs.length} runs listed with full records here plus the ${summaryOnly.length} earlier runs kept only as summaries (adaptive_runs.summary_only_runs, ${valid(summaryOnly).length} dev-valid). ${valid(runs).length} of ${runs.length} counts the same ${valid(runs).length} dev-valid runs over the listed runs only, and ${valid(gated).length} of ${gated.length} those at revision ${INVARIANCE_FROM_REVISION} or later, under the answer-invariance gate. The rate of the system as it stands is the latest configuration's, discover_config_*.`,
    discover_configurations: configs,
    discover_config: `revision ${String(latest["revision"])}, committed world, ${String(latest["effort"])} effort`,
    discover_current_revision: o.currentRevision ?? latestRev,
    discover_config_revision: latest["revision"], discover_config_runs: latest["runs"], discover_config_dev_valid: latest["dev_valid"],
    discover_config_rate: latest["rate"], discover_config_lower: latest["lower_95"], discover_config_upper: latest["upper_95"],
    discover_config_interval: "exact two-sided 95% (Clopper-Pearson)",
    discover_config_wilson_lower: latest["wilson_lower_95"], discover_config_wilson_upper: latest["wilson_upper_95"],
    discover_config_planted: latest["planted"], discover_config_planted_lower: latest["planted_wilson_lower_95"], discover_config_planted_upper: latest["planted_wilson_upper_95"],
    discover_low_runs: low?.["runs"] ?? null, discover_low_dev_valid: low?.["dev_valid"] ?? null, discover_low_wilson_lower: low?.["wilson_lower_95"] ?? null, discover_low_wilson_upper: low?.["wilson_upper_95"] ?? null,
    discover_low_planted: low?.["planted"] ?? null, discover_low_planted_lower: low?.["planted_wilson_lower_95"] ?? null, discover_low_planted_upper: low?.["planted_wilson_upper_95"] ?? null,
    discover_effort_rows: efforts.map((c) => ({ effort: c["effort"], runs: c["runs"], dev_valid: c["dev_valid"], wilson_95: [c["wilson_lower_95"], c["wilson_upper_95"]], planted: c["planted"], planted_wilson_95: [c["planted_wilson_lower_95"], c["planted_wilson_upper_95"]], read_by_predicate: c === latest })),
    discover_effort_text: `revision ${String(latestRev)} on the committed world: ${efforts.map(rowText).join("; ")}; the predicate reads ${CLAIM_EFFORT}`,
    discover_findings: findings,
    discover_invariance_pass: o.invariancePass, discover_deny_clean: gated.every((r) => r.needs?.deny_list === true),
    discover_invariance_covers: INVARIANCE_COVERS, discover_invariance_excludes: INVARIANCE_EXCLUDES,
    discover_dev_valid_runs: valid(gated).map((r) => ({ run_id: r.run_id, revision: r.commitment?.revision ?? null, variant: r.variant ?? null })),
    discover_rework_budget_from_revision: REWORK_BUDGET_FROM_REVISION,
    discover_rework_budget_note: `From commitment revision ${REWORK_BUDGET_FROM_REVISION} the hospital's aim allows extra rework up to a per-case budget that the dev gate assesses and the adopting person approves, where revisions 1 to 12 said no extra rework and revisions 13 and 14 left a stated cost to the gate. Runs under revisions 1 to ${REWORK_BUDGET_FROM_REVISION - 1}, the adopted proposal included, were validated before that rule and are not re-scored.`,
    discover_adopted: o.adopted, discover_share: share, discover_rework_events: delta("rework_events"), discover_rework_min: delta("rework_min"),
    discover_note: "Counts read from the runs already in this file; nothing is re-scored. A change that helps at a stated cost, not the best change. The answer-invariance test is the one in the intelligence package, run on this commit; it covers the instructions and tool interface, not the evidence or the workflow definition."
  };
}

// npx tsx apps/cli/src/discover-claim.ts --file evaluation/results/discovery.json --invariance pass|fail --adopted p-x --trade-offs '[...]'
if (process.argv[1]?.endsWith("discover-claim.ts")) {
  const argv = process.argv.slice(2);
  const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const file = flag("file") ?? "evaluation/results/discovery.json";
  const d = JSON.parse(readFileSync(file, "utf8")) as Row;
  const commitments = JSON.parse(readFileSync(flag("commitments") ?? "evaluation/commitments/intelligence.json", "utf8")) as { revisions: { revision: number }[] };
  const s = discoverSummary(d, { invariancePass: flag("invariance") === "pass", adopted: flag("adopted") ?? null, tradeOffs: JSON.parse(flag("trade-offs") ?? "[]"), currentRevision: commitments.revisions.at(-1)!.revision });
  const kept = Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith("discover_")));
  writeFileSync(file, `${JSON.stringify({ ...kept, ...s }, null, 1)}\n`);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => !["discover_dev_valid_runs", "discover_configurations", "discover_history_by_revision"].includes(k)))));
}
