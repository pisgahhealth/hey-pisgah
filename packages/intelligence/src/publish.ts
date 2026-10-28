import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { LedgerRow, type HypothesisRecord } from "@hey-pisgah/contracts";
import { readStream } from "@hey-pisgah/store";
import { checkDiscovery } from "./check.js";
import { STREAMS, sessionStreamId, type StoredExperiment } from "./session.js";

type Row = Record<string, unknown>;
export type RunOutcome = "dev_valid_proposal" | "honest_negative" | "insufficient_evidence" | "no_outcome";

// One live run as published: what it recorded, what it ran, how it ended, and what it cost per call.
export function runRecord(storeRoot: string, runId: string, note: string | null = null): Row {
  const c = checkDiscovery(storeRoot, runId);
  const log = readStream(storeRoot, sessionStreamId(runId));
  const opened = log.find((e) => e.record_type === "session.opened")?.payload as Row;
  const stopped = (log.find((e) => e.record_type === "session.stopped")?.payload ?? null) as Row | null;
  const result = (log.find((e) => e.record_type === "session.result")?.payload ?? null) as Row | null;
  const mine = <T>(id: string, type: string) => readStream(storeRoot, id).filter((e) => e.record_type === type && (e.payload as Row).session_id === runId).map((e) => e.payload as T);
  const hyps = mine<HypothesisRecord>(STREAMS.hypotheses, "hypothesis.recorded");
  const last = new Map(hyps.map((h) => [h.hypothesis_id, "open"]));
  for (const s of mine<Row>(STREAMS.hypotheses, "hypothesis.status_changed")) last.set(String(s.hypothesis_id), String(s.status));
  const exps = mine<StoredExperiment>(STREAMS.experiments, "experiment.completed");
  const rows = readStream(storeRoot, `ledger/${runId}`).filter((e) => e.record_type === "model.call").map((e) => LedgerRow.parse(e.payload));
  const validations = (c.summary.validations ?? []) as string[];
  const outcome: RunOutcome = validations.includes("dev_validated") ? "dev_valid_proposal" : result?.result === "no_change_warranted" ? "honest_negative" : result?.result === "insufficient_evidence" ? "insufficient_evidence" : "no_outcome";
  const prompt = rows.reduce((s, r) => s + r.prompt_tokens, 0);
  return {
    run_id: runId, outcome, stop: stopped ? `${String(stopped.stop)} (${String(stopped.detail)})` : "not stopped", note,
    commitment: opened.commitment, hashes: opened.hashes, effort: (opened.settings as Row).effort, model: opened.model, check_discovery: c.pass ? "PASS" : "FAIL", needs: c.summary.needs,
    hypotheses: hyps.map((h) => ({ hypothesis_id: h.hypothesis_id, status: last.get(h.hypothesis_id), statement: h.statement, competing: h.competing, if_true: h.if_true, if_false: h.if_false })),
    experiments: exps.map((x) => ({ experiment_id: x.experiment_id, ops: (x.request as Row).ops, case_ids: (x.request as Row).case_ids, prediction_check: x.prediction_check, event_logs_identical_to_control: x.behaviour?.event_logs_identical_to_control ?? null, behaviour_note: x.behaviour?.note ?? null, no_pair_reason: x.no_pair_reason, median_delta: x.summary })),
    notes: log.filter((e) => e.record_type === "note.recorded").map((e) => String((e.payload as Row).note)),
    definition_unchanged_answers: c.summary.definition_unchanged ?? null, reading_budget_refusals: c.summary.read_refusals ?? null, experiment_budget_refusals: c.summary.experiment_budget_refusals ?? null, hypothesis_schema_errors: c.summary.hypothesis_schema_errors ?? null,
    pair_refusals: c.summary.pair_refusals, say_do_mismatches: c.summary.say_do_mismatches, proposals: c.summary.proposals, validations,
    declared_result: result ? { result: result.result, note: result.note } : null,
    calls: rows.length, cost_usd: Math.round(rows.reduce((s, r) => s + r.cost_usd, 0) * 1e4) / 1e4,
    prompt_tokens: prompt, prompt_tokens_per_call: rows.length ? Math.round(prompt / rows.length) : 0, prompt_tokens_max: rows.reduce((m, r) => Math.max(m, r.prompt_tokens), 0),
    completion_tokens: rows.reduce((s, r) => s + r.completion_tokens, 0), reasoning_tokens: rows.reduce((s, r) => s + (r.reasoning_tokens ?? 0), 0)
  };
}

// Merges the adaptive runs into the results file and keeps every field the evaluator wrote there.
export function publishRuns(file: string, runs: Row[], meta: Row): Row {
  const prev = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Row) : {};
  const count = (o: RunOutcome) => runs.filter((r) => r.outcome === o).length;
  const k = { n: runs.length, dev_valid_proposal: count("dev_valid_proposal"), honest_negative: count("honest_negative"), insufficient_evidence: count("insufficient_evidence"), no_outcome: count("no_outcome") };
  const next = { ...prev, adaptive_runs: { ...meta, k_of_n: k, runs } };
  writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 1)}\n`);
  renameSync(`${file}.tmp`, file);
  return next;
}

// npx tsx packages/intelligence/src/publish.ts --out <file> --run <store>=<run_id>[=<note>] ...
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const out = argv[argv.indexOf("--out") + 1]!;
  const specs = argv.flatMap((a, i) => (a === "--run" ? [argv[i + 1]!] : []));
  const runs = specs.map((s) => { const [store, id, note] = s.split("="); return runRecord(store!, id!, note ?? null); });
  const r = publishRuns(out, runs, { measured_at: new Date().toISOString(), arm: "adaptive", provider: "modal", budget_per_run: { usd: 6, calls: 60 } });
  console.log(JSON.stringify((r.adaptive_runs as Row).k_of_n));
}
