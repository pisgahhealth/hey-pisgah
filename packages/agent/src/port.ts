import { statSync } from "node:fs";
import {
  AGENT_ALLOWED_KINDS, hashJson, type ActionKind, type EventPredicate, type SimEvent, type Step, type WorkflowDefinition as WD
} from "@hey-pisgah/contracts";
import { scheduleHash, type WorldRules } from "@hey-pisgah/simulator";
import { STORE_RECORD_TYPES, openStream, streamPaths, type Stream } from "@hey-pisgah/store";
import { applyOperations, boundRecordKinds, deriveDataIntegrityFences, evalCondition, type Facts, type Registry } from "@hey-pisgah/workflow";
import { eventIdFor, recordIdFor, shortHash } from "./ids.js";
import { bindingFailures, checksInForce, loadRequirementChecks, type CheckFailure, type RequirementCheck } from "./monitor.js";
import { ASK_LIMIT, TEMPLATES, argsFor, type ToolProfile } from "./schemas.js";
import {
  HORIZON, PortError, agentSteps, engineRun, isAgentStep, requirementsAt, wardRequiresList,
  type CaseWorld, type EngineCommit, type OkRun, type ViewEvent
} from "./world.js";

export type PortWrite = {
  ordinal: number; intent_key: string; action_kind: ActionKind; args: Record<string, unknown>; step_id: string | null;
  record_id: string; target_record_id: string; event_id: string; at: number; effect_at: number; base_version: number | null;
};
export type WaitingFor = { kind: "fence" | "soft_edge" | "data" | "trigger"; step_id: string | null; edge_id: string | null; when: EventPredicate | null };
export type SourceView = { record_id: string; record_kind: string; version: number; current_version: number };
export type RecordView = {
  record_id: string; kind: "document_stage" | "record" | "agent_write"; version: number; status: string;
  content: Record<string, unknown>; source_refs: SourceView[]; produced_event_ids: string[]; hash: string;
};
export type CommitResult =
  | { ok: true; write: PortWrite }
  | { ok: false; reason: string; counted: boolean; detail: Record<string, unknown> };

export type Confirmation = { record_id: string; by: { kind: "person"; staff_id: string; role: string }; at: number };
export type MonitorVerdict = { ok: true } | { ok: false; failures: CheckFailure[]; requirement_version: string; evidence_event_ids: string[] };
export const PORT_STREAM = (caseId: string) => `world/${caseId}`;
const PAGE = 15;
const RANK: Record<ViewEvent["source"], number> = { requirements: 0, engine: 1, port: 2 };

// Strings that came from people or other systems reach the model only inside an untrusted_text field.
export function wrapUntrusted(v: unknown): unknown {
  if (typeof v === "string") return { untrusted_text: v.slice(0, 500) };
  if (Array.isArray(v)) return v.map(wrapUntrusted);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wrapUntrusted(x)]));
  return v;
}

const str = (p: unknown, k: string): string | null => {
  const v = (p as Record<string, unknown> | null)?.[k];
  return typeof v === "string" ? v : null;
};

// The hospital as the agent sees it: a store-backed record of agent writes over the deterministic definition executor.
export class HospitalPort {
  readonly caseId: string;
  readonly def: WD;
  readonly engineRunId: string;
  private readonly writes: PortWrite[] = [];
  private refused = 0;
  private clock: number;
  private cache: { n: string; run: OkRun } | null = null;
  private readonly confirmations: Confirmation[] = [];
  private caseDefCache: { n: number; def: WD } | null = null;
  readonly profile: ToolProfile;
  readonly checks: readonly RequirementCheck[] = loadRequirementChecks();

  private constructor(readonly world: CaseWorld, private readonly stream: Stream, def: WD, clock: number, private readonly rules: WorldRules | null) {
    this.caseId = world.case_id;
    this.def = def;
    this.clock = clock;
    this.profile = world.tool_profile ?? "v2";
    // A requirement timeline beyond the first set changes the engine run, so it is part of the run id.
    const timeline = world.requirements.length > 1 ? [hashJson(world.requirements.map((r) => [r.at, r.set]))] : [];
    this.engineRunId = `run-${shortHash(world.case_id, def.definition_hash, scheduleHash(world.schedule), "model_agent", ...(rules ? [rules.rules_hash] : []), ...timeline)}`;
  }

  // Opens or reopens the case's world stream; a reopen must see the same world and world rules, and keeps the version it started with.
  static open(storeRoot: string, world: CaseWorld, registry: Registry, rules: WorldRules | null = null): HospitalPort {
    const stream = openStream(storeRoot, PORT_STREAM(world.case_id), { writer: true });
    try {
      const recs = stream.records().filter((e) => !STORE_RECORD_TYPES.includes(e.record_type));
      const worldHash = hashJson(world);
      const rulesHash = rules?.rules_hash ?? null;
      const opened = recs.find((e) => e.record_type === "port.opened");
      let def: WD;
      if (!opened) {
        const facts = { ...world.schedule.facts, ward_requires: wardRequiresList(world.requirements[0]!.set, world.schedule.facts) };
        def = registry.current(facts as Facts);
        stream.append("port.opened", { case_id: world.case_id, world_hash: worldHash, world_rules_hash: rulesHash, version: def.version, definition_hash: def.definition_hash, opened_at: world.opened_at }, { recorded_at: world.opened_at, occurred_at: world.opened_at });
      } else {
        const p = opened.payload as { world_hash: string; world_rules_hash?: string | null; version: number };
        if (p.world_hash !== worldHash) throw new PortError("world_mismatch", "the case world differs from the one this stream was opened with");
        if ((p.world_rules_hash ?? null) !== rulesHash) throw new PortError("world_mismatch", "the world rules differ from the ones this stream was opened with");
        def = registry.get(p.version);
      }
      const port = new HospitalPort(world, stream, def, world.opened_at, rules);
      for (const e of recs) {
        if (e.record_type === "clock.advanced") port.clock = (e.payload as { to: number }).to;
        else if (e.record_type === "port.write") port.writes.push(e.payload as PortWrite);
        else if (e.record_type === "agent.refused") port.refused += 1;
        else if (e.record_type === "case_exception.confirmed") port.confirmations.push(e.payload as Confirmation);
        else if (e.record_type === "case_exception.unconfirmed") port.unconfirmable.add(String((e.payload as { record_id: string }).record_id));
      }
      return port;
    } catch (e) {
      stream.close();
      throw e;
    }
  }

  close(): void { this.stream.close(); }
  now(): number { return this.clock; }
  get horizon(): number { return HORIZON; }
  // The resumer polls this file's size; it changes on every clock move and write.
  streamFile(): string { return streamPaths(this.stream.root, this.stream.streamId).file; }
  streamSize(): number { try { return statSync(this.streamFile()).size; } catch { return 0; } }
  headSeq(): number { return this.stream.head().seq; }
  refusedCount(): number { return this.refused; }
  allWrites(): readonly PortWrite[] { return this.writes; }
  writesFor(intentKey: string): PortWrite[] { return this.writes.filter((w) => w.intent_key === intentKey); }
  findWrite(intentKey: string): PortWrite | null { return this.writesFor(intentKey)[0] ?? null; }

  // The adopted version with this case's confirmed exceptions applied; it never changes the version for other cases.
  get caseDef(): WD {
    const n = this.confirmations.length;
    if (this.caseDefCache?.n === n) return this.caseDefCache.def;
    const ops = this.exceptionOps(this.confirmations.map((c) => c.record_id));
    let def = this.def;
    if (ops.length) {
      const r = applyOperations(this.def, ops);
      if (r.ok) def = r.definition;
    }
    this.caseDefCache = { n, def };
    return def;
  }
  private exceptionOps(recordIds: readonly string[]): unknown[] {
    return recordIds.map((id) => this.writes.find((w) => w.record_id === id)!).map((w) => {
      const op = w.args["op"] as { document_id: string; section_id: string; source: { record_kind: string; field_path: string } };
      return { op: "rebind_section", document_id: op.document_id, section_id: op.section_id, source: { ...op.source, version_policy: "current" } };
    });
  }
  exceptions(): { record_id: string; args: Record<string, unknown>; at: number; status: "pending_confirmation" | "confirmed" | "note_only"; confirmed: Confirmation | null }[] {
    return this.writes.filter((w) => w.action_kind === "apply_case_exception" && w.at <= this.clock).map((w) => {
      const c = this.confirmations.find((x) => x.record_id === w.record_id) ?? null;
      const source = (w.args["op"] as { source?: unknown }).source;
      return { record_id: w.record_id, args: w.args, at: w.at, status: c ? "confirmed" : source ? "pending_confirmation" : "note_only", confirmed: c };
    });
  }

  // A person in the named role confirms a pending case exception; the rebinding then applies to this case from now on.
  confirmException(recordId: string, by: { kind: string; staff_id: string; role: string }): { ok: true } | { ok: false; reason: string } {
    if (by.kind !== "person") return { ok: false, reason: "confirmation_requires_person" };
    const x = this.exceptions().find((e) => e.record_id === recordId);
    if (!x) return { ok: false, reason: "unknown_id" };
    if (x.status !== "pending_confirmation") return { ok: false, reason: `exception_${x.status}` };
    if (x.args["confirm_by_role"] !== by.role) return { ok: false, reason: "wrong_role" };
    const docId = (x.args["op"] as { document_id: string }).document_id;
    if (this.writes.some((w) => w.action_kind === "prepare_document" && w.args["document_id"] === docId)) return { ok: false, reason: "document_already_started" };
    const ops = this.exceptionOps([...this.confirmations.map((c) => c.record_id), recordId]);
    const r = applyOperations(this.def, ops);
    if (!r.ok) return { ok: false, reason: `exception_invalid: ${r.errors.map((e) => e.message).join("; ").slice(0, 200)}` };
    const c: Confirmation = { record_id: recordId, by: { kind: "person", staff_id: by.staff_id, role: by.role }, at: this.clock };
    // A confirmation may change what happens from now on, never what was already recorded.
    const before = hashJson(this.engineEvents().map((e) => [e.event_id, e.kind, e.recorded_at, e.payload]));
    this.confirmations.push(c);
    const after = hashJson(this.engineEvents().map((e) => [e.event_id, e.kind, e.recorded_at, e.payload]));
    if (before !== after) {
      this.confirmations.pop();
      return { ok: false, reason: "exception_would_change_recorded_history" };
    }
    this.stream.append("case_exception.confirmed", c, { recorded_at: this.clock, occurred_at: this.clock });
    return { ok: true };
  }

  // The modelled staff answer: the named role confirms a pending case exception that names a recorded source a fixed number of minutes after it is recorded.
  private confirmationDue(): { record_id: string; due: number; role: string }[] {
    const after = this.world.exception_confirm_after_min;
    if (after === undefined) return [];
    return this.exceptions().filter((x) => x.status === "pending_confirmation" && !this.unconfirmable.has(x.record_id))
      .map((x) => ({ record_id: x.record_id, due: x.at + after, role: String(x.args["confirm_by_role"]) }));
  }
  private readonly unconfirmable = new Set<string>();
  // True while a case exception waits for its modelled staff answer.
  confirmationPending(): boolean { return this.confirmationDue().some((d) => d.due > this.clock); }
  private staffId(role: string): string {
    if (role === "ward_manager") {
      const ward = String(this.world.schedule.facts["ward_id"]);
      return requirementsAt(this.world, this.clock).set.wards.find((w) => w.ward_id === ward)?.approver.staff_id ?? "ward_manager";
    }
    return (this.world.schedule.actors as Record<string, string | undefined>)[role] ?? role;
  }
  private applyDueConfirmations(): void {
    for (const d of this.confirmationDue().filter((x) => x.due <= this.clock)) {
      const r = this.confirmException(d.record_id, { kind: "person", staff_id: this.staffId(d.role), role: d.role });
      if (!r.ok) {
        this.unconfirmable.add(d.record_id);
        this.stream.append("case_exception.unconfirmed", { record_id: d.record_id, reason: r.reason, at: this.clock }, { recorded_at: this.clock, occurred_at: this.clock });
      }
    }
  }

  private commits(): EngineCommit[] {
    return this.writes.filter((w) => w.action_kind === "prepare_document" && w.step_id !== null).map((w) => ({ step_id: w.step_id!, effect_at: w.effect_at }));
  }
  // The full engine run under every write and confirmed case exception so far; events after now are never shown, only used to move the clock.
  run(): OkRun {
    const n = `${this.writes.length}:${this.confirmations.length}`;
    if (!this.cache || this.cache.n !== n) this.cache = { n, run: engineRun(this.world, this.caseDef, this.commits(), this.engineRunId, this.rules) };
    return this.cache.run;
  }

  private portEvent(w: PortWrite): ViewEvent {
    const a = w.args;
    return {
      event_id: w.event_id, seq: w.ordinal, case_id: this.caseId, kind: `agent.${w.action_kind}`, clock: "server", occurred_at: w.at, recorded_at: w.at,
      late_entry_reason: null, actor_id: "agent", actor_role: "agent", subject: w.step_id ?? w.target_record_id, source: "port",
      payload: { action_kind: w.action_kind, record_id: w.target_record_id, ...(typeof a["document_id"] === "string" ? { document_id: a["document_id"] } : {}), ...(typeof a["stage"] === "string" ? { stage: a["stage"] } : {}), ...(typeof a["template_id"] === "string" ? { template_id: a["template_id"] } : {}) }
    };
  }
  private requirementEvents(upTo: number): ViewEvent[] {
    return this.world.requirements.slice(1).map((r, i) => ({ r, i: i + 1 })).filter(({ r }) => r.at <= upTo).map(({ r, i }) => ({
      event_id: eventIdFor(this.engineRunId, "requirements", i), seq: i, case_id: this.caseId, kind: "requirements.changed", clock: "server" as const,
      occurred_at: r.at, recorded_at: r.at, late_entry_reason: null, actor_id: null, actor_role: "ward_manager", subject: null, source: "requirements" as const,
      payload: { requirement_version: r.set.requirement_version }
    }));
  }

  private confirmationEvents(upTo: number): ViewEvent[] {
    return this.confirmations.filter((c) => c.at <= upTo).map((c, i) => ({
      event_id: eventIdFor(this.engineRunId, "confirm", i + 1), seq: this.writes.length + i + 1, case_id: this.caseId, kind: "case_exception.confirmed", clock: "server" as const,
      occurred_at: c.at, recorded_at: c.at, late_entry_reason: null, actor_id: c.by.staff_id, actor_role: c.by.role, subject: c.record_id, source: "port" as const,
      payload: { record_id: c.record_id }
    }));
  }

  // Every event recorded by minute t, in recording order; nothing recorded later is ever included.
  events(t = this.clock): ViewEvent[] {
    const engine: ViewEvent[] = this.run().events.filter((e) => e.recorded_at <= t).map((e) => ({ ...e, source: "engine" as const }));
    const port = [...this.writes.filter((w) => w.at <= t).map((w) => this.portEvent(w)), ...this.confirmationEvents(t)];
    return [...this.requirementEvents(t), ...engine, ...port].sort((a, b) => a.recorded_at - b.recorded_at || RANK[a.source] - RANK[b.source] || a.seq - b.seq);
  }
  private engineEvents(t = this.clock): SimEvent[] {
    return this.run().events.filter((e) => e.recorded_at <= t);
  }

  // The next minute after now at which anything is recorded, or null when the world has nothing more to say.
  nextEventTime(): number | null {
    const times = [
      ...this.run().events.map((e) => e.recorded_at),
      ...this.world.requirements.slice(1).map((r) => r.at),
      ...this.confirmationDue().map((d) => d.due)
    ].filter((m) => m > this.clock);
    return times.length ? Math.min(...times) : null;
  }

  advanceTo(t: number): void {
    if (t < this.clock) throw new PortError("clock_backwards", `cannot move the clock from ${this.clock} to ${t}`);
    if (t === this.clock) return;
    const to = Math.min(t, HORIZON);
    this.stream.append("clock.advanced", { from: this.clock, to }, { recorded_at: to, occurred_at: to });
    this.clock = to;
    this.applyDueConfirmations();
  }

  // Facts as recorded by now: schedule start values, then each recorded completion's facts in order, with ward_requires from the requirements in force.
  facts(t = this.clock): Record<string, string | string[]> {
    const f: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(this.world.schedule.facts)) f[k] = Array.isArray(v) ? [...v] : (v as string);
    for (const e of this.engineEvents(t)) {
      if (e.kind !== "step.completed") continue;
      const sid = str(e.payload, "step_id");
      for (const [k, v] of Object.entries((sid && this.world.schedule.steps[sid]?.sets_facts) || {}).sort(([a], [b]) => (a < b ? -1 : 1))) f[k] = Array.isArray(v) ? [...v] : (v as string);
    }
    f["ward_requires"] = wardRequiresList(requirementsAt(this.world, t).set, f);
    return f;
  }

  private selected(s: Step): boolean {
    if (s.alternative_group === null) return true;
    const members = this.def.steps.filter((x) => x.alternative_group === s.alternative_group).map((x) => x.step_id).sort();
    return (this.world.schedule.alternatives[s.alternative_group] ?? members[0]) === s.step_id;
  }
  isActive(s: Step, facts: Facts): boolean {
    return this.selected(s) && (s.required_when === null || evalCondition(s.required_when, facts));
  }
  private doneSteps(t = this.clock): Set<string> {
    return new Set(this.engineEvents(t).filter((e) => e.kind === "step.completed").map((e) => str(e.payload, "step_id")).filter((x): x is string => x !== null));
  }
  private fromSatisfied(stepId: string, done: Set<string>, facts: Facts): boolean {
    const s = this.def.steps.find((x) => x.step_id === stepId);
    if (!s) return false;
    const members = s.alternative_group === null ? [s] : this.def.steps.filter((x) => x.alternative_group === s.alternative_group);
    return members.some((x) => done.has(x.step_id)) || members.every((x) => !this.isActive(x, facts));
  }
  private holds(p: EventPredicate, done: Set<string>, facts: Facts, events: readonly SimEvent[]): boolean {
    if ("after" in p) return this.fromSatisfied(p.after.step, done, facts);
    if ("on" in p) return events.some((e) => e.kind === p.on && Object.entries(p.where ?? {}).every(([k, v]) => str(e.payload, k) === v));
    return "all_of" in p ? p.all_of.every((x) => this.holds(x, done, facts, events)) : p.any_of.some((x) => this.holds(x, done, facts, events));
  }

  // What an agent step still waits for under the adopted version: edges, data-integrity fences and its triggers.
  waitingFor(s: Step): WaitingFor[] {
    const facts = this.facts() as Facts;
    const done = this.doneSteps();
    const out: WaitingFor[] = [];
    for (const e of this.def.edges) {
      if (e.to.step !== s.step_id || this.fromSatisfied(e.from.step, done, facts)) continue;
      out.push({ kind: e.kind === "fence" ? "fence" : "soft_edge", step_id: e.from.step, edge_id: e.edge_id, when: null });
    }
    for (const d of deriveDataIntegrityFences(this.caseDef)) {
      if (d.to.step !== s.step_id || this.fromSatisfied(d.from.step, done, facts)) continue;
      if (out.some((o) => o.step_id === d.from.step)) continue;
      out.push({ kind: "data", step_id: d.from.step, edge_id: null, when: null });
    }
    const triggers = this.def.triggers.filter((t) => t.target.step === s.step_id);
    const events = this.engineEvents();
    if (triggers.length && !triggers.some((t) => this.holds(t.when, done, facts, events) && (t.condition === null || evalCondition(t.condition, facts)))) {
      for (const t of triggers) out.push({ kind: "trigger", step_id: null, edge_id: null, when: t.when });
    }
    return out;
  }

  private stepFor(documentId: string, stage: string): Step | undefined {
    return this.def.steps.find((s) => s.action_kind === "prepare_document" && s.document_ref?.document_id === documentId && s.document_ref.stage === stage);
  }
  stageRecordId(documentId: string, stage: string): string { return recordIdFor(this.caseId, "document", documentId, stage); }
  recordKindId(kind: string): string { return recordIdFor(this.caseId, "kind", kind); }
  private producedKinds(): Set<string> { return new Set(this.def.steps.flatMap((s) => s.produces)); }

  // Record versions as of a given engine seq; kinds no step produces exist from the start at version 1.
  private versionsAt(seqLimit: number, events: readonly SimEvent[]): Map<string, number> {
    const v = new Map<string, number>();
    for (const e of events) {
      if (e.seq >= seqLimit) break;
      if (e.kind === "record.versioned") v.set(String(str(e.payload, "record_kind")), Number((e.payload as { version: number }).version));
    }
    return v;
  }
  private versionOf(kind: string, v: Map<string, number>): number {
    return v.get(kind) ?? (this.producedKinds().has(kind) ? 0 : 1);
  }

  private stageView(s: Step): RecordView {
    const ref = s.document_ref!;
    const events = this.engineEvents();
    const mine = (e: SimEvent) => str(e.payload, "step_id") === s.step_id;
    const started = events.find((e) => e.kind === "step.started" && mine(e));
    const completed = events.find((e) => e.kind === "step.completed" && mine(e));
    const revisions = events.filter((e) => e.kind === "document.revised" && e.subject === s.step_id);
    const point = revisions.at(-1) ?? started;
    const kinds = boundRecordKinds(this.caseDef, s);
    const captured = point ? this.versionsAt(point.seq + 1, events) : new Map<string, number>();
    const current = this.versionsAt(Number.MAX_SAFE_INTEGER, events);
    const sources: SourceView[] = kinds.map((k) => ({ record_id: this.recordKindId(k), record_kind: k, version: this.versionOf(k, captured), current_version: this.versionOf(k, current) }))
      .filter((x) => x.version >= 1);
    const stale = completed !== undefined && sources.some((x) => x.version !== x.current_version);
    const status = !started ? "not_started" : !completed ? "in_progress" : stale ? "stale" : "complete";
    const produced = [started, completed, ...revisions].filter((e): e is SimEvent => e !== undefined).map((e) => e.event_id);
    const record_id = this.stageRecordId(ref.document_id, ref.stage);
    const version = started ? 1 + revisions.length : 0;
    const content = { document_id: ref.document_id, stage: ref.stage, step_id: s.step_id, sections: this.sectionsOf(s) };
    return { record_id, kind: "document_stage", version, status, content, source_refs: sources, produced_event_ids: produced, hash: hashJson({ record_id, version, status, content, sources, produced }) };
  }
  private sectionsOf(s: Step): string[] {
    const doc = this.def.documents.find((d) => d.document_id === s.document_ref!.document_id);
    return (doc?.sections ?? []).filter((x) => s.document_ref!.stage === "final" || x.needed_for === "draft").map((x) => x.section_id);
  }
  private kindView(kind: string): RecordView | null {
    const events = this.engineEvents();
    const vs = events.filter((e) => e.kind === "record.versioned" && str(e.payload, "record_kind") === kind);
    const last = vs.at(-1);
    if (!last) return null;
    const stepId = str(last.payload, "step_id");
    const update = events.filter((e) => e.kind === "world.record_updated" && e.subject === kind && e.seq < last.seq).at(-1);
    const upd = update ? this.world.schedule.record_updates.find((u) => u.update_id === str(update.payload, "update_id")) : undefined;
    const raw = upd ? upd.payload : stepId ? this.world.schedule.steps[stepId]?.payload ?? null : null;
    const record_id = this.recordKindId(kind);
    const version = Number((last.payload as { version: number }).version);
    const content = { record_kind: kind, data: wrapUntrusted(raw ?? null) as Record<string, unknown> | null };
    const produced = vs.map((e) => e.event_id);
    return { record_id, kind: "record", version, status: "recorded", content, source_refs: [], produced_event_ids: produced, hash: hashJson({ record_id, version, content, produced }) };
  }
  private writeView(w: PortWrite): RecordView {
    const x = w.action_kind === "apply_case_exception" ? this.exceptions().find((e) => e.record_id === w.record_id) : undefined;
    const status = x ? (x.status === "pending_confirmation" && this.unconfirmable.has(w.record_id) ? "not_confirmed" : x.status) : "recorded";
    const content = { action_kind: w.action_kind, args: w.args, target_record_id: w.target_record_id };
    return { record_id: w.record_id, kind: "agent_write", version: 1, status, content, source_refs: [], produced_event_ids: [w.event_id], hash: hashJson({ record_id: w.record_id, content, event_id: w.event_id }) };
  }

  // A fresh read of one record as it stands now; unknown ids all answer null so nothing leaks about other pools.
  record(recordId: string): RecordView | null {
    for (const s of this.def.steps) {
      if (s.action_kind === "prepare_document" && s.document_ref && this.stageRecordId(s.document_ref.document_id, s.document_ref.stage) === recordId) return this.stageView(s);
    }
    for (const k of this.producedKinds()) if (this.recordKindId(k) === recordId) return this.kindView(k);
    const w = this.writes.find((x) => x.record_id === recordId && x.at <= this.clock);
    return w ? this.writeView(w) : null;
  }

  caseState(page?: number): Record<string, unknown> {
    const facts = this.facts();
    const done = this.doneSteps();
    const events = this.events();
    const engine = this.engineEvents();
    const req = requirementsAt(this.world, this.clock);
    const steps = [...this.def.steps].sort((a, b) => (a.step_id < b.step_id ? -1 : 1)).map((s) => {
      const active = this.isActive(s, facts as Facts);
      const comp = engine.find((e) => e.kind === "step.completed" && str(e.payload, "step_id") === s.step_id);
      const started = engine.some((e) => (e.kind === "step.started" || e.kind === "job.queued") && str(e.payload, "step_id") === s.step_id);
      const status = done.has(s.step_id) ? "done" : !active ? "not_required" : started ? "in_progress" : "not_started";
      return { step_id: s.step_id, action_kind: s.action_kind, roles: s.actor_roles, status, recorded_at: comp?.recorded_at ?? null };
    });
    const documents = agentSteps(this.def).map((s) => {
      const v = this.stageView(s);
      const required = this.isActive(s, facts as Facts);
      const written = this.writes.some((w) => w.step_id === s.step_id);
      const waiting = v.status === "not_started" && !written ? this.waitingFor(s) : [];
      return {
        record_id: v.record_id, document_id: s.document_ref!.document_id, stage: s.document_ref!.stage, step_id: s.step_id, required, status: v.status, version: v.version,
        requested_by_agent: written, ready: required && !written && v.status === "not_started" && waiting.length === 0 && this.clock < HORIZON, waiting_for: waiting
      };
    });
    const records = [...this.producedKinds()].sort().map((k) => ({ record_id: this.recordKindId(k), record_kind: k, version: this.kindView(k)?.version ?? 0 }));
    const writes = this.writes.filter((w) => w.action_kind !== "prepare_document").map((w) => ({ record_id: w.record_id, action_kind: w.action_kind, at: w.at, args: w.args }));
    const pages = Math.max(1, Math.ceil(events.length / PAGE));
    const p = Math.min(Math.max(1, page ?? pages), pages);
    const items = events.slice((p - 1) * PAGE, p * PAGE).map((e) => ({ event_id: e.event_id, at: e.recorded_at, occurred_at: e.occurred_at, kind: e.kind, subject: e.subject, by: e.actor_role, ...(e.late_entry_reason ? { late_entry_reason: { untrusted_text: e.late_entry_reason.slice(0, 500) } } : {}) }));
    const notes = this.world.notes?.filter((n) => n.recorded_at <= this.clock).map((n) => ({ note_id: n.note_id, by: n.author_role, at: n.recorded_at, occurred_at: n.occurred_at, untrusted_text: n.text.slice(0, 500) }));
    const exceptions = this.exceptions().filter((x) => x.status !== "note_only").map((x) => ({ record_id: x.record_id, status: x.status, at: x.at }));
    return {
      case_id: this.caseId, now: this.clock, horizon: HORIZON, workflow_version: this.def.version, requirement_version: req.set.requirement_version,
      facts, steps, documents, records, agent_writes: writes, events: { page: p, pages, page_size: PAGE, total: events.length, items },
      ...(notes ? { notes } : {}), ...(exceptions.length ? { case_exceptions: exceptions } : {})
    };
  }

  wardRequirements(): Record<string, unknown> {
    const req = requirementsAt(this.world, this.clock);
    const ward = String(this.facts()["ward_id"]);
    const w = req.set.wards.find((x) => x.ward_id === ward);
    const required = new Set(wardRequiresList(req.set, this.facts()));
    return {
      case_id: this.caseId, requirement_version: req.set.requirement_version, in_force_since_minute: req.at, ward_id: ward,
      effective_from: w?.effective_from ?? null,
      required_documents: (w?.required_documents ?? []).map((d) => ({ document_id: d.document_id, condition: d.condition, required_for_this_case: required.has(d.document_id) })),
      procedure_text: w ? { untrusted_text: w.procedure_text } : null
    };
  }

  workflowDefinition(): Record<string, unknown> {
    const d = this.caseDef;
    return {
      case_id: this.caseId, workflow_id: d.workflow_id, version: d.version, status: d.status, scope: d.scope,
      steps: d.steps.map((s) => ({ step_id: s.step_id, action_kind: s.action_kind, roles: s.actor_roles, external: s.external, document: s.document_ref, required_when: s.required_when, alternative_group: s.alternative_group })),
      edges: d.edges.map((e) => ({ edge_id: e.edge_id, from: e.from.step, to: e.to.step, gate: e.gate, kind: e.kind, origin: e.origin })),
      triggers: d.triggers,
      documents: d.documents.map((x) => ({ document_id: x.document_id, preparable_by: x.preparable_by, check: x.check, sections: x.sections.map((s) => ({ section_id: s.section_id, record_kind: s.binding.record_kind, needed_for: s.needed_for })) })),
      agent_permissions: Object.entries(d.permissions).filter(([, r]) => r?.includes("agent")).map(([k]) => k).sort(),
      ...(d !== this.def ? { case_exceptions_applied: this.confirmations.map((c) => c.record_id) } : {})
    };
  }

  private refuse(kind: string, reason: string, intentKey: string | null, detail: Record<string, unknown> = {}): CommitResult {
    this.refused += 1;
    this.stream.append("agent.refused", { attempt: this.refused, action_kind: kind, reason, intent_key: intentKey, at: this.clock, ...detail }, { recorded_at: this.clock, occurred_at: this.clock });
    return { ok: false, reason, counted: true, detail: { action_kind: kind, ...detail } };
  }
  private decline(reason: string, detail: Record<string, unknown> = {}): CommitResult {
    return { ok: false, reason, counted: false, detail };
  }

  // The commit door: permission, arguments and prerequisites are re-checked here at commit time, whatever the caller checked.
  commit(kind: string, rawArgs: unknown, intentKey: string): CommitResult {
    if (!AGENT_ALLOWED_KINDS.has(kind as ActionKind)) return this.refuse(kind, "person_only", intentKey);
    if (!(this.def.permissions[kind as ActionKind] ?? []).includes("agent")) return this.refuse(kind, "not_permitted", intentKey);
    const schema = argsFor(this.profile)[kind];
    const parsed = schema?.safeParse(rawArgs);
    if (!parsed || !parsed.success) return this.decline("invalid_arguments");
    const args = parsed.data as Record<string, unknown>;
    if (args["case_id"] !== this.caseId) return this.decline("unknown_id");
    if (this.clock >= HORIZON) return this.decline("horizon_reached");
    const at = this.clock;
    const base = { intent_key: intentKey, action_kind: kind as ActionKind, args, at, effect_at: at, base_version: null as number | null, step_id: null as string | null };
    if (kind === "prepare_document" || kind === "revise_document" || kind === "request_check") {
      const docId = String(args["document_id"]), stage = String(args["stage"]);
      const step = this.stepFor(docId, stage);
      if (!step || !isAgentStep(this.def, step)) return this.refuse(kind, "not_permitted", intentKey, { document_id: docId, stage });
      const target = this.stageRecordId(docId, stage);
      const view = this.stageView(step);
      if (kind === "prepare_document") {
        if (!this.isActive(step, this.facts() as Facts)) return this.decline("not_required", { document_id: docId, stage });
        if (this.writes.some((w) => w.step_id === step.step_id) || view.status !== "not_started") return this.decline("already_prepared", { record_id: target });
        const waiting = this.waitingFor(step);
        if (waiting.length) return this.decline("prerequisite_unmet", { waiting_for: waiting });
        const verdict = this.monitorVerdict(docId, stage);
        if (!verdict.ok) return this.decline("requirement_check_failed", { document_id: docId, stage, monitor: verdict });
        return this.accept({ ...base, step_id: step.step_id, effect_at: at + 1 }, target, target);
      }
      if (kind === "revise_document") {
        if (view.status !== "stale") return this.decline("not_stale", { record_id: target, status: view.status });
        return this.accept({ ...base, base_version: view.version }, target, target);
      }
      const doc = this.def.documents.find((d) => d.document_id === docId);
      if (!doc?.check) return this.decline("no_check_for_document", { document_id: docId });
      if (view.status !== "complete") return this.decline("prerequisite_unmet", { record_id: target, status: view.status });
      return this.accept(base, null, target);
    }
    if (kind === "send_staff_message") {
      const tpl = String(args["template_id"]) as keyof typeof TEMPLATES;
      if (tpl !== "status_request" && (args["document_id"] === undefined || args["stage"] === undefined)) return this.decline("invalid_arguments", { need: ["document_id", "stage"] });
    }
    if (kind === "raise_workflow_conflict" && args["version"] !== this.def.version) return this.decline("unknown_id", { version: args["version"] });
    if (this.profile === "v2") {
      const guard = kind === "raise_workflow_conflict" ? this.conflictGuard(args) : kind === "ask_staff" ? this.askGuard(args) : kind === "apply_case_exception" ? this.exceptionGuard(args) : null;
      if (guard) return this.refuse(kind, guard.reason, intentKey, guard.detail);
    }
    return this.accept(base, null, null);
  }

  // A conflict must cite the requirement version in force and one element of this case's definition, else it is refused and counted.
  private conflictGuard(args: Record<string, unknown>): { reason: string; detail: Record<string, unknown> } | null {
    const inForce = requirementsAt(this.world, this.clock).set.requirement_version;
    if (args["requirement_version"] !== inForce) return { reason: "conflict_uncited", detail: { cited_requirement_version: args["requirement_version"], in_force: inForce } };
    const el = args["definition_element"] as { kind: string; id: string };
    const d = this.caseDef;
    const exists = el.kind === "step" ? d.steps.some((s) => s.step_id === el.id)
      : el.kind === "edge" ? d.edges.some((e) => e.edge_id === el.id)
      : el.kind === "trigger" ? d.triggers.some((t) => t.target.step === el.id)
      : d.documents.some((x) => x.sections.some((sec) => `${x.document_id}.${sec.section_id}` === el.id));
    if (!exists) return { reason: "conflict_uncited", detail: { definition_element: el, note: "no such element in the adopted version" } };
    const seen = new Set(this.events().map((e) => e.event_id));
    const unknown = (args["evidence"] as string[]).filter((id) => !seen.has(id));
    return unknown.length ? { reason: "conflict_uncited", detail: { note: "evidence must name recorded event ids", unknown_count: unknown.length } } : null;
  }
  // A question goes to a named role, reads as a question, and a case gets at most ASK_LIMIT of them.
  private askGuard(args: Record<string, unknown>): { reason: string; detail: Record<string, unknown> } | null {
    const q = String(args["question"]).trim();
    if (!q.includes("?") || q.split(/\s+/).length < 3) return { reason: "not_a_question", detail: {} };
    const asked = this.writes.filter((w) => w.action_kind === "ask_staff").length;
    if (asked >= ASK_LIMIT) return { reason: "ask_limit_reached", detail: { limit: ASK_LIMIT } };
    return null;
  }
  // A case exception that names a source must name one the hospital records.
  private exceptionGuard(args: Record<string, unknown>): { reason: string; detail: Record<string, unknown> } | null {
    const op = args["op"] as { document_id: string; section_id: string; source?: { record_kind: string; field_path: string } };
    const doc = this.def.documents.find((d) => d.document_id === op.document_id);
    if (!doc?.sections.some((x) => x.section_id === op.section_id)) return { reason: "unknown_section", detail: { document_id: op.document_id, section_id: op.section_id } };
    if (op.source && !this.producedKinds().has(op.source.record_kind)) return { reason: "unknown_source", detail: { record_kind: op.source.record_kind } };
    if (op.source && this.writes.some((w) => w.action_kind === "prepare_document" && w.args["document_id"] === op.document_id)) return { reason: "document_already_started", detail: { document_id: op.document_id } };
    return null;
  }

  // The monitor's commit-time check: the ward requirements in force now, read fresh, against the version this case runs.
  monitorVerdict(documentId: string, stage: string): MonitorVerdict {
    const facts = this.facts() as Facts;
    const req = requirementsAt(this.world, this.clock);
    const checks = checksInForce(this.checks, String(facts["ward_id"]), req.set.requirement_version, facts);
    const failures = bindingFailures(this.caseDef, documentId, stage, checks);
    if (!failures.length) return { ok: true };
    return { ok: false, failures, requirement_version: req.set.requirement_version, evidence_event_ids: this.checkEvidence(failures) };
  }
  private checkEvidence(fs: readonly CheckFailure[]): string[] {
    const kinds = new Set(fs.flatMap((f) => [f.expected.record_kind, f.found?.record_kind ?? ""]));
    return this.events().filter((e) => e.kind === "requirements.changed" || (e.kind === "record.versioned" && kinds.has(String(str(e.payload, "record_kind"))))).map((e) => e.event_id).slice(-10);
  }

  // True once a hand-over step citing this document stage has completed.
  handedOver(recordId: string): boolean {
    const s = this.def.steps.find((x) => x.action_kind === "prepare_document" && x.document_ref && this.stageRecordId(x.document_ref.document_id, x.document_ref.stage) === recordId);
    if (!s) return false;
    const ref = s.document_ref!;
    const hands = this.def.steps.filter((x) => x.action_kind === "hand_over_document" && x.document_ref?.document_id === ref.document_id && x.document_ref.stage === ref.stage).map((x) => x.step_id);
    return this.engineEvents().some((e) => e.kind === "step.completed" && hands.includes(String(str(e.payload, "step_id"))));
  }

  // The monitor's outcome check on one prepared stage, against the record as it stands now.
  outcomeCheck(recordId: string): { ok: boolean; status: "current" | "revising" | "stale_after_handover" | "requirement_failed" | "absent"; failures: CheckFailure[]; requirement_version: string; evidence_event_ids: string[] } {
    const req = requirementsAt(this.world, this.clock).set.requirement_version;
    const rec = this.record(recordId);
    if (!rec || rec.kind !== "document_stage") return { ok: false, status: "absent", failures: [], requirement_version: req, evidence_event_ids: [] };
    const doc = String(rec.content["document_id"]), stage = String(rec.content["stage"]);
    const v = this.monitorVerdict(doc, stage);
    if (!v.ok) return { ok: false, status: "requirement_failed", failures: v.failures, requirement_version: req, evidence_event_ids: v.evidence_event_ids };
    const stale = rec.source_refs.filter((x) => x.version !== x.current_version);
    if (!stale.length) return { ok: true, status: "current", failures: [], requirement_version: req, evidence_event_ids: [] };
    const kinds = new Set(stale.map((x) => x.record_kind));
    const evidence = this.engineEvents().filter((e) => e.kind === "record.versioned" && kinds.has(String(str(e.payload, "record_kind")))).map((e) => e.event_id).slice(-10);
    if (this.handedOver(recordId)) return { ok: false, status: "stale_after_handover", failures: [], requirement_version: req, evidence_event_ids: evidence };
    return { ok: true, status: "revising", failures: [], requirement_version: req, evidence_event_ids: evidence };
  }

  private accept(w: Omit<PortWrite, "ordinal" | "record_id" | "target_record_id" | "event_id">, recordId: string | null, target: string | null): CommitResult {
    const ordinal = this.writes.length + 1;
    const record_id = recordId ?? recordIdFor(this.caseId, "write", ordinal);
    const write: PortWrite = { ...w, ordinal, record_id, target_record_id: target ?? record_id, event_id: eventIdFor(this.engineRunId, "port", ordinal) };
    this.stream.append("port.write", write, { recorded_at: w.at, occurred_at: w.at });
    this.writes.push(write);
    return { ok: true, write };
  }

  // One hash over every effect of the run: the engine's final records, facts and stages plus every agent write.
  effectSetHash(): string {
    return hashJson({ engine: this.run().effect_set_hash, writes: this.writes.map(({ intent_key, action_kind, args, record_id, effect_at }) => ({ intent_key, action_kind, args, record_id, effect_at })) });
  }
}
