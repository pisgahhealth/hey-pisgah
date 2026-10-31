import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadV1 } from "@hey-pisgah/hospital";
import { DiscoveryPool, cycle2Result, cycleResponse, loadObserved, reverseOutcomes } from "@hey-pisgah/intelligence";

type Row = Record<string, unknown>;
const SAID: Record<string, string> = { rollback_proposed: "proposed a rollback for a person to decide", proposed_revision: "proposed a revision", no_change_warranted: "kept the version", insufficient_evidence: "said the evidence is insufficient", re_proposed_adopted: "proposed the adopted change again", declined: "ended without a result", other_proposal: "proposed another change", no_response: "reached no result" };
const tally = (xs: readonly Row[]) => Object.entries(xs.reduce<Record<string, number>>((m, x) => { const k = String(x["response"]); m[k] = (m[k] ?? 0) + 1; return m; }, {})).map(([k, n]) => `${n} ${SAID[k] ?? k}`).join(", ");

// Reads paired second cycles (outcomes as recorded against reversed) and states how many reversed runs ended in a declared result.
export function pairsReport(o: { dir: string; pairs: [string, string][]; outcomesFile: string; observedFile: string; adoptedOps: readonly unknown[]; capUsd: number; revision: number }): Row {
  const outcomes = loadObserved(o.outcomesFile);
  const observed = loadObserved(o.observedFile);
  const reversed = reverseOutcomes(outcomes, new DiscoveryPool(), loadV1());
  const one = (runId: string, outs: typeof outcomes) => cycleResponse(join(o.dir, runId, "store"), runId, { observed, outcomes: outs, adoptedOps: o.adoptedOps });
  const pairs = o.pairs.map(([u, r], i) => ({ pair: i + 1, cap_usd: o.capUsd, unreversed: one(u, outcomes), reversed: one(r, reversed) }));
  const rev = pairs.map((p) => p.reversed);
  const declared = rev.filter((x) => x["declared_result"] === true).length;
  const cost = Math.round(pairs.reduce((n, p) => n + Number(p.unreversed["cost_usd"] ?? 0) + Number(p.reversed["cost_usd"] ?? 0), 0) * 1e6) / 1e6;
  return {
    revision: o.revision, pairs, cost_usd: cost,
    reversed_declared: declared, reversed_runs: rev.length, reversed_declared_met: declared >= 2,
    summary: `with the ward A outcome reversed so the adopted change hurt, ${declared} of ${rev.length} reversed runs ended in a declared result (${tally(rev.filter((x) => x["declared_result"] === true)) || "none"})${rev.length - declared ? ` and ${rev.length - declared} did not (${tally(rev.filter((x) => x["declared_result"] !== true))})` : ""}; unreversed, ${tally(pairs.map((p) => p.unreversed))}`
  };
}

// npx tsx apps/cli/src/cycle2-pairs.ts --file evaluation/results/cycle2.json --dir <pairs dir> --pairs u1:r1,u2:r2,u3:r3 --cap 1.0 --revision 16 --how "<text>"
// npx tsx apps/cli/src/cycle2-pairs.ts --relabel <store>=<run> --file evaluation/results/cycle2.json: the recorded run's result read again against the adopted operations; every other field stays as measured.
if (process.argv[1]?.endsWith("cycle2-pairs.ts") && process.argv.includes("--relabel")) {
  const argv = process.argv.slice(2);
  const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const file = flag("file") ?? "evaluation/results/cycle2.json";
  const [store, runId] = flag("relabel")!.split("=");
  const cur = JSON.parse(readFileSync(file, "utf8")) as Row;
  if (cur["run_id"] !== runId) throw new Error(`${file} records ${String(cur["run_id"])}, not ${runId}`);
  const improve = JSON.parse(readFileSync(flag("improve") ?? "evaluation/results/improve.json", "utf8")) as { proposal: { ops: unknown[] } };
  const r = cycle2Result(store!, runId!, { observed: loadObserved(flag("observed") ?? "evaluation/results/observed-cases.json"), outcomes: loadObserved(flag("outcomes") ?? "packages/intelligence/fixtures/outcomes/adopted-v2.json"), adoptedOps: improve.proposal.ops });
  writeFileSync(file, `${JSON.stringify({ ...cur, result: r["result"], result_said: r["result_said"], result_before_relabel: cur["result_before_relabel"] ?? cur["result"] }, null, 1)}\n`);
  console.log(JSON.stringify({ result: r["result"], was: cur["result"] }));
} else if (process.argv[1]?.endsWith("cycle2-pairs.ts")) {
  const argv = process.argv.slice(2);
  const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const file = flag("file") ?? "evaluation/results/cycle2.json";
  const improve = JSON.parse(readFileSync(flag("improve") ?? "evaluation/results/improve.json", "utf8")) as { proposal: { ops: unknown[] } };
  const r = pairsReport({
    dir: flag("dir")!, pairs: flag("pairs")!.split(",").map((x) => x.split(":") as [string, string]), capUsd: Number(flag("cap") ?? 1), revision: Number(flag("revision")),
    outcomesFile: flag("outcomes") ?? "packages/intelligence/fixtures/outcomes/adopted-v2.json", observedFile: flag("observed") ?? "evaluation/results/observed-cases.json", adoptedOps: improve.proposal.ops
  });
  const cur = JSON.parse(readFileSync(file, "utf8")) as Row;
  const prev = cur["reversed_pairs"] as Row | undefined;
  const next = { ...cur, reversed_pairs: { how: flag("how") ?? "", categories: (prev?.["categories"] as Row | undefined) ?? {}, ...r, earlier: prev ? { ...prev, summary: cur["reversed_pairs_summary"] ?? null } : null }, reversed_pairs_summary: r["summary"], reversed_declared: r["reversed_declared"], reversed_runs: r["reversed_runs"], reversed_declared_met: r["reversed_declared_met"] };
  writeFileSync(file, `${JSON.stringify(next, null, 1)}\n`);
  console.log(JSON.stringify({ summary: r["summary"], cost: r["cost_usd"] }));
}
