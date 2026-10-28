import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashJson, sha256, type HypothesisRecord, type Operation, type PredictionCheck, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { loadSubsets, type GeneratedCase } from "@hey-pisgah/cases";
import { loadHandCase, loadV1 } from "@hey-pisgah/hospital";
import { applyOperations, type Facts } from "@hey-pisgah/workflow";
import { acceptanceHash } from "./acceptance/hash.js";
import { earliestPermitted } from "./arms/a1.js";
import { a4Order, fuzz, oracleNote, randomExperiments, runMatched, type DrawnExperiment } from "./arms/experiments.js";
import { armVersion, type ArmVersion, type ProposalInput } from "./arms/proposals.js";
import { poolCases, runArm, type ArmCase, type ArmResult } from "./arms/run.js";
import { singleOperationSweep, type SweepResult } from "./arms/sweep.js";
import { committedHash } from "./commitments.js";
import type { CompletionSummary } from "./completion.js";
import { RESERVED_HASH_FILE } from "./data.js";
import { draftUseSweep, injectedNoteCitations, injectedNotes } from "./extras.js";
import { fr1Row, scoreCase, traceFromRun, type Fr1Row } from "./fr1.js";
import { effectsFromRun, rerunHarness, type ReliabilityTable } from "./fr4.js";
import { loadValidationCases, runCase, validationSummary, type ValidationCase } from "./pipeline.js";
import { predictionAfter, predictionBefore, summariseChecks, type CheckHypothesis, type CheckedExperiment, type PredictionSummary } from "./prediction.js";
import { reservedRunFile, reservedRunRefusal, sealedReservedCases, writeReservedArtifact, ReservedRunRefused } from "./reserved.js";
import { markdownTable, pairedVsA1, primaryMarkdown, primaryRow, type PairedRow, type PrimaryRow } from "./tables.js";
import { sumTextClaims, type TextClaimCount } from "./textclaims.js";

// What the CLI gathers from agent stores; the evaluator reads it as data and never imports the agent.
export type AgentRunData = {
  label: string; mode: "live" | "replay" | "mock";
  completion: CompletionSummary; text: TextClaimCount; prohibited_executed: number; prohibited_attempted: number;
  ledger: { calls: number; calls_while_waiting: number; usd: number; latency_ms: number[]; providers: Record<string, number>; turns_without_row: number; request_ids: string[]; negative_control_red: boolean };
};
// What L2.1's discovery run exports for the prediction-check table and the citation metric.
export type DiscoveryInput = {
  hypotheses: (CheckHypothesis & Partial<Pick<HypothesisRecord, "statement" | "mechanism" | "evidence" | "competing">>)[];
  experiments: { experiment_id: string; ops: Operation[]; case_ids: string[]; prediction_check: PredictionCheck; sublog_equal: boolean }[];
};
export type EvalOptions = {
  root: string; set: "dev" | "all" | "reserved"; outDir?: string; inputs?: ProposalInput[]; discovery?: DiscoveryInput | null; agentRuns?: AgentRunData[];
  sweepLimit?: number; fuzzN?: number; now?: () => string; commit?: string; env?: NodeJS.ProcessEnv; reservedCases?: GeneratedCase[]; log?: (l: string) => void;
};

const write = (dir: string, name: string, data: unknown) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), `${JSON.stringify(data, null, 1)}\n`); };
const fromGenerated = (g: GeneratedCase): ArmCase => ({ schedule: g.schedule, schedule_hash: g.manifest.schedule_hash, manifest: g.manifest, initial_state: g.initial_state });
const textOf = (raw: unknown) => { const p = raw as { proposal_id?: string; rationale?: string; evidence?: { event_ids?: string[] } }; return { id: p.proposal_id ?? "?", texts: [p.rationale ?? ""], event_ids: p.evidence?.event_ids ?? [] }; };

type Arms = { results: Map<string, ArmResult>; versions: ArmVersion[]; primary: PrimaryRow[]; paired: PairedRow[]; fr1: Fr1Row[] };

// Runs every definition-executor arm on one case set and builds the primary, paired and FR-1 tables.
async function runArms(base: WD, cases: readonly ArmCase[], inputs: readonly ProposalInput[], validationCases: ValidationCase[]): Promise<Arms> {
  const results = new Map<string, ArmResult>();
  results.set("A0", runArm("A0", base, base, cases));
  results.set("A1", runArm("A1", earliestPermitted(base).definition, base, cases));
  const versions: ArmVersion[] = [];
  for (const input of inputs) {
    const v = await armVersion(input, base, { cases: validationCases });
    versions.push(v);
    results.set(input.arm, runArm(input.arm, v.definition, base, cases));
  }
  const primary = ["A0", "A1", "A2", "A2a", "A3", "A4", "A-prior"].map((arm) => {
    const v = versions.find((x) => x.arm === arm);
    const r = results.get(arm);
    if (arm === "A2a") return primaryRow(arm, null, { note: "model-agent arm; runs only in the reserved run with the agent" });
    if (!r) return primaryRow(arm, null, { note: "no proposal input" });
    return primaryRow(arm, r.rows, { status: v?.equals_base ? "equals_A0" : "measured", note: v ? `${v.source.kind}, ${v.source.mode}` : null, cost: v?.cost ?? null });
  });
  const a1 = results.get("A1")!.rows;
  const paired = [...results.entries()].filter(([k]) => k !== "A1").flatMap(([k, r]) => (["post_signoff_wait_min", "rework_min", "unnecessary_docs"] as const).map((m) => pairedVsA1(k, r.rows, a1, m)));
  const fr1 = [...results.entries()].map(([arm, r]) => fr1Row(arm, cases.map((c) => {
    const run = r.runs.get(c.manifest.case_id)!;
    const t = traceFromRun(run, r.rows.find((x) => x.case_id === c.manifest.case_id)?.in_scope === false ? base : r.definition, c.initial_state);
    return { points: t ? scoreCase(c.manifest, t) : [], prohibited_attempts: run.outcome === "ok" ? run.metrics.prohibited_attempted : 0 };
  })));
  return { results, versions, primary, paired, fr1 };
}

function predictionTable(base: WD, discovery: DiscoveryInput | null, cases: readonly ArmCase[]): { rows: PredictionSummary[]; notes: Record<string, unknown>[] } {
  const facts = new Map(cases.map((c) => [c.manifest.case_id, c.schedule.facts as Facts]));
  const sched = new Map(cases.map((c) => [c.manifest.case_id, c.schedule]));
  const caseFacts = [...facts.values()];
  const hs = discovery?.hypotheses ?? [];
  const disc = cases.map((c) => ({ case_id: c.manifest.case_id, facts: c.schedule.facts as Facts }));
  const notes: Record<string, unknown>[] = [];
  const check = (label: string, xs: readonly DrawnExperiment[]): CheckedExperiment[] => xs.map((x) => {
    const before = predictionBefore(hs, x.case_ids, (id) => facts.get(id));
    const m = runMatched(base, x.ops, x.case_ids.map((id) => sched.get(id)!), caseFacts);
    if (!m.ok) return { label, before, after: null };
    notes.push({ source: label, index: x.index, ...oracleNote(m.cases, (id) => cases.find((c) => c.manifest.case_id === id)!.manifest.family) });
    const speaking = hs.filter((h) => before.speaks_to.includes(h.hypothesis_id));
    return { label, before, after: predictionAfter(speaking, m.cases.map((c) => ({ ...c, facts: facts.get(c.case_id)! }))) };
  });
  const adaptive = (discovery?.experiments ?? []).map((x) => ({ label: "adaptive", before: x.prediction_check.before, after: x.prediction_check.after }));
  const rows = [
    summariseChecks("adaptive", adaptive),
    summariseChecks("A4 committed order", check("A4", a4Order(base, disc).experiments)),
    summariseChecks("30 random experiments", check("random", randomExperiments(base, disc)))
  ];
  return { rows, notes };
}

// The dev (or all) evaluation: every arm on the definition executor, the sweep, fuzzing, FR tables, prediction checks and the claims' result files.
export async function evaluateDev(o: EvalOptions): Promise<Record<string, unknown>> {
  const log = o.log ?? (() => {});
  const now = (o.now ?? (() => new Date().toISOString()))();
  const out = o.outDir ?? join(o.root, "evaluation", "results");
  const base = loadV1();
  const inputs = o.inputs ?? [];
  const mode = inputs.some((i) => i.source.kind === "fixture") || (o.agentRuns ?? []).some((r) => r.mode === "mock") ? "mock" : "measured";
  const cases = o.set === "all" ? [...poolCases("dev"), ...poolCases("variation"), ...poolCases("demo"), ...poolCases("dev_held")] : poolCases("dev");
  const discoveryCases = poolCases("discovery");
  const vcases = loadValidationCases({ r2Effective: false });
  const stamp = { measured_at: now, set: o.set, mode, executor: "definition" };

  log("arms");
  const arms = await runArms(base, cases, inputs, vcases);
  log("sweep");
  const caseFacts = discoveryCases.map((c) => c.schedule.facts as Facts);
  const sweep: SweepResult = await singleOperationSweep(base, vcases, caseFacts, { reference: loadHandCase().g2.ops as Operation[], ...(o.sweepLimit !== undefined ? { limit: o.sweepLimit } : {}) });
  log("fuzz");
  const fz = fuzz(base, cases, caseFacts, o.fuzzN ?? 200);
  log("variation, reliability, prediction checks");
  const variation = await variationTable(base, arms.versions);
  const subsets = loadSubsets() as { fr4: { dev: string[]; demo: string[] } };
  const fr4Cases = [...poolCases("dev"), ...poolCases("demo")];
  const fr4Ids = [...subsets.fr4.dev, ...subsets.fr4.demo];
  const adopted = arms.versions.find((v) => v.arm === "A2")?.definition ?? base;
  const fr4Def: ReliabilityTable = await rerunHarness(fr4Ids, { reset: () => {}, run: (id) => effectsFromRun(runCase(adopted, fr4Cases.find((c) => c.manifest.case_id === id)!.schedule)) }, 5);
  const prediction = predictionTable(base, o.discovery ?? null, discoveryCases);
  const sensitivity = draftUseSweep(base, [{ arm: "A1", definition: earliestPermitted(base).definition }, ...arms.versions.filter((v) => !v.equals_base).map((v) => ({ arm: v.arm, definition: v.definition }))], cases);
  const citations = injectedNoteCitations(injectedNotes([...cases, ...discoveryCases]), (o.discovery?.hypotheses ?? []).map((h) => ({ id: h.hypothesis_id, texts: [h.statement ?? "", h.mechanism ?? "", ...(h.evidence ?? []).map((e) => e.note)], event_ids: (h.evidence ?? []).map((e) => e.event_id) })), inputs.flatMap((i) => i.runs.flatMap((r) => r.proposals.map(textOf))));

  const runsAll = [...arms.results.values()].flatMap((r) => r.rows);
  const agent = o.agentRuns ?? [];
  const prohibitedExecuted = runsAll.reduce((s, r) => s + (r.metrics?.prohibited_executed ?? 0), 0) + agent.reduce((s, a) => s + a.prohibited_executed, 0);
  const firstBad = runsAll.find((r) => (r.metrics?.prohibited_executed ?? 0) > 0)?.case_id ?? null;
  write(out, "all-runs.json", {
    ...stamp, runs: runsAll.length + agent.length + fz.runs, prohibited_executed: prohibitedExecuted, attempts: runsAll.reduce((s, r) => s + (r.metrics?.prohibited_attempted ?? 0), 0) + agent.reduce((s, a) => s + a.prohibited_attempted, 0),
    fuzz_green: fz.green, fuzz: fz, case: firstBad
  });

  const model = arms.versions.filter((v) => v.source.kind === "model_run");
  const fixture = arms.versions.filter((v) => v.source.kind === "fixture");
  const best = model.flatMap((v) => v.validation);
  const chosen = model.find((v) => v.chosen);
  write(out, "validation.json", {
    ...stamp, measured: model.length > 0,
    ...(model.length ? { ...validationSummary(best), scope: chosen ? JSON.stringify(chosen.definition.scope) : null, n: best.find((r) => r.status === "dev_validated")?.cases.filter((c) => !c.seen).length ?? 0 } : {}),
    fixture_inputs: fixture.map((v) => ({ arm: v.arm, ...validationSummary(v.validation) }))
  });

  const comp = agent.length ? agent.map((a) => a.completion) : [];
  const text = sumTextClaims(agent.map((a) => a.text));
  write(out, "completion.json", {
    ...stamp, measured: comp.length > 0, runs_by_label: agent.map((a) => ({ label: a.label, mode: a.mode, runs: a.completion.runs, matrix: a.completion.matrix, text: a.text })),
    ...(comp.length ? {
      off_diagonal: comp.reduce((s, c) => s + c.off_diagonal, 0), k: comp.reduce((s, c) => s + c.false_done, 0), attempts: comp.reduce((s, c) => s + c.premature_attempts, 0),
      premature_attempts_counted: comp.every((c) => c.premature_attempts_counted), turn_text_claims: text.claims, turn_text_backed: text.backed, turn_text_unbacked: text.unbacked, turn_text_examples: text.unbacked_examples
    } : {}),
    definition_executor_verifier: Object.fromEntries([...arms.results.entries()].map(([k, r]) => [k, { pass: r.rows.filter((x) => x.verifier_pass).length, n: r.rows.length }]))
  });

  const real = agent.filter((a) => a.mode !== "mock");
  const lat = real.flatMap((a) => a.ledger.latency_ms).sort((a, b) => a - b);
  const providers = real.reduce<Record<string, number>>((m, a) => { for (const [k, v] of Object.entries(a.ledger.providers)) m[k] = (m[k] ?? 0) + v; return m; }, {});
  write(out, "ledger-summary.json", {
    ...stamp, measured: agent.length > 0, mock_calls: agent.filter((a) => a.mode === "mock").reduce((s, a) => s + a.ledger.calls, 0),
    ...(agent.length ? { calls_while_waiting: agent.reduce((s, a) => s + a.ledger.calls_while_waiting, 0), negative_control_red: agent.every((a) => a.ledger.negative_control_red) } : {}),
    ...(real.length ? {
      ledger_complete: real.every((a) => a.ledger.turns_without_row === 0), n: real.reduce((s, a) => s + a.ledger.turns_without_row, 0), fallback_calls: Object.entries(providers).filter(([k]) => k !== "modal").reduce((s, [, v]) => s + v, 0),
      disclosed: false, provider: Object.keys(providers).sort().join(", "), calls: real.reduce((s, a) => s + a.ledger.calls, 0), usd: Math.round(real.reduce((s, a) => s + a.ledger.usd, 0) * 100) / 100,
      p50: lat.length ? Math.round(lat[Math.floor((lat.length - 1) / 2)]! / 100) / 10 : null, modes: [...new Set(real.map((a) => a.mode))]
    } : {}),
    wake_after_restart: "covered by the agent kill suite in tests, not by this file"
  });

  const reliability = { ...stamp, measured: false, reason: "the FR-4 claim is about the model agent; these reruns are on the deterministic definition executor", definition_executor: fr4Def, subset: fr4Ids };
  write(out, "reliability.json", reliability);
  write(out, "discovery.json", o.discovery ? { ...stamp, ...discoverySummary(o.discovery), citations } : { ...stamp, measured: false, reason: "no discovery input yet", citations });
  write(out, "monitor.json", { ...stamp, measured: false, reason: "the monitor runs with the adopted version in the agent lane; no monitor log was given" });
  write(out, "cycle2.json", { ...stamp, measured: false, reason: "the second learning cycle has not run; no cycle input was given" });

  const tables = {
    ...stamp, units: "simulated minutes", cases: cases.length, primary: arms.primary, paired: arms.paired,
    sweep: { ...sweep, entries: undefined, passing_ops: sweep.entries.filter((e) => e.gate_pass).length }, fr1: arms.fr1, fr4: { definition_executor: fr4Def }, fr5: JSON.parse(readFileSync(join(out, "completion.json"), "utf8")) as unknown,
    prediction: prediction.rows, oracle_notes: prediction.notes, variation, sensitivity, citations, by_family: byFamily(arms.results),
    versions: arms.versions.map((v) => ({ arm: v.arm, source: v.source, chosen: v.chosen, equals_base: v.equals_base, reports: v.reports, input_hash: v.input_hash }))
  };
  write(out, "tables.json", tables);
  writeFileSync(join(out, "tables.md"), tablesMarkdown(tables));
  return tables;
}

function discoverySummary(d: DiscoveryInput): Record<string, unknown> {
  const landed = d.experiments.flatMap((x) => Object.values(x.prediction_check.after?.per_hypothesis ?? {}).map((v) => v.landed));
  const events = new Set(d.hypotheses.flatMap((h) => (h.evidence ?? []).map((e) => e.event_id)));
  const one = d.hypotheses.length === 1 ? d.hypotheses[0]!.competing : undefined;
  return {
    measured: true, hypotheses: d.hypotheses.length, n: d.hypotheses.length, events: events.size, stated_reason: one !== undefined && !Array.isArray(one),
    experiments: d.experiments.length, sublog_hashes_equal: d.experiments.length > 0 && d.experiments.every((x) => x.sublog_equal),
    prediction_check_after_present: d.experiments.length > 0 && d.experiments.every((x) => x.prediction_check.after !== null),
    confirmed: landed.filter((l) => l === "if_true").length, contradicted: landed.filter((l) => l === "if_false").length, inconclusive: landed.filter((l) => l === "inconclusive").length
  };
}

// Ward B under r2: A0, A1, the adopted version run blindly, and A1 with the medicines section rebound by a person.
async function variationTable(base: WD, versions: readonly ArmVersion[]) {
  const cases = poolCases("variation");
  const a1 = earliestPermitted(base).definition;
  const fix = applyOperations(a1, [{ op: "rebind_section", document_id: "discharge_summary", section_id: "medicines", source: { record_kind: "dispense_record", field_path: "items", version_policy: "current" } }]);
  const rows = [["A0", base], ["A1", a1], ...versions.filter((v) => v.arm === "A2").map((v) => ["A2 blind", v.definition] as const), ...(fix.ok ? [["A1 corrected", fix.definition] as const] : [])] as [string, WD][];
  const out: { arm: string; n: number; pass: number | null; ac05_fail: number | null; note: string | null }[] = rows.map(([arm, d]) => {
    const r = runArm(arm, d, base, cases);
    return { arm, n: r.rows.length, pass: r.rows.filter((x) => x.pass).length, ac05_fail: r.rows.filter((x) => x.failing.includes("AC-05")).length, note: null };
  });
  return [...out, { arm: "A2a", n: 0, pass: null, ac05_fail: null, note: "model agent; runs in the reserved run" }];
}

function byFamily(results: Map<string, ArmResult>) {
  const out: Record<string, Record<string, { n: number; pass: number; wait_median: number | null }>> = {};
  for (const [arm, r] of results) for (const fam of [...new Set(r.rows.map((x) => x.family))].sort()) {
    const rows = r.rows.filter((x) => x.family === fam);
    const w = rows.map((x) => x.metrics?.post_signoff_wait_min).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
    (out[fam] ??= {})[arm] = { n: rows.length, pass: rows.filter((x) => x.pass).length, wait_median: w.length ? w[Math.floor((w.length - 1) / 2)]! : null };
  }
  return out;
}

function tablesMarkdown(t: Record<string, unknown> & { primary: PrimaryRow[]; paired: PairedRow[]; fr1: Fr1Row[]; prediction: PredictionSummary[] }): string {
  const s = t["sweep"] as SweepResult & { passing_ops: number };
  const fr4 = (t["fr4"] as { definition_executor: ReliabilityTable }).definition_executor;
  return [
    `# Evaluation tables (${String(t["set"])}, ${String(t["mode"])}, ${String(t["measured_at"])})`, "", "All times are simulated minutes. Rows run on the definition executor unless stated.", "",
    "## Primary", "", primaryMarkdown(t.primary), "",
    `Sweep: ${s.candidates} candidates, ${s.valid} valid single operations, ${s.validated} validated, ${s.passing} pass the dev gate, ${s.passing_and_cutting} also cut a wait by ${s.cut_threshold_min} or more. ${s.reference?.finding ?? ""}`, "",
    "## Paired against A1", "", markdownTable(["Arm", "Metric", "n", "Wins", "Ties", "Losses", "Sign test p", "Small n"], t.paired.map((p) => [p.arm, p.metric, p.n, p.wins, p.ties, p.losses, p.sign_test_p, p.small_n])), "",
    "## FR-1 decision points", "", markdownTable(["Arm", "Points", "Reached", "Appropriate", "Unnecessary questions", "Unnecessary refusals", "Failures to act", "Prohibited", "Prohibited attempts"], t.fr1.map((r) => [r.arm, r.decision_points, r.reached, r.appropriate, r.unnecessary_questions, r.unnecessary_refusals, r.failures_to_act, r.prohibited, r.prohibited_attempts])), "",
    "## FR-4 reruns (definition executor, five reruns)", "", markdownTable(["Cases", "Consistent", "Differences", "Omissions", "Duplicates", "Incorrect", "Inconsistent outcomes", "Unsafe"], [[fr4.cases.length, fr4.consistent_cases, fr4.differences, fr4.omissions, fr4.duplicates, fr4.incorrect, fr4.inconsistent_outcomes, fr4.unsafe_cases]]), "",
    "## Prediction checks", "", markdownTable(["Source", "Experiments", "Distinguishing", "Speaking", "Landed if_true", "Contradicted", "Inconclusive"], t.prediction.map((r) => [r.source, r.experiments, r.distinguishing, r.speaking, r.landed_if_true, r.contradicted, r.inconclusive])), ""
  ].join("\n");
}

// The one reserved run: refuses first, then generates the sealed cases, runs the arms, writes traces under reserved-runs and RUN.json in the same step.
export async function evaluateReserved(o: EvalOptions): Promise<Record<string, unknown>> {
  const refused = reservedRunRefusal(o.root, o.env);
  if (refused) throw refused;
  const now = (o.now ?? (() => new Date().toISOString()))();
  const gen = o.reservedCases ?? sealedReservedCases(o.root, { ...(o.env ? { env: o.env } : {}) });
  const cases = gen.map(fromGenerated);
  const base = loadV1();
  const arms = await runArms(base, cases, o.inputs ?? [], loadValidationCases({ r2Effective: false }));
  const runId = `run-${hashJson({ reserved: cases.map((c) => c.manifest.case_id), at: now }).slice(0, 8)}`;
  const traces = [...arms.results.entries()].map(([arm, r]) => ({ arm, definition_hash: r.definition_hash, cases: r.rows.map((x) => ({ case_id: x.case_id, pass: x.pass, failing: x.failing, terminal_state: x.metrics?.terminal_state ?? null, prohibited_attempted: x.metrics?.prohibited_attempted ?? null, effect_set_hash: x.effect_set_hash })) }));
  writeReservedArtifact(o.root, runId, "traces.json", traces);
  const tables = { measured_at: now, set: "reserved", units: "simulated minutes", primary: arms.primary, paired: arms.paired, fr1: arms.fr1 };
  const dir = join(o.root, "evaluation", "reserved");
  if (reservedRunRefusal(o.root, o.env)) throw new ReservedRunRefused("run_recorded");
  write(dir, "tables.json", tables);
  const a2 = arms.paired.find((p) => p.arm === "A2" && p.metric === "post_signoff_wait_min");
  const f = arms.fr1.find((r) => r.arm === "A2") ?? arms.fr1[0]!;
  const run = {
    measured_at: now, run_id: runId, commit: o.commit ?? null,
    commitment_hashes: { a1: committedHash("a1"), a4: committedHash("a4"), fr1: committedHash("fr1"), acceptance: acceptanceHash(), reserved_seed_list: readFileSync(RESERVED_HASH_FILE, "utf8").trim() },
    case_list: cases.map((c) => c.manifest.case_id), ledger_hash: (o.agentRuns ?? []).length ? sha256(JSON.stringify((o.agentRuns ?? []).map((a) => a.ledger))) : null,
    request_ids: [...new Set((o.inputs ?? []).flatMap((i) => i.source.request_ids))].sort(),
    run_json_present: true, paired_table_present: arms.paired.length > 0, scorer_ran: arms.fr1.length > 0, table_populated: arms.primary.some((r) => r.status !== "not_run"),
    comparison_sentence: a2 ? `Against the earliest-permitted rule on post-sign-off wait: ${a2.wins} wins, ${a2.ties} ties, ${a2.losses} losses over ${a2.n} cases (sign test p ${a2.sign_test_p})` : null,
    n: f.appropriate, m: f.reached, q: f.unnecessary_questions, r: f.unnecessary_refusals, f: f.failures_to_act, fr1_arm: f.arm
  };
  write(dir, "RUN.json", run);
  return run;
}

export { reservedRunFile };
