import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { validateProposal } from "@hey-pisgah/evaluator";
import { STREAMS, loadVariant, runRecord, type VariantId } from "@hey-pisgah/intelligence";
import { readStream } from "@hey-pisgah/store";

// npx tsx apps/cli/src/publish-discovery.ts --out <file> --group <name> --commitment <rev>:<hash> --run <store>=<run_id>=<variant>[=<note>] ... [--extra <name>=<json file>]
type Row = Record<string, unknown>;
const argv = process.argv.slice(2);
const all = (n: string) => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]!] : []));
const one = (n: string) => all(n)[0];
const out = one("out")!;
const group = one("group")!;
const [rev, hash] = (one("commitment") ?? ":").split(":");
const proposal = (ops: unknown[], tag: string) => ({ proposal_id: `p-${tag}`, parent_proposal_id: null, base_version: 1, ops, scope: { wards: "all", condition: null }, rationale: "share", evidence: { hypothesis_ids: [], experiment_ids: [], event_ids: [] }, expected_effects: [], known_exceptions: [], viewed_case_ids: [], status: "submitted", hash: "0".repeat(64) });
const gain = (r: { cases: { delta: { post_signoff_wait_min: number | null } }[] }) => -r.cases.reduce((s, c) => s + (c.delta.post_signoff_wait_min ?? 0), 0);

const runs: Row[] = [];
for (const spec of all("run")) {
  const [store, id, variant, note] = spec.split("=") as [string, string, VariantId, string | undefined];
  const r = runRecord(store, id, note ?? null);
  const v = loadVariant(variant);
  const opts = v.validation ? { base: v.base, cases: v.validation, caseFacts: v.pool.caseFacts() } : {};
  const planted = gain(await validateProposal(proposal(v.planted, "0000aaa1"), opts));
  const props = readStream(store, STREAMS.proposals).filter((e) => e.record_type === "proposal.submitted").map((e) => e.payload as { proposal_id: string; ops: unknown[]; scope: unknown });
  const shares: Row[] = [];
  for (const p of props.filter((x) => (r.proposals as string[]).includes(x.proposal_id))) {
    const rep = await validateProposal({ ...proposal(p.ops, "0000ccc1"), scope: p.scope }, opts);
    shares.push({ proposal_id: p.proposal_id, ops: p.ops, status: rep.status, validation_gain_min: gain(rep), share_of_planted: Math.round((gain(rep) / Math.max(1, planted)) * 100) / 100 });
  }
  const stopped = readStream(store, `discovery/${id}`).find((e) => e.record_type === "session.stopped")?.payload as Row | undefined;
  const counters = (stopped?.counters ?? {}) as Row;
  const found = shares.some((s) => s.status === "dev_validated" && Number(s.share_of_planted) >= 0.9);
  const sims = counters.simulations ?? (r.experiments as { case_ids: string[] }[]).reduce((n, x) => n + 2 * x.case_ids.length, 0);
  // A delivered experiment that moved a planted step and made the wait better, whatever operations expressed it.
  const deliveredPlanted = (r.experiments as { expected_change: { step: string } | null; outcome_class: string | null }[]).some((x) => x.outcome_class === "delivered_outcome_better" && x.expected_change !== null && v.planted_steps.includes(x.expected_change.step));
  runs.push({ ...r, variant, planted_gain_min: planted, proposal_shares: shares, found_planted: found, planted_step_delivered_better: deliveredPlanted, simulations: sims, sweeps: counters.sweeps ?? 0, cycles: stopped?.cycles ?? null });
}
const count = (f: (r: Row) => boolean) => runs.filter(f).length;
const k = { n: runs.length, dev_valid_proposal: count((r) => r.outcome === "dev_valid_proposal"), found_planted: count((r) => r.found_planted === true), planted_step_delivered_better: count((r) => r.planted_step_delivered_better === true), honest_negative: count((r) => r.outcome === "honest_negative"), no_outcome: count((r) => r.outcome === "no_outcome") };
const prev = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as Row) : {};
const ar = { ...((prev.adaptive_runs ?? {}) as Row) };
const extras = Object.fromEntries(all("extra").map((x) => { const [name, file] = x.split("="); return [name!, JSON.parse(readFileSync(file!, "utf8")) as unknown]; }));
ar[group] = { measured_at: new Date().toISOString(), commitment: { revision: Number(rev), hash }, k_of_n: k, runs, ...extras };
const next = { ...prev, adaptive_runs: ar };
writeFileSync(`${out}.tmp`, `${JSON.stringify(next, null, 1)}\n`);
renameSync(`${out}.tmp`, out);
console.log(group, JSON.stringify(k));
