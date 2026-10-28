import {
  ExperimentBudget, ExperimentRequest, HypothesisRecord, InsufficientEvidence, Operation, Prediction, WorkflowChangeProposal,
  hashJson, type HypothesisRecord as HR, type Metric, type PredictionCheck, type WorkflowDefinition as WD
} from "@hey-pisgah/contracts";
import { loadV1 } from "@hey-pisgah/hospital";
import { readStream, openStream, type Stream } from "@hey-pisgah/store";
import type { WorldRules } from "@hey-pisgah/simulator";
import { applyOperations, evalCondition } from "@hey-pisgah/workflow";
import { z } from "zod";
import { runMatched, summarise, type Behaviour, type CaseResult, type Runner } from "./experiments.js";
import { DiscoveryPool } from "./pool.js";
import { checkAfter, checkBefore, type Deltas } from "./prediction.js";
import { expectedShapes } from "./shapes.js";
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

// Takes the optional no_pair_reason off a run_experiment request, so the strict contract schema still checks the rest.
function splitReason(raw: unknown): { raw: unknown; reason: string | undefined } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("no_pair_reason" in raw)) return { raw, reason: undefined };
  const { no_pair_reason: r, ...rest } = raw as Record<string, unknown>;
  return { raw: rest, reason: typeof r === "string" && r.trim().length > 0 ? r.trim().slice(0, 300) : undefined };
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

export const NOTE_LIMIT = 20;
export const NoteInput = z.strictObject({ note: z.string().trim().min(1).max(600), no_hypothesis_reason: z.string().trim().min(1).max(300).optional(), no_experiment_reason: z.string().trim().min(1).max(300).optional() });

// After this many active hypotheses recorded since the last experiment, case reads and record_hypothesis wait for an experiment or a no_experiment_reason note.
export const EXPERIMENT_BUDGET = { hypotheses: 3 } as const;
export const EXPERIMENT_BUDGET_MESSAGE = `Experiment budget reached: ${EXPERIMENT_BUDGET.hypotheses} active hypotheses recorded since the last experiment. Call run_experiment, or record_note with a no_experiment_reason, before further record_hypothesis calls or case reads. This refusal is counted and uses no experiment.`;

// Before any hypothesis exists, reads are budgeted per window; a no_hypothesis_reason note opens a new window.
export const READ_BUDGET = { pages: 25, calls: 12 } as const;
export const READ_BUDGET_MESSAGE = `Reading budget reached: ${READ_BUDGET.pages} timeline pages or ${READ_BUDGET.calls} model calls with no hypothesis recorded. Record a hypothesis with record_hypothesis, or a note with record_note that gives a no_hypothesis_reason, before further get_case_timeline or get_record reads. This refusal is counted and uses no experiment.`;
export const DEFINITION_UNCHANGED = "The workflow definition is unchanged since your first read of it; its short form stays in this conversation.";

export const EndInput = z.strictObject({
  result: z.enum(["no_change_warranted", "insufficient_evidence"]),
  note: z.string().min(1).max(600),
  evidence_event_ids: z.array(z.string()).max(20),
  insufficient: InsufficientEvidence.optional()
});

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
  private readWindow = { pages: 0, callsAtStart: 0 };
  private definitionRead: { turn: number; hash: string } | null = null;
  private experimentWindowStart = new Set<string>();
  counters = { hypothesis_schema_errors: 0, experiment_budget_refusals: 0, definition_unchanged: 0, read_refusals: 0, timeline_pages: 0, experiments_used: 0, invalid_requests: 0, pair_refusals: 0, no_pair_reasons: 0, zod_streak: 0, repairs: 0, listed_used: 0, proposals_used: 0, say_do_mismatches: 0, retains: 0, rejects: 0 };
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

  // A record_hypothesis schema error with the expected shape of each failing field, counted per run.
  private hypothesisSchemaError(message: string, error: z.ZodError): Result {
    this.counters.repairs += 1;
    this.counters.hypothesis_schema_errors += 1;
    return refusal("invalid_arguments", message, { issues: zodIssues(error), expected: expectedShapes(error) });
  }

  // Active hypotheses recorded since the last experiment or no_experiment_reason note.
  private hypothesesInExperimentWindow(): number {
    return this.active().filter((h) => !this.experimentWindowStart.has(h.hypothesis_id)).length;
  }

  // Once the window holds EXPERIMENT_BUDGET.hypotheses active hypotheses, case reads and record_hypothesis refuse until an experiment or a no_experiment_reason note.
  private experimentBudgetRefusal(tool: string): Result | null {
    if (this.o.arm !== "adaptive" || this.hypothesesInExperimentWindow() < EXPERIMENT_BUDGET.hypotheses) return null;
    this.counters.experiment_budget_refusals += 1;
    this.log("hypothesis_window.refused", { tool, active_in_window: this.hypothesesInExperimentWindow(), experiment_budget_refusals: this.counters.experiment_budget_refusals });
    return refusal("experiment_budget", EXPERIMENT_BUDGET_MESSAGE);
  }

  private resetExperimentWindow(): void {
    this.experimentWindowStart = new Set(this.hypotheses.keys());
  }

  // The refusal a budgeted read gets once the window is spent with no hypothesis recorded; null while reads may go on.
  private readBudgetRefusal(tool: string): Result | null {
    if (this.hypotheses.size > 0) return null;
    const calls = this.o.usage?.().calls ?? 0;
    if (this.readWindow.pages < READ_BUDGET.pages && calls - this.readWindow.callsAtStart < READ_BUDGET.calls) return null;
    this.counters.read_refusals += 1;
    this.log("read.refused", { tool, pages: this.readWindow.pages, calls_in_window: calls - this.readWindow.callsAtStart, read_refusals: this.counters.read_refusals });
    return refusal("reading_budget", READ_BUDGET_MESSAGE);
  }

  timeline(a: { case_id: string; order: "occurred" | "recorded"; offset?: number | undefined; limit?: number | undefined; kinds?: string[] | undefined }, cap?: number): Result {
    const window = this.experimentBudgetRefusal("get_case_timeline");
    if (window) return window;
    const budget = this.readBudgetRefusal("get_case_timeline");
    if (budget) return budget;
    const c = this.pool.get(a.case_id);
    if (!c) return UNKNOWN_ID;
    this.view(c.case_id);
    this.readWindow.pages += 1;
    this.counters.timeline_pages += 1;
    return views.timeline(c, a, cap);
  }

  record(a: { case_id: string; record_kind?: string | undefined; document_id?: string | undefined }): Result {
    const window = this.experimentBudgetRefusal("get_record");
    if (window) return window;
    const budget = this.readBudgetRefusal("get_record");
    if (budget) return budget;
    const c = this.pool.get(a.case_id);
    if (!c) return UNKNOWN_ID;
    this.view(c.case_id);
    return views.recordView(c, a) ?? refusal("not_recorded", "This case has no such record or document.");
  }

  intervals(a: { case_ids: string[]; from: views.Selector; to: views.Selector; clock: "occurred" | "recorded" }): Result {
    const window = this.experimentBudgetRefusal("compute_intervals");
    if (window) return window;
    const cs = a.case_ids.map((id) => this.pool.get(id));
    if (cs.some((c) => c === null)) return UNKNOWN_ID;
    for (const c of cs) this.view(c!.case_id);
    return views.intervals(cs as NonNullable<(typeof cs)[number]>[], a.from, a.to, a.clock);
  }

  queue(a: { case_id: string; at_min: number }): Result {
    const window = this.experimentBudgetRefusal("get_queue_snapshot");
    if (window) return window;
    const c = this.pool.get(a.case_id);
    if (!c) return UNKNOWN_ID;
    this.view(c.case_id);
    return views.queueSnapshot(c, a.at_min);
  }

  staff(a: { case_id: string; role: string }): Result {
    const window = this.experimentBudgetRefusal("get_staff_activity");
    if (window) return window;
    const c = this.pool.get(a.case_id);
    if (!c) return UNKNOWN_ID;
    this.view(c.case_id);
    return views.staffActivity(c, a.role);
  }

  requirements(a: { ward_id?: string | undefined }): Result { return views.wardRequirements(a.ward_id) ?? UNKNOWN_ID; }
  // The full definition on the first read; later reads of the same definition answer with the turn and hash of that read and no body.
  definition(turn?: number): Result {
    const hash = this.base.definition_hash;
    if (turn !== undefined && this.definitionRead && this.definitionRead.hash === hash) {
      this.counters.definition_unchanged += 1;
      return { ok: true, unchanged: true, read_at_turn: this.definitionRead.turn, definition_hash: hash, note: DEFINITION_UNCHANGED };
    }
    if (turn !== undefined) this.definitionRead = { turn, hash };
    return views.definitionView(this.base);
  }

  // Records a hypothesis; ids are checked against the pool and the session, predictions against the per-metric caps.
  recordHypothesis(raw: unknown): Result {
    const budget = this.experimentBudgetRefusal("record_hypothesis");
    if (budget) return budget;
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
    const id = this.nextId("h");
    const content = { session_id: this.o.runId, statement: a.statement, mechanism: a.mechanism, subject_refs: a.subject_refs, competing: a.competing, evidence: a.evidence, if_true: a.if_true, if_false: a.if_false, refuted_if: a.refuted_if, revises: a.revises ?? null };
    const created = this.clocks();
    const rec = { hypothesis_id: id, ...content, created, hash: hashJson(content), status: "open" as const, status_history: [{ status: "open" as const, at: created, evidence_event_ids: [], experiment_ids: [], note: "recorded" }] };
    const checked = HypothesisRecord.safeParse(rec);
    if (!checked.success) return this.hypothesisSchemaError("The hypothesis breaks a record rule.", checked.error);
    this.hypotheses.set(id, checked.data as HR);
    this.streams.hypotheses.append("hypothesis.recorded", checked.data, { recorded_at: 0, occurred_at: 0 });
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

  // Validates in the published order, then runs matched control and intervention arms; the result carries numbers and diffs only.
  runExperiment(rawIn: unknown): Result {
    if (this.o.arm !== "adaptive") return refusal("not_available", "This tool is not available in this session.");
    if (this.locked) return refusal("locked_out", "Three refused requests ended access to experiments.");
    if (this.counters.experiments_used >= ExperimentBudget.experiments) return refusal("budget_exhausted", "No experiments are left.");
    const { raw, reason } = splitReason(rawIn);
    const parsed = ExperimentRequest.safeParse(raw);
    if (!parsed.success) {
      this.counters.zod_streak += 1;
      this.counters.repairs += 1;
      const issues = zodIssues(parsed.error);
      if (this.counters.zod_streak > 2) { this.counters.zod_streak = 0; return this.invalid("schema", raw, issues, refusal("invalid_request", "The request failed the schema three times and counts as refused.", { issues })); }
      return refusal("invalid_arguments", "The request does not match the schema.", { issues, repairs_left: 3 - this.counters.zod_streak });
    }
    this.counters.zod_streak = 0;
    const q = parsed.data;
    const live = (id: string) => this.hypotheses.has(id) && this.hypotheses.get(id)!.status !== "revised";
    const base = this.resolveBase(q.base);
    const files = q.case_ids.map((id) => this.pool.experimentable(id));
    if (!live(q.hypothesis_id) || q.distinguishes.some((d) => !live(d)) || !base || files.some((f) => f === null) || new Set(q.case_ids).size !== q.case_ids.length) return this.invalid("ids", raw, ["unknown id"], UNKNOWN_ID);
    const act = this.active();
    if (act.length < 2 && !act.some((h) => !Array.isArray(h.competing))) {
      return this.invalid("preregistration", raw, ["needs two hypotheses, or one with a stated reason"], refusal("preregistration", "Record two competing hypotheses, or one with the reason no competitor was identified, before the first experiment."));
    }
    const ran = [...this.experiments.values()].filter((x) => x.source === "request").length;
    let noPair: string | null = null;
    if (ran >= 1 && this.distinguishablePairs(act).length === 0) {
      if (reason === undefined) {
        this.counters.pair_refusals += 1;
        this.streams.experiments.append("experiment.refused_pair", { session_id: this.o.runId, request_hash: hashJson(JSON.parse(JSON.stringify(raw ?? null))), active: act.map((h) => h.hypothesis_id), pair_refusals: this.counters.pair_refusals }, { recorded_at: 0, occurred_at: 0 });
        return refusal("no_distinguishable_pair", "From the second experiment on, hold two active hypotheses whose if_true predictions do not overlap on one metric for a shared pool case, or give no_pair_reason saying why no such pair can be formed. This request used no experiment.", { budget: this.budgetView() });
      }
      noPair = reason;
      this.counters.no_pair_reasons += 1;
    }
    return this.execute("request", q, base, q.ops, files as NonNullable<(typeof files)[number]>[], act, [q.hypothesis_id, ...q.distinguishes], noPair);
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

  private execute(source: "request" | "listed", request: unknown, base: WD, ops: readonly Operation[], files: NonNullable<ReturnType<DiscoveryPool["experimentable"]>>[], act: HR[], cited: string[], noPair: string | null): Result {
    const caseIds = files.map((f) => f.case_id);
    const before = checkBefore(act, caseIds, this.factsOf);
    const xid = this.nextId("x");
    const m = runMatched(base, ops, files, { caseFacts: this.pool.caseFacts(), experimentId: xid, ...(this.o.world ? { world: this.o.world } : {}), ...(this.o.runner ? { runner: this.o.runner } : {}) });
    if (!m.ok) {
      if (source === "listed") throw new Error(`listed experiment refused: ${m.errors.join("; ")}`);
      return this.invalid(m.stage, request, m.errors, refusal("invalid_request", "The change breaks a definition rule.", { stage: m.stage, errors: m.errors }));
    }
    if (source === "request") this.counters.experiments_used += 1;
    for (const c of caseIds) this.view(c);
    const hashes: Record<string, string> = {};
    for (const id of new Set([...cited, ...before.speaks_to])) {
      const h = this.hypotheses.get(id);
      if (!h) continue;
      hashes[id] = h.hash;
      if (!this.frozen.has(id)) { this.frozen.add(id); this.streams.hypotheses.append("hypothesis.frozen", { hypothesis_id: id, session_id: this.o.runId, hash: h.hash, experiment_id: xid }, { recorded_at: 0, occurred_at: 0 }); }
    }
    const after = m.aborted ? null : checkAfter(act, before, caseIds, m.deltas, this.factsOf);
    const stored: StoredExperiment = {
      experiment_id: xid, session_id: this.o.runId, source, request, status: m.aborted ? "aborted" : "completed", base_hash: m.base_hash, intervention_hash: m.intervention_hash,
      hypothesis_hashes: hashes, warnings: m.warnings, cases: m.cases, summary: summarise(m.cases), deltas: m.deltas, prediction_check: { before, after }, abort_reason: m.aborted ? `${m.aborted.case_id}: ${m.aborted.reason}` : null, behaviour: m.behaviour, no_pair_reason: noPair
    };
    this.experiments.set(xid, stored);
    if (source === "request") this.resetExperimentWindow();
    this.streams.experiments.append(m.aborted ? "experiment.aborted" : "experiment.completed", stored, { recorded_at: 0, occurred_at: 0 });
    return this.experimentView(stored);
  }

  // What the model sees of an experiment: never the prediction check, never a verdict.
  experimentView(x: StoredExperiment): Result {
    if (x.status === "aborted") return { ok: false, error: "experiment_aborted", experiment_id: x.experiment_id, message: x.abort_reason, budget: this.budgetView() };
    return { ok: true, experiment_id: x.experiment_id, request: x.request, base_hash: x.base_hash, intervention_hash: x.intervention_hash, warnings: x.warnings, behaviour: x.behaviour, cases: x.cases.map(caseView), median_delta: x.summary, budget: this.budgetView() };
  }

  getExperiment(a: { experiment_id: string }): Result {
    const x = this.experiments.get(a.experiment_id);
    return x ? this.experimentView(x) : UNKNOWN_ID;
  }

  // Appends a proposal to the proposals stream after the evidence rule for this arm; the evaluator's pipeline validates it.
  async submitProposal(raw: unknown): Promise<Result> {
    if (this.counters.proposals_used >= this.proposalLimit()) return refusal("proposals_exhausted", "No proposal submissions are left.");
    const parsed = ProposalInput.safeParse(raw);
    if (!parsed.success) { this.counters.repairs += 1; return refusal("invalid_arguments", "The arguments do not match the schema.", { issues: zodIssues(parsed.error) }); }
    const a = parsed.data;
    const ev = a.evidence;
    if ((a.parent_proposal_id && !this.proposals.has(a.parent_proposal_id)) || ev.hypothesis_ids.some((h) => !this.hypotheses.has(h)) || ev.experiment_ids.some((x) => !this.experiments.has(x)) || ev.event_ids.some((e) => !this.pool.event(e))) return UNKNOWN_ID;
    const ran = ev.experiment_ids.filter((x) => this.experiments.get(x)!.status === "completed");
    const arm = this.o.arm;
    if ((arm === "adaptive" || arm === "a4") && (ran.length === 0 || ev.hypothesis_ids.length === 0)) return refusal("evidence_rule", "A proposal cites at least one completed experiment and one hypothesis from this session.");
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
    this.log("proposal.linked", { proposal_id: id, stream_id: env.stream_id, seq: env.seq, hash: proposal.hash });
    this.proposals.set(id, proposal);
    this.counters.proposals_used += 1;
    if (this.o.validate) await this.o.validate(this.o.storeRoot);
    const report = this.report(id);
    const status = report ? String(report.status) : "pending";
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
    const reason = parsed.data.no_hypothesis_reason;
    const noExp = parsed.data.no_experiment_reason;
    const text = [parsed.data.note, reason ? `(no hypothesis yet: ${reason})` : null, noExp ? `(no experiment yet: ${noExp})` : null].filter(Boolean).join(" ");
    this.notes.push(text);
    this.log("note.recorded", { number: this.notes.length, note: text, no_hypothesis_reason: reason ?? null, no_experiment_reason: noExp ?? null });
    if (reason && this.hypotheses.size === 0) this.readWindow = { pages: 0, callsAtStart: this.o.usage?.().calls ?? 0 };
    if (noExp) this.resetExperimentWindow();
    return { ok: true, note_number: this.notes.length, notes_left: NOTE_LIMIT - this.notes.length, ...(reason ? { reading_window_reopened: this.hypotheses.size === 0 } : {}), ...(noExp ? { experiment_window_reopened: true } : {}) };
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

  ledger(): Result {
    return {
      hypotheses: [...this.hypotheses.values()].map((h) => ({ hypothesis_id: h.hypothesis_id, statement: h.statement.slice(0, 160), status: h.status, competing: h.competing, revises: h.revises })),
      experiments: [...this.experiments.values()].map((x) => ({ experiment_id: x.experiment_id, status: x.status, request: x.request })),
      proposals: [...this.proposals.values()].map((p) => ({ proposal_id: p.proposal_id, validation: (this.report(p.proposal_id)?.status as string | undefined) ?? "pending" })),
      budget: this.budgetView()
    };
  }

  // A declared negative ends the run; it must cite the recorded events inspected when the arm has records.
  endSession(raw: unknown): Result {
    const parsed = EndInput.safeParse(raw);
    if (!parsed.success) { this.counters.repairs += 1; return refusal("invalid_arguments", "The arguments do not match the schema.", { issues: zodIssues(parsed.error) }); }
    const a = parsed.data;
    if (a.evidence_event_ids.some((e) => !this.pool.event(e))) return UNKNOWN_ID;
    if (a.result === "insufficient_evidence" && (!this.o.insufficientEvidence || !a.insufficient)) return refusal("not_available", "This result is not available in this session.");
    if (this.o.arm !== "prior" && a.evidence_event_ids.length === 0) return refusal("evidence_rule", "A session result cites the recorded events inspected.");
    this.log("session.result", { result: a.result, note: a.note, evidence_event_ids: a.evidence_event_ids, ...(a.insufficient ? { insufficient: a.insufficient } : {}) });
    this.stopWith("declared_negative", a.result);
    return { ok: true, result: a.result };
  }
}

