import {
  ExperimentBudget, ExperimentRequest, HypothesisRecord, InsufficientEvidence, Operation, Prediction, WorkflowChangeProposal,
  hashJson, type HypothesisRecord as HR, type Metric, type PredictionCheck, type WorkflowDefinition as WD
} from "@hey-pisgah/contracts";
import { loadV1 } from "@hey-pisgah/hospital";
import { readStream, openStream, type Stream } from "@hey-pisgah/store";
import type { WorldRules } from "@hey-pisgah/simulator";
import { applyOperations, evalCondition } from "@hey-pisgah/workflow";
import { z } from "zod";
import { runMatched, summarise, type CaseResult, type Runner } from "./experiments.js";
import { DiscoveryPool } from "./pool.js";
import { checkAfter, checkBefore, type Deltas } from "./prediction.js";
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
};

export type StopReason = "dev_valid_proposal" | "declared_negative" | "lockout" | "proposals_exhausted" | "prior_proposal_submitted";

// One investigation session: the tools' state, the budgets, and the append-only learning streams.
export class Session {
  readonly pool: DiscoveryPool;
  readonly base: WD;
  readonly hypotheses = new Map<string, HR>();
  readonly experiments = new Map<string, StoredExperiment>();
  readonly proposals = new Map<string, WorkflowChangeProposal>();
  readonly viewed = new Set<string>();
  readonly frozen = new Set<string>();
  counters = { experiments_used: 0, invalid_requests: 0, zod_streak: 0, repairs: 0, listed_used: 0, proposals_used: 0, say_do_mismatches: 0, retains: 0, rejects: 0 };
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

  timeline(a: { case_id: string; order: "occurred" | "recorded"; offset?: number | undefined; limit?: number | undefined; kinds?: string[] | undefined }): Result {
    const c = this.pool.get(a.case_id);
    if (!c) return UNKNOWN_ID;
    this.view(c.case_id);
    return views.timeline(c, a);
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
  definition(): Result { return views.definitionView(this.base); }

  // Records a hypothesis; ids are checked against the pool and the session, predictions against the per-metric caps.
  recordHypothesis(raw: unknown): Result {
    const parsed = HypothesisInput.safeParse(raw);
    if (!parsed.success) { this.counters.repairs += 1; return refusal("invalid_arguments", "The arguments do not match the schema.", { issues: zodIssues(parsed.error) }); }
    const a = parsed.data;
    const competing = Array.isArray(a.competing) ? a.competing : null;
    if (competing && competing.some((id) => !this.hypotheses.has(id))) return UNKNOWN_ID;
    if (a.revises && (!this.hypotheses.has(a.revises) || this.hypotheses.get(a.revises)!.status === "revised")) return UNKNOWN_ID;
    for (const ev of a.evidence) {
      const hit = this.pool.event(ev.event_id);
      if (!hit || hit.case_id !== ev.case_id) return UNKNOWN_ID;
    }
    for (const pr of [a.if_true, a.if_false]) {
      if ("cases" in pr.scope && pr.scope.cases.some((id) => !this.pool.get(id))) return UNKNOWN_ID;
      if (pr.tolerance_min > toleranceCap(pr.metric)) return refusal("tolerance_cap", `tolerance_min for ${pr.metric} may be at most ${toleranceCap(pr.metric)}.`);
    }
    const id = this.nextId("h");
    const content = { session_id: this.o.runId, statement: a.statement, mechanism: a.mechanism, subject_refs: a.subject_refs, competing: a.competing, evidence: a.evidence, if_true: a.if_true, if_false: a.if_false, refuted_if: a.refuted_if, revises: a.revises ?? null };
    const created = this.clocks();
    const rec = { hypothesis_id: id, ...content, created, hash: hashJson(content), status: "open" as const, status_history: [{ status: "open" as const, at: created, evidence_event_ids: [], experiment_ids: [], note: "recorded" }] };
    const checked = HypothesisRecord.safeParse(rec);
    if (!checked.success) { this.counters.repairs += 1; return refusal("invalid_arguments", "The hypothesis breaks a record rule.", { issues: zodIssues(checked.error) }); }
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
  runExperiment(raw: unknown): Result {
    if (this.o.arm !== "adaptive") return refusal("not_available", "This tool is not available in this session.");
    if (this.locked) return refusal("locked_out", "Three refused requests ended access to experiments.");
    if (this.counters.experiments_used >= ExperimentBudget.experiments) return refusal("budget_exhausted", "No experiments are left.");
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
    return this.execute("request", q, base, q.ops, files as NonNullable<(typeof files)[number]>[], act, [q.hypothesis_id, ...q.distinguishes]);
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
    return this.execute("listed", { index: i, ops: entry.ops, case_ids: entry.case_ids }, this.base, entry.ops, files as NonNullable<(typeof files)[number]>[], this.active(), []);
  }

  private execute(source: "request" | "listed", request: unknown, base: WD, ops: readonly Operation[], files: NonNullable<ReturnType<DiscoveryPool["experimentable"]>>[], act: HR[], cited: string[]): Result {
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
      hypothesis_hashes: hashes, warnings: m.warnings, cases: m.cases, summary: summarise(m.cases), deltas: m.deltas, prediction_check: { before, after }, abort_reason: m.aborted ? `${m.aborted.case_id}: ${m.aborted.reason}` : null
    };
    this.experiments.set(xid, stored);
    this.streams.experiments.append(m.aborted ? "experiment.aborted" : "experiment.completed", stored, { recorded_at: 0, occurred_at: 0 });
    return this.experimentView(stored);
  }

  // What the model sees of an experiment: never the prediction check, never a verdict.
  experimentView(x: StoredExperiment): Result {
    if (x.status === "aborted") return { ok: false, error: "experiment_aborted", experiment_id: x.experiment_id, message: x.abort_reason, budget: this.budgetView() };
    return { ok: true, experiment_id: x.experiment_id, request: x.request, base_hash: x.base_hash, intervention_hash: x.intervention_hash, warnings: x.warnings, cases: x.cases, median_delta: x.summary, budget: this.budgetView() };
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

