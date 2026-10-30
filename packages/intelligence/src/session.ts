import {
  ExperimentBudget, ExperimentRequest, HypothesisRecord, InsufficientEvidence, Operation, Prediction, WorkflowChangeProposal,
  hashJson, type HypothesisRecord as HR, type Metric, type PredictionCheck, type WorkflowDefinition as WD
} from "@hey-pisgah/contracts";
import { loadV1 } from "@hey-pisgah/hospital";
import { readStream, openStream, type Stream } from "@hey-pisgah/store";
import type { WorldRules } from "@hey-pisgah/simulator";
import { applyOperations, evalCondition } from "@hey-pisgah/workflow";
import { z } from "zod";
import { ExpectedChange, mayUpdate, outcomeClass, type OutcomeClass } from "./delivery.js";
import { runMatched, summarise, type Behaviour, type CaseResult, type Receipt, type Runner } from "./experiments.js";
import { lintExperiment, nonPreparableTargets, type LintResult } from "./lint.js";
import { preconditionTable } from "./preconditions.js";
import { derivedStatistics } from "./stats.js";
import { OP_KINDS, SWEEP_LIMITS, scopedOperations, sweep, sweepView } from "./sweep.js";
import { DiscoveryPool } from "./pool.js";
import { outcomeComparison, type OutcomeComparison } from "./outcomes.js";
import { checkAfter, checkBefore, pairDiagnostics, type Deltas } from "./prediction.js";
import { LEDGER_SHAPES, expectedShapes } from "./shapes.js";
import { UNKNOWN_ID } from "./unknown.js";
import * as views from "./views.js";

export type Arm = "adaptive" | "a3" | "a4" | "prior";
export const STREAMS = { hypotheses: "learning/hypotheses", experiments: "learning/experiments", proposals: "learning/proposals", validations: "learning/validations", outcomes: "learning/outcomes" } as const;
export const sessionStreamId = (runId: string): string => `discovery/${runId}`;

export type ListedExperiment = { ops: Operation[]; case_ids: string[] };
export type Usage = { calls: number; usd: number; max_calls: number; max_usd: number };

export type SessionOptions = {
  storeRoot: string;
  runId: string;
  arm: Arm;
  cycle?: 1 | 2;
  pool?: DiscoveryPool;
  base?: WD;
  world?: WorldRules;
  runner?: Runner;
  // Runs the evaluator's validation pipeline over the proposals stream; the CLI injects it because this package may not import the evaluator.
  validate?: (storeRoot: string) => Promise<void>;
  insufficientEvidence?: boolean;
  a4Order?: readonly ListedExperiment[];
  usage?: () => Usage;
  now?: () => Date;
};

type Result = Record<string, unknown>;

// The uniform unknown_id plus the argument path that held it; the path never carries the id, so it says nothing about other pools.
const unknownField = (field: string, detail?: string): Result => ({ ...UNKNOWN_ID, field, ...(detail ? { detail } : {}) });

// Takes session-only fields off a request, so the strict contract schema still checks the rest.
function split(raw: unknown, keys: readonly string[]): { raw: unknown; extra: Record<string, unknown> } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { raw, extra: {} };
  const rest: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) (keys.includes(k) ? extra : rest)[k] = v;
  return { raw: rest, extra };
}
const refusal = (error: string, message: string, extra: Result = {}): Result => ({ ok: false, error, message, ...extra });
const zodIssues = (e: z.ZodError) => e.issues.slice(0, 8).map((i) => `${i.path.join(".") || "$"}: ${i.message}`);

// Count metrics allow a smaller tolerance than minute metrics.
const MINUTE_METRICS: ReadonlySet<Metric> = new Set(["unnecessary_min", "rework_min", "post_signoff_wait_min", "bed_release_delay_min"]);
export const toleranceCap = (m: Metric): number => (MINUTE_METRICS.has(m) ? 60 : 3);

export const HypothesisInput = z.strictObject({
  statement: z.string().min(1).max(300),
  mechanism: z.string().min(1).max(300),
  subject_refs: z.array(z.string().max(60)).max(12),
  competing: z.union([z.array(z.string()).min(1), z.strictObject({ none_identified_reason: z.string().min(1).max(200) })]),
  evidence: z.array(z.strictObject({ event_id: z.string(), case_id: z.string(), stance: z.enum(["supports", "contradicts", "context"]), note: z.string().max(140) })).min(3).max(12),
  if_true: Prediction,
  if_false: Prediction,
  refuted_if: z.string().min(1).max(300),
  revises: z.string().nullable().optional()
});

export const StatusInput = z.strictObject({
  hypothesis_id: z.string(),
  status: z.enum(["retained", "rejected", "insufficient_evidence"]),
  experiment_ids: z.array(z.string()).max(8),
  evidence_event_ids: z.array(z.string()).max(12),
  note: z.string().max(300),
  insufficient: InsufficientEvidence.optional()
});

export const ProposalInput = WorkflowChangeProposal.omit({ proposal_id: true, viewed_case_ids: true, status: true, hash: true });

// The side effects a proposal states: each metric that moved the wrong way on the cases its cited experiments moved, copied from their receipts.
export const TradeOff = z.strictObject({ metric: z.string().max(40), sum_delta: z.number(), note: z.string().max(200) });
export const TradeOffs = z.array(TradeOff).max(13);
export type SideEffect = { metric: Metric; sum_delta: number; cases: number };

// Metrics where a rise is a cost, and the one where a fall is; the primary metric is the post sign-off wait.
const COST_UP: readonly Metric[] = ["prohibited_attempted", "prohibited_executed", "unplanned_interventions", "unnecessary_docs", "unnecessary_min", "duplicates", "stale_actions", "rework_events", "rework_min", "bed_release_delay_min"];
const COST_DOWN: readonly Metric[] = ["required_steps_done"];

export function sideEffects(x: { receipt?: Receipt | null; deltas: Deltas; outcome_class?: OutcomeClass | null }): SideEffect[] {
  if (!x.receipt || x.outcome_class !== "delivered_outcome_better") return [];
  const moved = x.receipt.target.filter((t) => t.moved).map((t) => t.case_id);
  const out: SideEffect[] = [];
  for (const m of [...COST_UP, ...COST_DOWN]) {
    const ds = moved.map((c) => x.deltas[c]?.[m]).filter((d): d is number => typeof d === "number");
    const sum = ds.reduce((a, b) => a + b, 0);
    const cost = COST_UP.includes(m) ? sum > 0 : sum < 0;
    if (cost) out.push({ metric: m, sum_delta: sum, cases: ds.filter((d) => (COST_UP.includes(m) ? d > 0 : d < 0)).length });
  }
  return out;
}

export const NOTE_LIMIT = 20;
export const NoteInput = z.strictObject({ note: z.string().trim().min(1).max(600) });

// The fields the investigation ledger keeps beside each hypothesis: its predicted size, the experiment that would falsify it, and what a null result would mean.
export const LedgerFields = z.strictObject({
  predicted_magnitude_min: z.number().int().min(0).max(600),
  falsifying_experiment: z.string().trim().min(1).max(300),
  if_null: z.string().trim().min(1).max(300)
});
export type LedgerFields = z.infer<typeof LedgerFields>;
const LEDGER_KEYS = ["predicted_magnitude_min", "falsifying_experiment", "if_null"] as const;

// The question a cycle answers: the hypotheses its experiment must tell apart and the step behaviour it expects to move.
export const QuestionInput = z.strictObject({ hypothesis_ids: z.array(z.string()).min(2).max(4), question: z.string().trim().min(1).max(300), expected_change: ExpectedChange });
export type Question = z.infer<typeof QuestionInput>;

export const SweepInput = z.strictObject({
  op_kinds: z.array(z.enum(OP_KINDS)).min(1).max(OP_KINDS.length),
  case_ids: z.array(z.string()).min(1).max(SWEEP_LIMITS.cases),
  top_k: z.number().int().min(1).max(8).optional(),
  target_steps: z.array(z.string().max(12)).min(1).max(6).optional(),
  pairs: z.boolean().optional()
});

export const DEFINITION_UNCHANGED = "The workflow definition is unchanged since your first read of it in this cycle; its short form stays in this conversation.";

export const EndInput = z.strictObject({
  result: z.enum(["no_change_warranted", "insufficient_evidence"]),
  note: z.string().min(1).max(600),
  evidence_event_ids: z.array(z.string()).max(20),
  insufficient: InsufficientEvidence.optional()
});

export const RollbackInput = z.strictObject({ version: z.number().int().min(1), note: z.string().min(1).max(600), evidence_event_ids: z.array(z.string()).min(1).max(20) });

export type StoredExperiment = {
  experiment_id: string;
  session_id: string;
  source: "request" | "listed";
  request: unknown;
  status: "completed" | "aborted";
  base_hash: string;
  intervention_hash: string | null;
  hypothesis_hashes: Record<string, string>;
  warnings: string[];
  cases: CaseResult[];
  summary: Record<string, number | null>;
  deltas: Deltas;
  prediction_check: PredictionCheck;
  abort_reason: string | null;
  behaviour: Behaviour | null;
  no_pair_reason: string | null;
  expected_change?: ExpectedChange | null;
  receipt?: Receipt | null;
  delivered?: boolean | null;
  outcome_class?: OutcomeClass | null;
  lint?: LintResult | null;
};

export type StopReason = "dev_valid_proposal" | "declared_negative" | "lockout" | "proposals_exhausted" | "prior_proposal_submitted";

// At most this many step time and action differences per case reach the model; the stored record keeps them all.
export const DIFFS_PER_CASE = 8;

// One case of an experiment as the model reads it: control metrics, every delta, and the intervention fields a delta cannot carry.
function caseView(c: CaseResult): Result {
  const { terminal_state: t, agent_actions: a, staff_min_by_role: m, ...metrics } = c.control;
  const i = c.intervention;
  const out: Result = { case_id: c.case_id, event_logs_identical: c.event_logs_identical, control: { ...metrics, terminal_state: t, agent_actions: a, staff_min_by_role: m }, delta: c.delta, intervention: { terminal_state: i.terminal_state, agent_actions: i.agent_actions, staff_min_by_role: i.staff_min_by_role } };
  out.step_time_diffs = c.step_time_diffs.slice(0, DIFFS_PER_CASE);
  out.action_diff = c.action_diff.slice(0, DIFFS_PER_CASE);
  const more = Math.max(0, c.step_time_diffs.length - DIFFS_PER_CASE) + Math.max(0, c.action_diff.length - DIFFS_PER_CASE);
  if (more) out.diffs_not_shown = more;
  return out;
}

// One investigation session: the tools' state, the budgets, and the append-only learning streams.
export class Session {
  readonly pool: DiscoveryPool;
  readonly base: WD;
  readonly hypotheses = new Map<string, HR>();
  readonly experiments = new Map<string, StoredExperiment>();
  readonly proposals = new Map<string, WorkflowChangeProposal>();
  readonly viewed = new Set<string>();
  readonly frozen = new Set<string>();
  readonly notes: string[] = [];
  readonly ledgerFields = new Map<string, LedgerFields>();
  readonly observations: string[] = [];
  // The tools the controller offers in the current stage; null outside the investigation cycle.
  allowedTools: ReadonlySet<string> | null = null;
  question: Question | null = null;
  cycle = 0;
  private definitionRead: { turn: number; hash: string; cycle: number } | null = null;
  counters = { hypothesis_schema_errors: 0, definition_unchanged: 0, timeline_pages: 0, experiments_used: 0, invalid_requests: 0, lint_refusals: 0, question_refusals: 0, not_delivered: 0, delivered: 0, informative: 0, zod_streak: 0, repairs: 0, listed_used: 0, proposals_used: 0, say_do_mismatches: 0, retains: 0, rejects: 0, stage_refusals: 0, statistics_reads: 0, sweeps: 0, sweep_refusals: 0, simulations: 0, trade_off_refusals: 0 };
  stop: { reason: StopReason; detail: string } | null = null;
  private readonly streams: { hypotheses: Stream; experiments: Stream; proposals: Stream; log: Stream };
  private serial = 0;

  constructor(readonly o: SessionOptions) {
    this.pool = o.pool ?? new DiscoveryPool();
    this.base = o.base ?? loadV1();
    this.streams = {
      hypotheses: openStream(o.storeRoot, STREAMS.hypotheses, { writer: true }),
      experiments: openStream(o.storeRoot, STREAMS.experiments, { writer: true }),
      proposals: openStream(o.storeRoot, STREAMS.proposals, { writer: true }),
      log: openStream(o.storeRoot, sessionStreamId(o.runId), { writer: true })
    };
  }

  get runId(): string { return this.o.runId; }
  get locked(): boolean { return this.counters.invalid_requests >= ExperimentBudget.invalidRequestsBeforeLockout; }
  private clocks() { return { occurred_at: 0, recorded_at: 0, wall_at: (this.o.now?.() ?? new Date()).toISOString() }; }
  private nextId(prefix: "h" | "x" | "p"): string { this.serial += 1; return `${prefix}-${hashJson({ run: this.o.runId, prefix, n: this.serial }).slice(0, 8)}`; }

  log(recordType: string, payload: unknown): void {
    this.streams.log.append(recordType, payload, { recorded_at: 0, occurred_at: 0 });
  }

  close(): void {
    for (const s of Object.values(this.streams)) s.close();
  }

  private budgetView(): Result {
    const u = this.o.usage?.();
    const b: Result = { proposals_left: this.proposalLimit() - this.counters.proposals_used };
    if (this.o.arm === "adaptive") Object.assign(b, { experiments_left: ExperimentBudget.experiments - this.counters.experiments_used, invalid_requests_before_lockout: Math.max(0, ExperimentBudget.invalidRequestsBeforeLockout - this.counters.invalid_requests) });
    if (this.o.arm === "a4") b.listed_experiments_left = Math.min(ExperimentBudget.experiments, this.o.a4Order?.length ?? 0) - this.counters.listed_used;
    if (u) Object.assign(b, { model_calls_left: Math.max(0, u.max_calls - u.calls), usd_left: Math.max(0, Math.round((u.max_usd - u.usd) * 100) / 100) });
    return b;
  }

  private proposalLimit(): number { return this.o.arm === "prior" ? 1 : ExperimentBudget.proposals; }
  private view(id: string): void { this.viewed.add(id); }
  private active(): HR[] { return [...this.hypotheses.values()].filter((h) => h.status !== "revised" && h.status !== "rejected"); }
  private factsOf = (id: string) => this.pool.get(id)?.facts ?? null;

  // Read tools: every id outside the discovery pool gets the same unknown_id.
  listCases(): Result { return views.listCases(this.pool); }

  // A second cycle reads the verified outcomes and observed journeys before anything else it concludes; this is the read, figures side by side with the histories.
  outcomesRead = false;
  private comparison: OutcomeComparison | null = null;
  hasNewEvidence(): boolean { return (this.o.cycle ?? 1) === 2 && this.pool.ids().some((id) => this.pool.get(id)!.source !== "history"); }
  compareOutcomes(): Result {
    if (!this.hasNewEvidence()) return refusal("not_available", "This tool is not available in this session.");
    const c = this.comparison ?? outcomeComparison(this.pool, this.base);
    this.comparison = c;
    for (const id of c.read_case_ids) this.view(id);
    this.outcomesRead = true;
    this.log("outcomes.compared", { read_case_ids: c.read_case_ids, contradicts_adopted: c.contradicts_adopted, supports_adopted: c.supports_adopted });
    this.observe(`outcomes: ${c.after.map((r) => `${r.case_id} v${r.workflow_version ?? "?"} wait ${r.post_signoff_wait_min ?? "none"} against ${r.before_median_wait_min ?? "none"} (${r.direction})`).join("; ")}; ${c.observed.length} observed journeys`);
    return { ok: true, ...c };
  }
  // The refusal a second cycle gets when it concludes before reading the outcomes, or declares no change while its outcomes contradict the version in force.
  private secondCycleRefusal(result: "proposal" | "no_change_warranted" | "insufficient_evidence", cites: readonly string[] = []): Result | null {
    if (!this.hasNewEvidence()) return null;
    if (!this.outcomesRead) return refusal("read_outcomes_first", "In a second cycle, read the verified outcomes and observed journeys with compare_outcomes before a proposal or a result.");
    if (result === "no_change_warranted" && this.comparison?.contradicts_adopted && !this.citesWorse(cites)) return refusal("outcomes_contradict", "The verified outcomes under the adopted version are worse than the histories of their ward. A result that keeps the version must cite an event of those outcomes; otherwise propose a revision, propose a rollback, or end with insufficient_evidence and the measurement that would settle it.", { after: this.comparison.after });
    return null;
  }
  // Whether the cited events include one of an outcome that did worse under a changed version.
  private citesWorse(cites: readonly string[]): boolean {
    const worse = new Set((this.comparison?.after ?? []).filter((r) => r.direction === "worse" && r.workflow_version !== null && r.workflow_version !== 1).map((r) => r.case_id));
    return cites.some((id) => worse.has(this.pool.event(id)?.case_id ?? ""));
  }

  // A second cycle may end by proposing that a person suspend an adopted version, citing that version's outcomes; the person decides.
  proposeRollback(raw: unknown): Result {
    const parsed = RollbackInput.safeParse(raw);
    if (!parsed.success) { this.counters.repairs += 1; return refusal("invalid_arguments", "The arguments do not match the schema.", { issues: zodIssues(parsed.error) }); }
    const a = parsed.data;
    if (!this.hasNewEvidence()) return refusal("not_available", "This tool is not available in this session.");
    if (!this.outcomesRead) return refusal("read_outcomes_first", "In a second cycle, read the verified outcomes and observed journeys with compare_outcomes before a proposal or a result.");
    if (a.evidence_event_ids.some((e) => !this.pool.event(e))) return UNKNOWN_ID;
    const under = new Set((this.comparison?.after ?? []).filter((r) => r.workflow_version === a.version).map((r) => r.case_id));
    if (a.version === 1 || !under.size) return refusal("unknown_version", "No verified outcome ran under that version, so there is nothing recorded to roll back.", { versions: [...new Set((this.comparison?.after ?? []).map((r) => r.workflow_version))] });
    if (!a.evidence_event_ids.some((id) => under.has(this.pool.event(id)?.case_id ?? ""))) return refusal("evidence_rule", "A rollback cites at least one recorded event of an outcome under that version.");
    this.log("session.result", { result: "rollback_proposed", version: a.version, note: a.note, evidence_event_ids: a.evidence_event_ids, approval: "a person" });
    this.stopWith("declared_negative", "rollback_proposed");
    return { ok: true, result: "rollback_proposed", version: a.version, approval: "a person" };
  }

  // A record_hypothesis schema error with the expected shape of each failing field, counted per run.
  private hypothesisSchemaError(message: string, error: z.ZodError): Result {
    this.counters.repairs += 1;
    this.counters.hypothesis_schema_errors += 1;
    return refusal("invalid_arguments", message, { issues: zodIssues(error), expected: expectedShapes(error) });
  }

  timeline(a: { case_id: string; order: "occurred" | "recorded"; offset?: number | undefined; limit?: number | undefined; kinds?: string[] | undefined }, cap?: number): Result {
    const c = this.pool.get(a.case_id);
    if (!c) return UNKNOWN_ID;
    this.view(c.case_id);
    this.counters.timeline_pages += 1;
    return views.timeline(c, a, cap);
  }

  record(a: { case_id: string; record_kind?: string | undefined; document_id?: string | undefined }): Result {
    const c = this.pool.get(a.case_id);
    if (!c) return UNKNOWN_ID;
    this.view(c.case_id);
    return views.recordView(c, a) ?? refusal("not_recorded", "This case has no such record or document.");
  }

  intervals(a: { case_ids: string[]; from: views.Selector; to: views.Selector; clock: "occurred" | "recorded" }): Result {
    const cs = a.case_ids.map((id) => this.pool.get(id));
    if (cs.some((c) => c === null)) return UNKNOWN_ID;
    for (const c of cs) this.view(c!.case_id);
    return views.intervals(cs as NonNullable<(typeof cs)[number]>[], a.from, a.to, a.clock);
  }

  queue(a: { case_id: string; at_min: number }): Result {
    const c = this.pool.get(a.case_id);
    if (!c) return UNKNOWN_ID;
    this.view(c.case_id);
    return views.queueSnapshot(c, a.at_min);
  }

  staff(a: { case_id: string; role: string }): Result {
    const c = this.pool.get(a.case_id);
    if (!c) return UNKNOWN_ID;
    this.view(c.case_id);
    return views.staffActivity(c, a.role);
  }

  requirements(a: { ward_id?: string | undefined }): Result { return views.wardRequirements(a.ward_id) ?? UNKNOWN_ID; }
  // The full definition on the first read of a cycle; later reads in the same cycle answer with the turn and hash of that read and no body.
  definition(turn?: number): Result {
    const hash = this.base.definition_hash;
    if (turn !== undefined && this.definitionRead && this.definitionRead.hash === hash && this.definitionRead.cycle === this.cycle) {
      this.counters.definition_unchanged += 1;
      return { ok: true, unchanged: true, read_at_turn: this.definitionRead.turn, definition_hash: hash, note: DEFINITION_UNCHANGED };
    }
    if (turn !== undefined) this.definitionRead = { turn, hash, cycle: this.cycle };
    return views.definitionView(this.base);
  }

  // Per-step waiting, critical-path membership and the ranking of critical segments over the pool's recorded cases.
  statistics(a: { top?: number | undefined } = {}): Result {
    this.counters.statistics_reads += 1;
    const cases = this.pool.ids().map((id) => this.pool.get(id)!).filter((c) => c.events.length > 0);
    for (const c of cases) this.view(c.case_id);
    const out = derivedStatistics(this.base, cases, Math.min(12, Math.max(1, a.top ?? 8)));
    const ranking = out.ranking as { rank: number; segment: string; cases: number; total_wait_min: number; total_work_min: number }[];
    this.observe(`statistics: top segments ${ranking.slice(0, 4).map((r) => `${r.rank}. ${r.segment} ${r.cases} cases wait ${r.total_wait_min} work ${r.total_work_min}`).join("; ")}`);
    return { ok: true, ...out };
  }

  preconditions(): Result { return { ok: true, ...preconditionTable() }; }

  // The neutral sweep: every legal single operation of the named kinds touching the scope steps and every pair of them, on matched cases.
  runSweep(raw: unknown): Result {
    if (this.o.arm !== "adaptive") return refusal("not_available", "This tool is not available in this session.");
    const parsed = SweepInput.safeParse(raw);
    if (!parsed.success) { this.counters.repairs += 1; return refusal("invalid_arguments", "The arguments do not match the schema.", { issues: zodIssues(parsed.error) }); }
    if (this.counters.sweeps >= SWEEP_LIMITS.sweeps) return refusal("budget_exhausted", `At most ${SWEEP_LIMITS.sweeps} sweeps run in a session.`);
    const a = parsed.data;
    const files = a.case_ids.map((id) => this.pool.experimentable(id));
    const bad = files.findIndex((f) => f === null);
    if (bad >= 0 || new Set(a.case_ids).size !== a.case_ids.length) return unknownField(`case_ids[${Math.max(0, bad)}]`);
    let scope: string[];
    if (a.target_steps) {
      const miss = a.target_steps.findIndex((st) => !this.base.steps.some((x) => x.step_id === st));
      if (miss >= 0) return unknownField(`target_steps[${miss}]`);
      scope = [...new Set(a.target_steps)].sort();
    } else {
      const cases = this.pool.ids().map((id) => this.pool.get(id)!).filter((c) => c.events.length > 0);
      const ranking = derivedStatistics(this.base, cases, a.top_k ?? 3).ranking as { from: string | null; to: string }[];
      scope = [...new Set(ranking.flatMap((r) => [r.from, r.to]).filter((x): x is string => x !== null))].sort();
    }
    const wards = [...new Set(this.pool.caseFacts().map((f) => String(f["ward_id"])))];
    const singles = scopedOperations(this.base, new Set(scope), a.op_kinds, wards);
    if (singles.length > SWEEP_LIMITS.singles || singles.length === 0) {
      this.counters.sweep_refusals += 1;
      const per = Object.fromEntries(a.op_kinds.map((k) => [k, scopedOperations(this.base, new Set(scope), [k], wards).length]));
      return refusal("sweep_size", `A sweep takes 1 to ${SWEEP_LIMITS.singles} single operations; this scope gives ${singles.length}. Narrow op_kinds or target_steps, or lower top_k.`, { scope_steps: scope, singles_per_kind: per });
    }
    this.counters.sweeps += 1;
    const out = sweep(this.base, singles, files as NonNullable<(typeof files)[number]>[], { caseFacts: this.pool.caseFacts(), ...(this.o.world ? { world: this.o.world } : {}), pairs: a.pairs ?? true });
    this.counters.simulations += out.simulations;
    for (const c of a.case_ids) this.view(c);
    const view = sweepView(out, scope);
    this.streams.experiments.append("sweep.completed", { session_id: this.o.runId, request: a, ...view }, { recorded_at: 0, occurred_at: 0 });
    const best = (view.best_by_wait as { ops: unknown; sum_wait_delta: number; delivered: boolean }[]).slice(0, 3);
    this.observe(`sweep ${this.counters.sweeps} over ${scope.join(",")} (${a.op_kinds.join(",")}) on ${a.case_ids.length} cases: ${out.singles} singles, ${out.pairs} pairs; best ${best.map((b) => `${JSON.stringify(b.ops)} sum ${b.sum_wait_delta}${b.delivered ? "" : " not delivered"}`).join("; ")}`);
    return { ok: true, ...view, budget: { ...this.budgetView(), sweeps_left: SWEEP_LIMITS.sweeps - this.counters.sweeps } };
  }

  // One line the ledger keeps from a tool result, written by the session, never by the model.
  observe(line: string): void {
    if (this.observations.at(-1) === line) return;
    this.observations.push(line.slice(0, 400));
    this.log("ledger.observation", { cycle: this.cycle, line });
  }

  // Records a hypothesis; ids are checked against the pool and the session, predictions against the per-metric caps.
  recordHypothesis(rawIn: unknown): Result {
    const needsLedger = this.o.arm === "adaptive";
    const { raw, extra } = needsLedger ? split(rawIn, LEDGER_KEYS) : { raw: rawIn, extra: {} };
    const parsed = HypothesisInput.safeParse(raw);
    if (!parsed.success) return this.hypothesisSchemaError("The arguments do not match the schema.", parsed.error);
    const a = parsed.data;
    const competing = Array.isArray(a.competing) ? a.competing : null;
    const ci = competing ? competing.findIndex((id) => !this.hypotheses.has(id)) : -1;
    if (ci >= 0) return unknownField(`competing[${ci}]`);
    if (a.revises && (!this.hypotheses.has(a.revises) || this.hypotheses.get(a.revises)!.status === "revised")) return unknownField("revises");
    const ei = a.evidence.findIndex((ev) => this.pool.event(ev.event_id)?.case_id !== ev.case_id);
    if (ei >= 0) return unknownField(`evidence[${ei}]`, "The event_id is not an event of the case_id given with it in this pool.");
    for (const [label, pr] of [["if_true", a.if_true], ["if_false", a.if_false]] as const) {
      const k = "cases" in pr.scope ? pr.scope.cases.findIndex((id) => !this.pool.get(id)) : -1;
      if (k >= 0) return unknownField(`${label}.scope.cases[${k}]`);
      if (pr.tolerance_min > toleranceCap(pr.metric)) return refusal("tolerance_cap", `tolerance_min for ${pr.metric} may be at most ${toleranceCap(pr.metric)}.`);
    }
    const lf = needsLedger ? LedgerFields.safeParse(extra) : null;
    if (lf && !lf.success) { this.counters.repairs += 1; this.counters.hypothesis_schema_errors += 1; return refusal("invalid_arguments", "The arguments do not match the schema.", { issues: zodIssues(lf.error), expected: LEDGER_SHAPES }); }
    const id = this.nextId("h");
    const content = { session_id: this.o.runId, statement: a.statement, mechanism: a.mechanism, subject_refs: a.subject_refs, competing: a.competing, evidence: a.evidence, if_true: a.if_true, if_false: a.if_false, refuted_if: a.refuted_if, revises: a.revises ?? null };
    const created = this.clocks();
    const rec = { hypothesis_id: id, ...content, created, hash: hashJson(content), status: "open" as const, status_history: [{ status: "open" as const, at: created, evidence_event_ids: [], experiment_ids: [], note: "recorded" }] };
    const checked = HypothesisRecord.safeParse(rec);
    if (!checked.success) return this.hypothesisSchemaError("The hypothesis breaks a record rule.", checked.error);
    this.hypotheses.set(id, checked.data as HR);
    this.streams.hypotheses.append("hypothesis.recorded", checked.data, { recorded_at: 0, occurred_at: 0 });
    if (lf?.success) { this.ledgerFields.set(id, lf.data); this.streams.hypotheses.append("hypothesis.ledger_fields", { hypothesis_id: id, session_id: this.o.runId, ...lf.data }, { recorded_at: 0, occurred_at: 0 }); }
    for (const c of new Set(a.evidence.map((e) => e.case_id))) this.view(c);
    if (a.revises) this.applyStatus(a.revises, "revised", [], [], `revised by ${id}`);
    return { ok: true, hypothesis_id: id, hash: rec.hash, status: "open" };
  }

  private applyStatus(id: string, status: HR["status"], experimentIds: string[], eventIds: string[], note: string, extra: Result = {}): void {
    const h = this.hypotheses.get(id)!;
    const at = this.clocks();
    const next = { ...h, status, status_history: [...h.status_history, { status, at, evidence_event_ids: eventIds, experiment_ids: experimentIds, note }] };
    this.hypotheses.set(id, next);
    this.streams.hypotheses.append("hypothesis.status_changed", { hypothesis_id: id, session_id: this.o.runId, status, at, evidence_event_ids: eventIds, experiment_ids: experimentIds, note, ...extra }, { recorded_at: 0, occurred_at: 0 });
  }

  // Retain needs a cited experiment where the app's check landed if_true; reject needs if_false, a contradiction, or cited events alone; a refusal is a say-do mismatch.
  setStatus(raw: unknown): Result {
    const parsed = StatusInput.safeParse(raw);
    if (!parsed.success) { this.counters.repairs += 1; return refusal("invalid_arguments", "The arguments do not match the schema.", { issues: zodIssues(parsed.error) }); }
    const a = parsed.data;
    const h = this.hypotheses.get(a.hypothesis_id);
    if (!h || a.experiment_ids.some((x) => !this.experiments.has(x)) || a.evidence_event_ids.some((e) => !this.pool.event(e))) return UNKNOWN_ID;
    if (h.status === "revised") return refusal("revised", "This hypothesis was revised; set the status of the newer record.");
    const exps = a.experiment_ids.map((x) => this.experiments.get(x)!).filter((x) => x.status === "completed");
    const landed = exps.map((x) => x.prediction_check.after?.per_hypothesis[h.hypothesis_id]?.landed ?? null);
    let ok = false;
    let rule = "";
    if (a.status === "retained") {
      this.counters.retains += 1;
      ok = landed.includes("if_true");
      rule = "A retained status needs a cited experiment whose result matches this hypothesis's if_true prediction.";
    } else if (a.status === "rejected") {
      this.counters.rejects += 1;
      const contradicted = exps.some((x) => x.prediction_check.after?.contradicted.includes(h.hypothesis_id));
      ok = a.experiment_ids.length ? landed.includes("if_false") || contradicted : a.evidence_event_ids.length > 0;
      rule = "A rejected status needs a cited experiment whose result matches this hypothesis's if_false prediction or contradicts its if_true prediction, or recorded events when no experiment is cited.";
    } else {
      if (!this.o.insufficientEvidence) return refusal("not_available", "This status is not available in this session.");
      ok = a.insufficient !== undefined && a.insufficient.distinguishes.every((d) => this.hypotheses.has(d));
      rule = "This status needs the missing measurement and the hypotheses it would tell apart.";
    }
    if (!ok) {
      if (a.status !== "insufficient_evidence") this.counters.say_do_mismatches += 1;
      this.streams.hypotheses.append("hypothesis.status_refused", { hypothesis_id: h.hypothesis_id, session_id: this.o.runId, wanted: a.status, experiment_ids: a.experiment_ids, evidence_event_ids: a.evidence_event_ids, note: a.note, landed }, { recorded_at: 0, occurred_at: 0 });
      return refusal("status_refused", rule);
    }
    this.applyStatus(h.hypothesis_id, a.status, a.experiment_ids, a.evidence_event_ids, a.note, a.insufficient ? { insufficient: a.insufficient } : {});
    return { ok: true, hypothesis_id: h.hypothesis_id, status: a.status };
  }

  private invalid(stage: string, raw: unknown, errors: string[], answer: Result): Result {
    this.counters.invalid_requests += 1;
    this.counters.experiments_used += 1;
    this.streams.experiments.append("experiment.invalid", { session_id: this.o.runId, stage, errors, request_hash: hashJson(JSON.parse(JSON.stringify(raw ?? null))), invalid_requests: this.counters.invalid_requests }, { recorded_at: 0, occurred_at: 0 });
    if (this.locked) this.stopWith("lockout", `${this.counters.invalid_requests} refused experiment requests`);
    return answer === UNKNOWN_ID ? UNKNOWN_ID : { ...answer, budget: this.budgetView() };
  }

  // The loop calls this after repeated identical tool calls; the run ends as a declared negative with reason stalled.
  stall(repeats: number): void {
    this.log("session.result", { result: "stalled", note: `${repeats} identical tool calls in a row`, evidence_event_ids: [] });
    this.stopWith("declared_negative", "stalled");
  }

  private stopWith(reason: StopReason, detail: string): void {
    if (!this.stop) this.stop = { reason, detail };
  }

  private resolveBase(b: ExperimentRequest["base"]): WD | null {
    if ("version" in b) return b.version === this.base.version ? this.base : null;
    const p = this.proposals.get(b.proposal_id);
    if (!p) return null;
    const r = applyOperations(this.base, p.ops, { caseFacts: this.pool.caseFacts() });
    return r.ok ? r.definition : null;
  }

  // Validates in the published order (schema, ids, definition rules, the pre-run lint), then runs matched control and intervention arms; the result carries numbers, diffs and a receipt.
  runExperiment(rawIn: unknown): Result {
    if (this.o.arm !== "adaptive") return refusal("not_available", "This tool is not available in this session.");
    if (this.locked) return refusal("locked_out", "Three refused requests ended access to experiments.");
    if (this.counters.experiments_used >= ExperimentBudget.experiments) return refusal("budget_exhausted", "No experiments are left.");
    const { raw, extra } = split(rawIn, ["expected_change"]);
    const parsed = ExperimentRequest.safeParse(raw);
    const ex = ExpectedChange.safeParse(extra.expected_change ?? this.question?.expected_change);
    if (!parsed.success || !ex.success) {
      this.counters.zod_streak += 1;
      this.counters.repairs += 1;
      const issues = [...(parsed.success ? [] : zodIssues(parsed.error)), ...(ex.success ? [] : zodIssues(ex.error).map((i) => `expected_change.${i}`))];
      if (this.counters.zod_streak > 2) { this.counters.zod_streak = 0; return this.invalid("schema", raw, issues, refusal("invalid_request", "The request failed the schema three times and counts as refused.", { issues })); }
      return refusal("invalid_arguments", "The request does not match the schema.", { issues, repairs_left: 3 - this.counters.zod_streak });
    }
    this.counters.zod_streak = 0;
    const q = parsed.data;
    const live = (id: string) => this.hypotheses.has(id) && this.hypotheses.get(id)!.status !== "revised";
    const base = this.resolveBase(q.base);
    const files = q.case_ids.map((id) => this.pool.experimentable(id));
    if (!live(q.hypothesis_id) || q.distinguishes.some((d) => !live(d)) || !base || files.some((f) => f === null) || new Set(q.case_ids).size !== q.case_ids.length) return this.invalid("ids", raw, ["unknown id"], UNKNOWN_ID);
    const blocked = nonPreparableTargets(base, q.ops);
    if (blocked.length) return this.lintRefusal(rawIn, q.ops, q.case_ids.length, { ok: false, reasons: ["not_preparable"], detail: { not_preparable: blocked, rule: "Operations may target only steps whose action is prepare_document and that are not external." } });
    const applied = applyOperations(base, q.ops, { caseFacts: this.pool.caseFacts() });
    if (!applied.ok) return this.invalid("static", raw, applied.errors.map((e) => `${e.code}: ${e.message}`), refusal("invalid_request", "The change breaks a definition rule.", { stage: "static", errors: applied.errors.map((e) => `${e.code}: ${e.message}`) }));
    const cited = [...new Set([q.hypothesis_id, ...q.distinguishes])].map((id) => this.hypotheses.get(id)!);
    const previous = [...this.experiments.values()].filter((x) => x.source === "request" && x.status === "completed").map((x) => ({ experiment_id: x.experiment_id, intervention_hash: x.intervention_hash ?? "", base_hash: x.base_hash, case_ids: (x.request as { case_ids: string[] }).case_ids }));
    const lint = lintExperiment({ base, next: applied.definition, ops: q.ops, caseIds: q.case_ids, cited, previous, factsOf: this.factsOf, expectedStep: ex.data.step, nextHash: applied.definition.definition_hash, baseHash: base.definition_hash });
    if (!lint.ok) return this.lintRefusal(rawIn, q.ops, q.case_ids.length, lint);
    return this.execute("request", { ...q, expected_change: ex.data }, base, q.ops, files as NonNullable<(typeof files)[number]>[], this.active(), cited.map((h) => h.hypothesis_id), null, ex.data, lint);
  }

  // A lint refusal: logged, observed in the ledger, no experiment used and not counted toward the lockout.
  private lintRefusal(rawIn: unknown, ops: readonly Operation[], cases: number, lint: LintResult): Result {
    this.counters.lint_refusals += 1;
    this.streams.experiments.append("experiment.lint_refused", { session_id: this.o.runId, request: rawIn, lint, lint_refusals: this.counters.lint_refusals }, { recorded_at: 0, occurred_at: 0 });
    this.observe(`lint refused ${JSON.stringify(ops)} on ${cases} cases: ${lint.reasons.join(", ")}`);
    return refusal("lint_refused", "The pre-run lint refused this experiment; it used no experiment and is not counted as a refused request.", { reasons: lint.reasons, lint: lint.detail, budget: this.budgetView() });
  }

  // Records the question this cycle's experiment must answer; refused unless two of the named hypotheses can be told apart on some pool case.
  chooseQuestion(raw: unknown): Result {
    const parsed = QuestionInput.safeParse(raw);
    if (!parsed.success) { this.counters.repairs += 1; return refusal("invalid_arguments", "The arguments do not match the schema.", { issues: zodIssues(parsed.error) }); }
    const a = parsed.data;
    const live = (id: string) => this.hypotheses.has(id) && !["revised", "rejected"].includes(this.hypotheses.get(id)!.status);
    const bad = a.hypothesis_ids.findIndex((id) => !live(id));
    if (bad >= 0) return unknownField(`hypothesis_ids[${bad}]`);
    if (!this.base.steps.some((st) => st.step_id === a.expected_change.step)) return unknownField("expected_change.step");
    const named = a.hypothesis_ids.map((id) => this.hypotheses.get(id)!);
    const pairs = this.distinguishablePairs(named);
    if (pairs.length === 0) {
      this.counters.question_refusals += 1;
      return refusal("no_discrimination", "No two of the named hypotheses can be told apart: two if_true predictions are told apart only when they name the same metric, share an experimentable pool case, and the delta ranges they allow (intervention minus control) do not overlap.", { pairs: pairDiagnostics(named, this.pool.ids().filter((id) => this.pool.experimentable(id) !== null), this.factsOf) });
    }
    this.question = a;
    this.log("question.chosen", { cycle: this.cycle, ...a, distinguishable: pairs });
    return { ok: true, question: a.question, hypothesis_ids: a.hypothesis_ids, expected_change: a.expected_change, distinguishable_pairs: pairs };
  }

  // Pairs of active hypotheses whose if_true predictions are disjoint on one metric for a shared experimentable pool case.
  distinguishablePairs(act: readonly HR[] = this.active()): [string, string][] {
    return checkBefore(act, this.pool.ids().filter((id) => this.pool.experimentable(id) !== null), this.factsOf).distinguishes;
  }

  // The predetermined list for the A4 arm: the app chooses the experiment, the model only reads the result.
  nextListed(): Result {
    if (this.o.arm !== "a4") return refusal("not_available", "This tool is not available in this session.");
    const order = this.o.a4Order ?? [];
    const i = this.counters.listed_used;
    if (i >= order.length || i >= ExperimentBudget.experiments) return refusal("budget_exhausted", "No listed experiments are left.");
    const entry = order[i]!;
    this.counters.listed_used += 1;
    const files = entry.case_ids.map((id) => this.pool.experimentable(id));
    if (files.some((f) => f === null)) throw new Error(`listed experiment ${i} names a case outside the discovery pool`);
    return this.execute("listed", { index: i, ops: entry.ops, case_ids: entry.case_ids }, this.base, entry.ops, files as NonNullable<(typeof files)[number]>[], this.active(), [], null);
  }

  private execute(source: "request" | "listed", request: unknown, base: WD, ops: readonly Operation[], files: NonNullable<ReturnType<DiscoveryPool["experimentable"]>>[], act: HR[], cited: string[], noPair: string | null, expected: ExpectedChange | null = null, lint: LintResult | null = null): Result {
    const caseIds = files.map((f) => f.case_id);
    const before = checkBefore(act, caseIds, this.factsOf);
    const xid = this.nextId("x");
    const m = runMatched(base, ops, files, { caseFacts: this.pool.caseFacts(), experimentId: xid, ...(expected ? { expected } : {}), ...(this.o.world ? { world: this.o.world } : {}), ...(this.o.runner ? { runner: this.o.runner } : {}) });
    if (!m.ok) {
      if (source === "listed") throw new Error(`listed experiment refused: ${m.errors.join("; ")}`);
      return this.invalid(m.stage, request, m.errors, refusal("invalid_request", "The change breaks a definition rule.", { stage: m.stage, errors: m.errors }));
    }
    if (source === "request") this.counters.experiments_used += 1;
    this.counters.simulations += 2 * caseIds.length;
    for (const c of caseIds) this.view(c);
    const hashes: Record<string, string> = {};
    for (const id of new Set([...cited, ...before.speaks_to])) {
      const h = this.hypotheses.get(id);
      if (!h) continue;
      hashes[id] = h.hash;
      if (!this.frozen.has(id)) { this.frozen.add(id); this.streams.hypotheses.append("hypothesis.frozen", { hypothesis_id: id, session_id: this.o.runId, hash: h.hash, experiment_id: xid }, { recorded_at: 0, occurred_at: 0 }); }
    }
    // Delivery: the named behaviour moved in at least one case, or, with nothing named, at least one event log differs from control.
    const movedCases = m.receipt && expected ? m.receipt.target.filter((t) => t.moved).map((t) => t.case_id) : (m.behaviour?.changed_cases ?? []);
    const delivered = !m.aborted && movedCases.length > 0;
    const movedDeltas: Deltas = Object.fromEntries(movedCases.map((c) => [c, m.deltas[c] ?? {}]));
    const cls = m.aborted ? null : outcomeClass(delivered, movedCases.map((c) => m.deltas[c]?.post_signoff_wait_min ?? null));
    const after = m.aborted ? null : checkAfter(act, before, movedCases, movedDeltas, this.factsOf, delivered);
    if (!m.aborted) { if (delivered) this.counters.delivered += 1; else this.counters.not_delivered += 1; if (cls && mayUpdate(cls)) this.counters.informative += 1; }
    const stored: StoredExperiment = {
      experiment_id: xid, session_id: this.o.runId, source, request, status: m.aborted ? "aborted" : "completed", base_hash: m.base_hash, intervention_hash: m.intervention_hash,
      hypothesis_hashes: hashes, warnings: m.warnings, cases: m.cases, summary: summarise(m.cases), deltas: m.deltas, prediction_check: { before, after }, abort_reason: m.aborted ? `${m.aborted.case_id}: ${m.aborted.reason}` : null, behaviour: m.behaviour, no_pair_reason: noPair,
      expected_change: expected, receipt: m.receipt, delivered: m.aborted ? null : delivered, outcome_class: cls, lint
    };
    this.experiments.set(xid, stored);
    this.streams.experiments.append(m.aborted ? "experiment.aborted" : "experiment.completed", stored, { recorded_at: 0, occurred_at: 0 });
    if (!m.aborted) this.observe(`${xid} ${JSON.stringify(ops)} on ${caseIds.length} cases: ${expected ? `${expected.step} ${expected.behaviour} moved in ${movedCases.length} of ${caseIds.length}` : `logs changed in ${movedCases.length} of ${caseIds.length}`}; ${cls}; median wait delta ${String(stored.summary.post_signoff_wait_min)}`);
    return this.experimentView(stored);
  }

  // What the model sees of an experiment: never the prediction check, never a verdict.
  experimentView(x: StoredExperiment): Result {
    if (x.status === "aborted") return { ok: false, error: "experiment_aborted", experiment_id: x.experiment_id, message: x.abort_reason, budget: this.budgetView() };
    const receipt = x.receipt ? { ...x.receipt, delivered: `${x.receipt.delivered_cases} of ${x.receipt.target.length} cases`, outcome: x.outcome_class, side_effects: sideEffects(x) } : null;
    return { ok: true, experiment_id: x.experiment_id, request: x.request, base_hash: x.base_hash, intervention_hash: x.intervention_hash, warnings: x.warnings, receipt, behaviour: x.behaviour, cases: x.cases.map(caseView), median_delta: x.summary, budget: this.budgetView() };
  }

  getExperiment(a: { experiment_id: string }): Result {
    const x = this.experiments.get(a.experiment_id);
    return x ? this.experimentView(x) : UNKNOWN_ID;
  }

  // Appends a proposal to the proposals stream after the evidence rule for this arm; the evaluator's pipeline validates it.
  async submitProposal(rawIn: unknown): Promise<Result> {
    if (this.counters.proposals_used >= this.proposalLimit()) return refusal("proposals_exhausted", "No proposal submissions are left.");
    const second = this.secondCycleRefusal("proposal");
    if (second) return second;
    const cycleArm = this.o.arm === "adaptive";
    const { raw, extra } = cycleArm ? split(rawIn, ["trade_offs"]) : { raw: rawIn, extra: {} };
    const to = cycleArm ? TradeOffs.safeParse(extra.trade_offs) : null;
    if (to && !to.success) { this.counters.repairs += 1; return refusal("invalid_arguments", "The arguments do not match the schema.", { issues: zodIssues(to.error).map((i) => `trade_offs.${i}`) }); }
    const parsed = ProposalInput.safeParse(raw);
    if (!parsed.success) { this.counters.repairs += 1; return refusal("invalid_arguments", "The arguments do not match the schema.", { issues: zodIssues(parsed.error) }); }
    const a = parsed.data;
    const ev = a.evidence;
    if ((a.parent_proposal_id && !this.proposals.has(a.parent_proposal_id)) || ev.hypothesis_ids.some((h) => !this.hypotheses.has(h)) || ev.experiment_ids.some((x) => !this.experiments.has(x)) || ev.event_ids.some((e) => !this.pool.event(e))) return UNKNOWN_ID;
    // A proposal made while the outcomes contradict the adopted version answers them only if it cites one of their events.
    const worse = new Set((this.comparison?.contradicts_adopted ? this.comparison.after.filter((r) => r.direction === "worse" && r.workflow_version !== this.base.version) : []).map((r) => r.case_id));
    if (this.hasNewEvidence() && worse.size && !ev.event_ids.some((e) => worse.has(this.pool.event(e)!.case_id))) return refusal("outcomes_contradict", "The verified outcomes under the adopted version are worse than the histories of their ward. A proposal made now cites at least one event of those outcomes, or the session ends with insufficient_evidence.", { cases: [...worse] });
    const ran = ev.experiment_ids.filter((x) => this.experiments.get(x)!.status === "completed");
    const arm = this.o.arm;
    if ((arm === "adaptive" || arm === "a4") && (ran.length === 0 || ev.hypothesis_ids.length === 0)) return refusal("evidence_rule", "A proposal cites at least one completed experiment and one hypothesis from this session.");
    if (to?.success) {
      const owed = ran.flatMap((x) => sideEffects(this.experiments.get(x)!).map((e) => ({ experiment_id: x, ...e })));
      const missing = owed.filter((e) => !to.data.some((t) => t.metric === e.metric && t.sum_delta === e.sum_delta));
      if (missing.length) { this.counters.trade_off_refusals += 1; return refusal("trade_offs_missing", "trade_offs must state every side effect the cited experiments' receipts show, with its metric and sum_delta; this request used no proposal.", { side_effects: owed, missing }); }
    }
    if (arm === "a3" && (ev.hypothesis_ids.length === 0 || ev.event_ids.length === 0)) return refusal("evidence_rule", "A proposal cites at least one hypothesis and one recorded event from this session.");
    if (a.base_version !== this.base.version) return UNKNOWN_ID;
    const facts = this.pool.caseFacts();
    const applied = applyOperations(this.base, a.ops, { caseFacts: facts });
    if (!applied.ok) return refusal("static_invalid", "The change breaks a definition rule.", { errors: applied.errors.map((e) => `${e.code}: ${e.message}`) });
    const sc = a.scope.condition;
    if (sc && facts.filter((f) => evalCondition(sc, f)).length === 1) return refusal("static_invalid", "The scope condition holds for exactly one case.");
    const id = this.nextId("p");
    const body = { proposal_id: id, ...a, viewed_case_ids: [...this.viewed].sort(), status: "submitted" as const };
    const proposal = WorkflowChangeProposal.parse({ ...body, hash: hashJson(body) });
    const env = this.streams.proposals.append("proposal.submitted", proposal, { recorded_at: 0, occurred_at: 0 });
    this.log("proposal.linked", { proposal_id: id, stream_id: env.stream_id, seq: env.seq, hash: proposal.hash, ...(to?.success ? { trade_offs: to.data } : {}) });
    if (to?.success) this.streams.proposals.append("proposal.trade_offs", { proposal_id: id, session_id: this.o.runId, trade_offs: to.data }, { recorded_at: 0, occurred_at: 0 });
    this.proposals.set(id, proposal);
    this.counters.proposals_used += 1;
    if (this.o.validate) await this.o.validate(this.o.storeRoot);
    const report = this.report(id);
    const status = report ? String(report.status) : "pending";
    this.observe(`${id} submitted ${JSON.stringify(a.ops)}: validation ${status}`);
    if (status === "dev_validated" && arm !== "prior") this.stopWith("dev_valid_proposal", id);
    else if (arm === "prior") this.stopWith("prior_proposal_submitted", id);
    else if (this.counters.proposals_used >= this.proposalLimit()) this.stopWith("proposals_exhausted", `${this.counters.proposals_used} proposals`);
    return { ok: true, proposal_id: id, hash: proposal.hash, validation: status, budget: this.budgetView() };
  }

  report(proposalId: string): Result | null {
    const rows = readStream(this.o.storeRoot, STREAMS.validations).filter((e) => e.record_type === "validation.completed");
    const hit = rows.map((e) => (e.payload as { report: Result }).report).filter((r) => r.proposal_id === proposalId).at(-1);
    return hit ?? null;
  }

  validationReport(a: { proposal_id: string }): Result {
    if (!this.proposals.has(a.proposal_id)) return UNKNOWN_ID;
    const r = this.report(a.proposal_id);
    if (!r) return { ok: true, proposal_id: a.proposal_id, status: "pending" };
    const { hashes: _h, ...rest } = r;
    return { ok: true, ...rest };
  }

  // A working note the investigator keeps for itself; notes are logged and shown verbatim at the top of later turns.
  recordNote(raw: unknown): Result {
    const parsed = NoteInput.safeParse(raw);
    if (!parsed.success) { this.counters.repairs += 1; return refusal("invalid_arguments", "The arguments do not match the schema.", { issues: zodIssues(parsed.error) }); }
    if (this.notes.length >= NOTE_LIMIT) return refusal("notes_full", `At most ${NOTE_LIMIT} notes are kept.`);
    this.notes.push(parsed.data.note);
    this.log("note.recorded", { number: this.notes.length, note: parsed.data.note });
    return { ok: true, note_number: this.notes.length, notes_left: NOTE_LIMIT - this.notes.length };
  }

  // Cases cited by an active hypothesis, in its evidence or its prediction scopes.
  citedCases(): Set<string> {
    const out = new Set<string>();
    for (const h of this.active()) {
      for (const e of h.evidence) out.add(e.case_id);
      for (const p of [h.if_true, h.if_false]) if ("cases" in p.scope) for (const c of p.scope.cases) out.add(c);
    }
    return out;
  }

  // The investigation ledger, filled by the session from tool results: observations, hypotheses with their ledger fields, experiments with receipts, proposals.
  ledger(): Result {
    const tested = (id: string) => [...this.experiments.values()].filter((x) => Object.keys(x.hypothesis_hashes).includes(id)).map((x) => x.experiment_id);
    return {
      cycle: this.cycle,
      observations: this.observations.slice(-16),
      hypotheses: [...this.hypotheses.values()].map((h) => {
        const lf = this.ledgerFields.get(h.hypothesis_id);
        const sign = h.if_true.comparison === "intervention_lt_control" ? "down" : h.if_true.comparison === "intervention_gt_control" ? "up" : "none";
        return { hypothesis_id: h.hypothesis_id, status: h.status, statement: h.statement, mechanism: h.mechanism, competing: h.competing, cited_events: h.evidence.map((e) => `${e.event_id} ${e.case_id} ${e.stance}`), predicted: { metric: h.if_true.metric, sign, magnitude_min: lf?.predicted_magnitude_min ?? null, tolerance_min: h.if_true.tolerance_min }, falsifying_experiment: lf?.falsifying_experiment ?? null, if_null: lf?.if_null ?? null, refuted_if: h.refuted_if, tested_in: tested(h.hypothesis_id) };
      }),
      experiments: [...this.experiments.values()].map((x) => {
        const r = x.request as { ops?: unknown; case_ids?: string[] };
        const first = x.receipt?.first_divergence.find((d) => d.first !== null) ?? null;
        return { experiment_id: x.experiment_id, status: x.status, ops: r.ops, cases: r.case_ids?.length ?? 0, expected_change: x.expected_change ?? null, delivered: x.receipt ? `${x.receipt.delivered_cases} of ${x.receipt.target.length} cases` : null, outcome: x.outcome_class ?? null, median_delta: Object.fromEntries(Object.entries(x.summary).filter(([, v]) => v !== 0 && v !== null)), first_divergence: first };
      }),
      lint_refusals: this.counters.lint_refusals,
      question: this.question,
      proposals: [...this.proposals.values()].map((p) => ({ proposal_id: p.proposal_id, ops: p.ops, validation: (this.report(p.proposal_id)?.status as string | undefined) ?? "pending" })),
      budget: this.budgetView()
    };
  }

  // Delivered experiments that made the primary metric better on the cases they moved, with their side effects.
  improvedExperiments(): { experiment_id: string; side_effects: SideEffect[] }[] {
    return [...this.experiments.values()].filter((x) => x.source === "request" && x.outcome_class === "delivered_outcome_better").map((x) => ({ experiment_id: x.experiment_id, side_effects: sideEffects(x) }));
  }

  // Closes the current cycle at the investigator's request; the controller opens the next one with a fresh conversation.
  nextCycle(raw: unknown): Result {
    const parsed = z.strictObject({ reason: z.string().trim().min(1).max(300) }).safeParse(raw);
    if (!parsed.success) { this.counters.repairs += 1; return refusal("invalid_arguments", "The arguments do not match the schema.", { issues: zodIssues(parsed.error) }); }
    this.log("cycle.closed_by_model", { cycle: this.cycle, reason: parsed.data.reason });
    this.observe(`cycle ${this.cycle} closed: ${parsed.data.reason}`);
    this.cycleClosed = true;
    return { ok: true, cycle: this.cycle };
  }
  cycleClosed = false;

  // A declared negative ends the run; it must cite the recorded events inspected when the arm has records.
  endSession(raw: unknown): Result {
    const parsed = EndInput.safeParse(raw);
    if (!parsed.success) { this.counters.repairs += 1; return refusal("invalid_arguments", "The arguments do not match the schema.", { issues: zodIssues(parsed.error) }); }
    const a = parsed.data;
    if (a.evidence_event_ids.some((e) => !this.pool.event(e))) return UNKNOWN_ID;
    if (a.result === "insufficient_evidence" && (!this.o.insufficientEvidence || !a.insufficient)) return refusal("not_available", "This result is not available in this session.");
    if (this.o.arm !== "prior" && a.evidence_event_ids.length === 0) return refusal("evidence_rule", "A session result cites the recorded events inspected.");
    const second = this.secondCycleRefusal(a.result, a.evidence_event_ids);
    if (second) return second;
    this.log("session.result", { result: a.result, note: a.note, evidence_event_ids: a.evidence_event_ids, ...(a.insufficient ? { insufficient: a.insufficient } : {}) });
    this.stopWith("declared_negative", a.result);
    return { ok: true, result: a.result };
  }
}

