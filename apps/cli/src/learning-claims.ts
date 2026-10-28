import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { findCase } from "@hey-pisgah/cases";
import { twoClockClaim } from "@hey-pisgah/evaluator";
import { adoptionClaims, citedEventCount, cycle2Result, discoveryClaims, loadObserved } from "@hey-pisgah/intelligence";

type Row = Record<string, unknown>;

// Writes the learning claims' result files: npx tsx apps/cli/src/learning-claims.ts --discovery f --learning f --experiments f --proposals f --two-clock f [--cycle2 f --cycle-run store=run --observed f --outcomes f] [--adoption f --demo-runs f --emr-version f --version-log f] --run store=run ...
const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const write = (f: string | undefined, v: unknown) => { if (f) writeFileSync(f, `${JSON.stringify(v, null, 1)}\n`); };
const runs = argv.flatMap((a, i) => (a === "--run" ? [argv[i + 1]!] : [])).map((s) => { const [storeRoot, runId] = s.split("="); return { storeRoot: storeRoot!, runId: runId! }; });
const disc = JSON.parse(readFileSync(flag("discovery")!, "utf8")) as Row;
const d = discoveryClaims(disc);
const k = (disc["adaptive_runs"] as Row)["k_of_n"] as Row;
const stamp = { measured_at: new Date().toISOString(), measured: true, source: "discovery_runs", current_revision: d["current_revision"], k_of_n: d["k_of_n"] };
const best = runs.find((r) => r.runId === d["best_run"]);
const events = best ? citedEventCount(best.storeRoot, best.runId) : null;
// Each claim reads its own file, since the wordings share placeholder names such as n.
write(flag("learning"), { ...stamp, ...d, n: d["hypotheses"], events });
write(flag("experiments"), { ...stamp, n: d["experiments"], experiments: d["experiments"], sublog_hashes_equal: d["sublog_hashes_equal"], prediction_check_after_present: d["prediction_check_after_present"], confirmed: d["confirmed"], contradicted: d["contradicted"], inconclusive: d["inconclusive"] });
// C-06 reads the adaptive arm only; with no dev-valid proposal the gate counts as failed, and a dev-valid one would need the evaluator's report.
const valid = Number(k["dev_valid_proposal"] ?? 0);
write(flag("proposals"), { ...stamp, arm: "adaptive", n: null, dev_gate_pass: valid > 0 ? null : false, exception_check_pass: null, fences_unchanged: null, proposals_validated: valid, scope: null, dev_valid_proposals_k_of_n: k });
write(flag("two-clock"), { ...stamp, ...twoClockClaim(runs) });
const cyc = flag("cycle-run");
if (cyc && flag("cycle2")) {
  const [storeRoot, runId] = cyc.split("=");
  const load = (f: string | undefined) => (f && existsSync(f) ? loadObserved(f) : []);
  write(flag("cycle2"), cycle2Result(storeRoot!, runId!, { observed: load(flag("observed")), outcomes: load(flag("outcomes")) }));
}
if (flag("adoption") && flag("demo-runs") && flag("emr-version") && flag("version-log")) {
  const adopted = readFileSync(flag("version-log")!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { record_type: string; payload: Row }).find((e) => e.record_type === "version.adopted");
  const approver = (adopted?.payload["approver"] ?? { kind: "unknown", display_name: "unknown" }) as { kind: string; display_name: string };
  write(flag("adoption"), adoptionClaims(JSON.parse(readFileSync(flag("demo-runs")!, "utf8")), JSON.parse(readFileSync(flag("emr-version")!, "utf8")), approver, (id) => (findCase(id)?.file.schedule.facts ?? {}) as Row));
}
console.log(JSON.stringify({ hypotheses: d["hypotheses"], experiments: d["experiments"], events }));
