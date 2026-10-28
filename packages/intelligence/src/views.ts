import { AGENT_ALLOWED_KINDS, ActionKind, FACT_VALUES, type SimEvent, type WorkflowDefinition } from "@hey-pisgah/contracts";
import { loadWardRequirements } from "@hey-pisgah/hospital";
import { SIM_EVENT_KINDS } from "@hey-pisgah/workflow";
import type { DiscoveryPool, PoolCase } from "./pool.js";

// Every tool result is capped so one read can never flood the context.
export const RESULT_CHAR_CAP = 8_000;
export const NOTE_CHAR_CAP = 500;

type Row = Record<string, unknown>;
const p = (e: SimEvent): Row => (e.payload && typeof e.payload === "object" ? (e.payload as Row) : {});

// A compact event row with null fields dropped.
export function eventRow(e: SimEvent): Row {
  const row: Row = { seq: e.seq, event_id: e.event_id, kind: e.kind, occurred_at: e.occurred_at, recorded_at: e.recorded_at };
  if (e.late_entry_reason) row.late_entry_reason = e.late_entry_reason;
  if (e.actor_role) row.actor_role = e.actor_role;
  if (e.actor_id) row.actor_id = e.actor_id;
  if (e.subject) row.subject = e.subject;
  if (e.payload !== null && e.payload !== undefined) row.payload = e.payload;
  return row;
}

export function listCases(pool: DiscoveryPool): Row {
  return {
    cases: pool.ids().map((id) => {
      const c = pool.get(id)!;
      return { case_id: c.case_id, ward_id: c.ward_id, payer_type: c.payer_type, requirement_version: c.requirement_version, source: c.source, events: c.events.length, notes: c.notes.length, opening_facts: c.facts };
    })
  };
}

export type TimelineArgs = { case_id: string; order: "occurred" | "recorded"; offset?: number | undefined; limit?: number | undefined; kinds?: string[] | undefined };

// One page of a case's events and notes in the chosen clock order; notes arrive wrapped as untrusted_text.
export function timeline(c: PoolCase, a: TimelineArgs, cap = RESULT_CHAR_CAP): Row {
  const key = a.order === "occurred" ? "occurred_at" : "recorded_at";
  const rows: { at: number; seq: number; row: Row }[] = c.events
    .filter((e) => !a.kinds || a.kinds.includes(e.kind))
    .map((e) => ({ at: e[key], seq: e.seq, row: eventRow(e) }));
  if (!a.kinds || a.kinds.includes("note.recorded")) {
    for (const n of c.notes) {
      rows.push({ at: n[key], seq: 0, row: { kind: "note.recorded", note_id: n.note_id, occurred_at: n.occurred_at, recorded_at: n.recorded_at, author_role: n.author_role, author_id: n.author_id, note: { untrusted_text: n.untrusted_text.slice(0, NOTE_CHAR_CAP) } } });
    }
  }
  rows.sort((x, y) => x.at - y.at || x.seq - y.seq);
  const offset = Math.max(0, a.offset ?? 0);
  const limit = Math.min(60, Math.max(1, a.limit ?? 40));
  const page: Row[] = [];
  let size = 200;
  for (const r of rows.slice(offset, offset + limit)) {
    const s = JSON.stringify(r.row).length + 1;
    if (page.length > 0 && size + s > Math.min(cap, RESULT_CHAR_CAP)) break;
    page.push(r.row);
    size += s;
  }
  const next = offset + page.length;
  return { case_id: c.case_id, order: a.order, total: rows.length, offset, returned: page.length, next_offset: next < rows.length ? next : null, items: page };
}

export type Selector = { kind: string; step_id?: string | undefined; record_kind?: string | undefined; document_id?: string | undefined; stage?: string | undefined; role?: string | undefined; occurrence?: "first" | "last" | undefined };

function matches(e: SimEvent, s: Selector): boolean {
  if (e.kind !== s.kind) return false;
  const q = p(e);
  if (s.step_id !== undefined && q.step_id !== s.step_id && e.subject !== s.step_id) return false;
  if (s.record_kind !== undefined && q.record_kind !== s.record_kind) return false;
  if (s.document_id !== undefined && q.document_id !== s.document_id) return false;
  if (s.stage !== undefined && q.stage !== s.stage) return false;
  if (s.role !== undefined && e.actor_role !== s.role && q.role !== s.role) return false;
  return true;
}

export function pick(events: readonly SimEvent[], s: Selector): SimEvent | null {
  const hits = events.filter((e) => matches(e, s));
  if (!hits.length) return null;
  return (s.occurrence ?? "first") === "first" ? hits[0]! : hits[hits.length - 1]!;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const y = [...xs].sort((a, b) => a - b);
  const m = Math.floor(y.length / 2);
  return y.length % 2 ? y[m]! : (y[m - 1]! + y[m]!) / 2;
};

// Minutes from one selected event to another in each case, on the chosen clock; all time arithmetic happens here.
export function intervals(cases: readonly PoolCase[], from: Selector, to: Selector, clock: "occurred" | "recorded"): Row {
  const key = clock === "occurred" ? "occurred_at" : "recorded_at";
  const rows = cases.map((c) => {
    const a = pick(c.events, from);
    const b = pick(c.events, to);
    return { case_id: c.case_id, from_event_id: a?.event_id ?? null, to_event_id: b?.event_id ?? null, from_at: a ? a[key] : null, to_at: b ? b[key] : null, minutes: a && b ? b[key] - a[key] : null };
  });
  const xs = rows.flatMap((r) => (r.minutes === null ? [] : [r.minutes]));
  return { clock, rows, summary: { found: xs.length, of: rows.length, median: median(xs), min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null } };
}

const roleOf = (e: SimEvent): string | null => (typeof p(e).role === "string" ? (p(e).role as string) : e.actor_role);
const jobKey = (e: SimEvent) => `${String(p(e).step_id ?? e.subject)}#${String(p(e).attempt ?? 1)}`;

// Each role's state at one minute on the occurred clock: other patients' arrived work, this case's queued, running and finished jobs, and any busy block.
export function queueSnapshot(c: PoolCase, at: number): Row {
  const seen = c.events.filter((e) => e.occurred_at <= at);
  const roles = new Map<string, { other_jobs_arrived: number; other_job_minutes_arrived: number; queued: string[]; running: string[]; completed: number; busy: Row | null }>();
  const r = (role: string) => {
    let x = roles.get(role);
    if (!x) { x = { other_jobs_arrived: 0, other_job_minutes_arrived: 0, queued: [], running: [], completed: 0, busy: null }; roles.set(role, x); }
    return x;
  };
  const started = new Set<string>();
  const completed = new Set<string>();
  for (const e of seen) {
    if (e.kind === "step.started") started.add(jobKey(e));
    if (e.kind === "step.completed") completed.add(jobKey(e));
  }
  for (const e of seen) {
    const role = roleOf(e);
    if (!role) continue;
    if (e.kind === "world.backlog_arrived") { r(role).other_jobs_arrived += 1; r(role).other_job_minutes_arrived += Number(p(e).service_min ?? 0); }
    if (e.kind === "job.queued" && !started.has(jobKey(e))) r(role).queued.push(jobKey(e));
    if (e.kind === "step.started" && !completed.has(jobKey(e))) r(role).running.push(jobKey(e));
    if (e.kind === "step.completed") r(role).completed += 1;
    if (e.kind === "world.busy_started") r(role).busy = { since: e.occurred_at, until: p(e).until ?? null };
    if (e.kind === "world.busy_ended") r(role).busy = null;
  }
  return { case_id: c.case_id, at_min: at, clock: "occurred", roles: Object.fromEntries([...roles.entries()].sort()) };
}

// Every job one role did on this case, per actor, with both clocks, plus that role's busy blocks.
export function staffActivity(c: PoolCase, role: string): Row {
  const actors = new Map<string, Row[]>();
  const jobs = new Map<string, Row>();
  const busy: Row[] = [];
  for (const e of c.events) {
    if (e.kind === "world.busy_started" && roleOf(e) === role) busy.push({ from: e.occurred_at, until: p(e).until ?? null, event_id: e.event_id });
    if (e.actor_role !== role || !["job.queued", "step.started", "step.completed"].includes(e.kind)) continue;
    const k = `${e.actor_id ?? "-"}|${jobKey(e)}`;
    let j = jobs.get(k);
    if (!j) {
      j = { step_id: p(e).step_id ?? e.subject, action_kind: p(e).action_kind ?? null, attempt: p(e).attempt ?? 1 };
      jobs.set(k, j);
      const list = actors.get(e.actor_id ?? "-") ?? [];
      list.push(j);
      actors.set(e.actor_id ?? "-", list);
    }
    if (e.kind === "job.queued") j.queued_at = e.occurred_at;
    if (e.kind === "step.started") j.started_at = e.occurred_at;
    if (e.kind === "step.completed") { j.completed_at = e.occurred_at; j.completed_recorded_at = e.recorded_at; j.event_id = e.event_id; }
  }
  return { case_id: c.case_id, role, actors: Object.fromEntries([...actors.entries()].sort()), busy_blocks: busy };
}

// The versions of one record kind, or the life of one document, as the case recorded them.
export function recordView(c: PoolCase, a: { record_kind?: string | undefined; document_id?: string | undefined }): Row | null {
  if (a.document_id) {
    const rows = c.events.filter((e) => p(e).document_id === a.document_id).map(eventRow);
    return rows.length ? { case_id: c.case_id, document_id: a.document_id, events: rows } : null;
  }
  if (!a.record_kind) return null;
  const versions: Row[] = [];
  let lastUpdate: SimEvent | null = null;
  for (const e of c.events) {
    if (e.kind === "world.record_updated" && p(e).record_kind === a.record_kind) lastUpdate = e;
    if (e.kind !== "record.versioned" || p(e).record_kind !== a.record_kind) continue;
    const stepId = typeof p(e).step_id === "string" ? (p(e).step_id as string) : null;
    let content: unknown = null;
    if (c.file) {
      const s = c.file.schedule;
      if (lastUpdate && Number(p(e).version) > 1) content = s.record_updates.find((u) => u.update_id === p(lastUpdate!).update_id)?.payload ?? null;
      else if (stepId) content = (s.steps as Record<string, { payload?: unknown }>)[stepId]?.payload ?? null;
    }
    versions.push({ version: p(e).version, step_id: stepId, event_id: e.event_id, occurred_at: e.occurred_at, recorded_at: e.recorded_at, content });
  }
  return versions.length ? { case_id: c.case_id, record_kind: a.record_kind, versions } : null;
}

export function wardRequirements(wardId?: string): Row | null {
  const set = loadWardRequirements();
  const wards = wardId ? set.wards.filter((w) => w.ward_id === wardId) : set.wards;
  return wards.length ? { requirement_version: set.requirement_version, wards } : null;
}

// Examples deliberately use the refund voucher steps and an edge id that does not exist.
export const OPERATION_VOCABULARY = [
  { op: "remove_soft_edge", shape: { op: "remove_soft_edge", edge_id: "<soft edge id>" }, example: { op: "remove_soft_edge", edge_id: "e99" }, rule: "Only edges with kind soft can be removed." },
  { op: "add_soft_edge", shape: { op: "add_soft_edge", from: { step: "<step id>" }, to: { step: "<step id>" }, gate: "start | complete" }, example: { op: "add_soft_edge", from: { step: "st13" }, to: { step: "st17a" }, gate: "start" }, rule: "The target must be a non-external prepare_document step." },
  { op: "move_step_after", shape: { op: "move_step_after", step: { step: "<step id>" }, after: { step: "<step id>" }, gate: "start | complete" }, example: { op: "move_step_after", step: { step: "st17a" }, after: { step: "st13" }, gate: "start" }, rule: "The moved step must be a non-external prepare_document step; its incoming soft edges are replaced." },
  { op: "set_prep_trigger", shape: { op: "set_prep_trigger", target: { step: "<step id>" }, when: "<event predicate>" }, example: { op: "set_prep_trigger", target: { step: "st17a" }, when: { on: "step.completed", where: { step_id: "st13" } } }, rule: "Replaces the triggers of a non-external prepare_document step. A step that has triggers starts only after one of them fires and its start edges hold. Predicates: {on: event kind, where?}, {after: {step}}, {all_of: [...]}, {any_of: [...]}; depth 2, 4 leaves. An after predicate on a step that is not required counts as satisfied; an on predicate waits for that event." },
  { op: "add_condition", shape: { op: "add_condition", target: "{step: {step}} | {trigger: {step}} | \"scope\"", condition: "<condition>" }, example: { op: "add_condition", target: { trigger: { step: "st17a" } }, condition: { fact: "payer_type", in: ["self_pay", "corporate"] } }, rule: "Conditions use the closed fact list, at most 3 atoms; a condition true for exactly one pool case is refused." },
  { op: "rebind_section", shape: { op: "rebind_section", document_id: "<document id>", section_id: "<section id>", source: { record_kind: "<allowed source>", field_path: "<path>", version_policy: "current" } }, example: { op: "rebind_section", document_id: "refund_voucher", section_id: "settlement", source: { record_kind: "payment", field_path: "balance", version_policy: "current" } }, rule: "Data-integrity fences are derived again from the new binding." }
] as const;

// How the definition executor reads a definition, stated as rules of the engine for every arm alike.
export const ENGINE_SEMANTICS = [
  "A step can start only when it is required, every start edge into it holds and, if it has triggers, at least one of its triggers has fired.",
  "A trigger fires once its when predicate holds and its condition, if any, is true, and it stays fired.",
  "An edge with gate complete lets its target start but holds the target's completion until the source step completes.",
  "An edge or after predicate whose source step is not required counts as satisfied.",
  "Edges and triggers are separate: removing, adding or moving an edge never changes a trigger, and set_prep_trigger changes triggers only.",
  "Operations may target only steps whose action is prepare_document and that are not external."
] as const;

// Record kinds a section may bind to: those a step produces or those the definition already binds.
export function allowedSources(def: WorkflowDefinition): string[] {
  const out = new Set<string>();
  for (const s of def.steps) for (const rk of s.produces) out.add(rk);
  for (const d of def.documents) for (const sec of d.sections) out.add(sec.binding.record_kind);
  return [...out].sort();
}

// The definition with its registries: every action kind, every event kind, the condition facts, allowed sources and the operation vocabulary.
export function definitionView(def: WorkflowDefinition): Row {
  const { metadata: _m, ...rest } = def;
  return {
    definition: rest,
    action_registry: { kinds: ActionKind.options, agent_kinds: [...AGENT_ALLOWED_KINDS].sort() },
    event_kinds: [...SIM_EVENT_KINDS],
    condition_facts: Object.fromEntries(Object.entries(FACT_VALUES).map(([k, v]) => [k, v instanceof RegExp ? `pattern ${v.source}` : v])),
    allowed_sources: allowedSources(def),
    engine_semantics: ENGINE_SEMANTICS,
    operations: OPERATION_VOCABULARY,
    limits: { ops_per_change: 3, condition_atoms: 3, predicate_depth: 2, predicate_leaves: 4 }
  };
}
