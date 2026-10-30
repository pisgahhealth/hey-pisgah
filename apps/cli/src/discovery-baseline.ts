import { writeFileSync } from "node:fs";
import { validateProposal } from "@hey-pisgah/evaluator";
import { VARIANTS, loadVariant, searchBaseline } from "@hey-pisgah/intelligence";

// npx tsx apps/cli/src/discovery-baseline.ts --budget <simulations> [--out file]: the programmatic search baseline on every variant, with its best cells through the dev gate.
const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const budget = Number(flag("budget") ?? 6000);
const proposal = (ops: unknown[], tag: string) => ({ proposal_id: `p-${tag}`, parent_proposal_id: null, base_version: 1, ops, scope: { wards: "all", condition: null }, rationale: "baseline", evidence: { hypothesis_ids: [], experiment_ids: [], event_ids: [] }, expected_effects: [], known_exceptions: [], viewed_case_ids: [], status: "submitted", hash: "0".repeat(64) });
const gain = (r: { cases: { delta: { post_signoff_wait_min: number | null } }[] }) => -r.cases.reduce((s, c) => s + (c.delta.post_signoff_wait_min ?? 0), 0);
const out: Record<string, unknown> = { budget, measured_at: new Date().toISOString() };
for (const id of VARIANTS) {
  const v = loadVariant(id);
  const opts = v.validation ? { base: v.base, cases: v.validation, caseFacts: v.pool.caseFacts() } : {};
  const planted = await validateProposal(proposal(v.planted, "0000aaa1"), opts);
  const row: Record<string, unknown> = { planted: v.planted, planted_status: planted.status, planted_gain_min: gain(planted) };
  for (const order of ["committed", "shuffled"] as const) {
    const r = searchBaseline({ base: v.base, cases: v.pool.ids().map((x) => v.pool.get(x)!), files: (x) => v.pool.experimentable(x), caseFacts: v.pool.caseFacts(), budget, order, reference: v.planted });
    let chosen: Record<string, unknown> | null = null;
    for (const [k, c] of r.top.slice(0, 20).entries()) {
      const rep = await validateProposal(proposal(c.ops, `ba5e${String(k).padStart(4, "0")}`), opts);
      if (rep.status === "dev_validated" && gain(rep) > 0) { chosen = { ops: c.ops, discovery_sum: c.sum_wait_delta, validation_gain_min: gain(rep), share_of_planted: Math.round((gain(rep) / Math.max(1, gain(planted))) * 100) / 100, rank: k + 1 }; break; }
    }
    row[order] = { simulations: r.simulations, cells: r.cells, singles: r.singles, scope: r.scope, cases: r.cases, reference_sum: r.reference_sum, reproduced_planted_at: r.found_at, top: r.top.slice(0, 5).map((c) => ({ ops: c.ops, sum: c.sum_wait_delta })), chosen };
  }
  out[id] = row;
  console.log(id, JSON.stringify({ planted_gain: row.planted_gain_min, committed: (row.committed as Record<string, unknown>).reproduced_planted_at, shuffled: (row.shuffled as Record<string, unknown>).reproduced_planted_at, chosen_c: ((row.committed as Record<string, unknown>).chosen as Record<string, unknown> | null)?.share_of_planted ?? null, chosen_s: ((row.shuffled as Record<string, unknown>).chosen as Record<string, unknown> | null)?.share_of_planted ?? null }));
}
if (flag("out")) writeFileSync(flag("out")!, `${JSON.stringify(out, null, 1)}\n`);
