import { statSync } from "node:fs";
import {
  AGENT_ALLOWED_KINDS, hashJson, type ActionKind, type EventPredicate, type SimEvent, type Step, type WorkflowDefinition as WD
} from "@hey-pisgah/contracts";
import { scheduleHash, type WorldRules } from "@hey-pisgah/simulator";
import { STORE_RECORD_TYPES, openStream, streamPaths, type Stream } from "@hey-pisgah/store";
import { boundRecordKinds, deriveDataIntegrityFences, evalCondition, type Facts, type Registry } from "@hey-pisgah/workflow";
import { eventIdFor, recordIdFor, shortHash } from "./ids.js";
import { ARGS, TEMPLATES } from "./schemas.js";
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
  private cache: { n: number; run: OkRun } | null = null;

  private constructor(readonly world: CaseWorld, private readonly stream: Stream, def: WD, clock: number, private readonly rules: WorldRules | null) {
    this.caseId = world.case_id;
    this.def = def;
    this.clock = clock;
    this.engineRunId = `run-${shortHash(world.case_id, def.definition_hash, scheduleHash(world.schedule), "model_agent", ...(rules ? [rules.rules_hash] : []))}`;
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

  private commits(): EngineCommit[] {
    return this.writes.filter((w) => w.action_kind === "prepare_document" && w.step_id !== null).map((w) => ({ step_id: w.step_id!, effect_at: w.effect_at }));
  }
  // The full engine run under every write so far; events after now are never shown, only used to move the clock.
  run(): OkRun {
    const n = this.writes.length;
    if (!this.cache || this.cache.n !== n) this.cache = { n, run: engineRun(this.world, this.def, this.commits(), this.engineRunId, this.rules) };
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

  // Every event recorded by minute t, in recording order; nothing recorded later is ever included.
  events(t = this.clock): ViewEvent[] {
    const engine: ViewEvent[] = this.run().events.filter((e) => e.recorded_at <= t).map((e) => ({ ...e, source: "engine" as const }));
    const port = this.writes.filter((w) => w.at <= t).map((w) => this.portEvent(w));
    return [...this.requirementEvents(t), ...engine, ...port].sort((a, b) => a.recorded_at - b.recorded_at || RANK[a.source] - RANK[b.source] || a.seq - b.seq);
  }
  private engineEvents(t = this.clock): SimEvent[] {
    return this.run().events.filter((e) => e.recorded_at <= t);
  }

  // The next minute after now at which anything is recorded, or null when the world has nothing more to say.
  nextEventTime(): number | null {
    const times = [
      ...this.run().events.map((e) => e.recorded_at),
      ...this.world.requirements.slice(1).map((r) => r.at)
    ].filter((m) => m > this.clock);
    return times.length ? Math.min(...times) : null;
  }

  advanceTo(t: number): void {
    if (t < this.clock) throw new PortError("clock_backwards", `cannot move the clock from ${this.clock} to ${t}`);
    if (t === this.clock) return;
    const to = Math.min(t, HORIZON);
    this.stream.append("clock.advanced", { from: this.clock, to }, { recorded_at: to, occurred_at: to });
    this.clock = to;
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
    for (const d of deriveDataIntegrityFences(this.def)) {
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
    const kinds = boundRecordKinds(this.def, s);
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
    const status = w.action_kind === "apply_case_exception" ? "pending_confirmation" : "recorded";
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
    return {
      case_id: this.caseId, now: this.clock, horizon: HORIZON, workflow_version: this.def.version, requirement_version: req.set.requirement_version,
      facts, steps, documents, records, agent_writes: writes, events: { page: p, pages, page_size: PAGE, total: events.length, items }
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
    const d = this.def;
    return {
      case_id: this.caseId, workflow_id: d.workflow_id, version: d.version, status: d.status, scope: d.scope,
      steps: d.steps.map((s) => ({ step_id: s.step_id, action_kind: s.action_kind, roles: s.actor_roles, external: s.external, document: s.document_ref, required_when: s.required_when, alternative_group: s.alternative_group })),
      edges: d.edges.map((e) => ({ edge_id: e.edge_id, from: e.from.step, to: e.to.step, gate: e.gate, kind: e.kind, origin: e.origin })),
      triggers: d.triggers,
      documents: d.documents.map((x) => ({ document_id: x.document_id, preparable_by: x.preparable_by, check: x.check, sections: x.sections.map((s) => ({ section_id: s.section_id, record_kind: s.binding.record_kind, needed_for: s.needed_for })) })),
      agent_permissions: Object.entries(d.permissions).filter(([, r]) => r?.includes("agent")).map(([k]) => k).sort()
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
    const schema = (ARGS as Record<string, (typeof ARGS)[keyof typeof ARGS]>)[kind];
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
    return this.accept(base, null, null);
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
