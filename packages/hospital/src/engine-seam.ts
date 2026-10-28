import {
  AGENT_ALLOWED_KINDS, ActionKind, SimEvent, checkTwoClock, fencesHash, permissionsHash, sha256,
  type ActorRole, type EventPredicate, type Operation, type SimEvent as SimEventT, type WorkflowDefinition
} from "@hey-pisgah/contracts";
import { evalCondition, wardRequires, type Facts, type WardRequirementSet } from "./requirements.js";
import { readPath, type Schedule, type WorldBindings, type WorldParameters } from "./world.js";

// ENGINE SEAM: a small local stand-in for the simulator's engine; swap every use for @hey-pisgah/simulator when L1.1a merges.

export const HORIZON = 2880;

export type Practice = {
  triggers?: Record<string, EventPredicate>;
  start_after?: Record<string, string[]>;
  entry_lag?: (e: { kind: string; actor_id: string; ordinal: number; occurred_at: number }) => { lag_min: number; reason: string | null } | null;
};
export type EngineRunOptions = { preparer: "staff" | "agent"; parameters: WorldParameters; practice?: Practice };
export type World = { bindings: WorldBindings; requirements: WardRequirementSet };
export type StepTime = { started_occ: number | null; completed_occ: number | null; completed_rec: number | null };
export type EngineRun = {
  case_id: string;
  events: SimEventT[];
  step_times: Record<string, StepTime>;
  post_signoff_wait_min: number | null;
  bed_release_delay_min: number | null;
  terminal_state: "departed" | "blocked_external" | "horizon_reached";
  invariant_violations: string[];
};
export type AgentAction = { actor_role: ActorRole; action_kind: string; step_id?: string };
export type DispatchState = { prohibited_attempted: number; prohibited_executed: number; events: SimEventT[] };
export type DispatchResult = { ok: true } | { ok: false; reason: "not_permitted" | "unknown_kind" };

export interface DischargeEngine {
  run(def: WorkflowDefinition, world: World, schedule: Schedule, options: EngineRunOptions): EngineRun;
  dispatch(def: WorkflowDefinition, state: DispatchState, action: AgentAction, at: number, caseId: string): DispatchResult;
  applyOperations(def: WorkflowDefinition, ops: Operation[]): WorkflowDefinition;
}

const eventId = (caseId: string, key: string) => `ev-${sha256(`${caseId}:${key}`).slice(0, 8)}`;

// The engine's permission fence: a prohibited kind is refused, counted and logged, never executed.
function dispatch(def: WorkflowDefinition, state: DispatchState, action: AgentAction, at: number, caseId: string): DispatchResult {
  const kind = ActionKind.safeParse(action.action_kind);
  const step = action.step_id ? def.steps.find((s) => s.step_id === action.step_id) : undefined;
  const permitted = kind.success && (def.permissions[kind.data] ?? []).includes(action.actor_role)
    && (action.actor_role !== "agent" || AGENT_ALLOWED_KINDS.has(kind.data))
    && (!step || (step.action_kind === kind.data && step.actor_roles.includes(action.actor_role)));
  if (permitted) return { ok: true };
  state.prohibited_attempted += 1;
  state.events.push(SimEvent.parse({
    event_id: eventId(caseId, `refused:${state.prohibited_attempted}`), seq: state.events.length + 1, case_id: caseId, kind: "agent.refused", clock: "server",
    occurred_at: at, recorded_at: at, late_entry_reason: null, actor_id: null, actor_role: action.actor_role, subject: null, payload: { action_kind: action.action_kind }
  }));
  return { ok: false, reason: kind.success ? "not_permitted" : "unknown_kind" };
}

// Stand-in for the workflow package: only the two operations the hand case needs, and fences can never move.
function applyOperations(def: WorkflowDefinition, ops: Operation[]): WorkflowDefinition {
  const out = structuredClone(def);
  for (const op of ops) {
    if (op.op === "remove_soft_edge") {
      const e = out.edges.find((x) => x.edge_id === op.edge_id);
      if (!e || e.kind !== "soft") throw new Error(`unknown_id ${op.edge_id}`);
      out.edges = out.edges.filter((x) => x.edge_id !== op.edge_id);
    } else if (op.op === "set_prep_trigger") {
      out.triggers = [...out.triggers.filter((t) => t.target.step !== op.target.step), { target: op.target, when: op.when, condition: null }];
    } else throw new Error(`stub engine does not apply ${op.op}`);
  }
  if (fencesHash(out) !== fencesHash(def) || permissionsHash(out) !== permissionsHash(def)) throw new Error("frozen hash changed");
  return out;
}

// Stand-in for deriveDataIntegrityFences: a stage waits for every record its sections bind.
export function deriveDataIntegrity(def: WorkflowDefinition): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const s of def.steps) {
    if (!s.document_ref || s.action_kind !== "prepare_document") continue;
    const doc = def.documents.find((d) => d.document_id === s.document_ref!.document_id);
    for (const sec of doc?.sections ?? []) {
      if (s.document_ref.stage === "draft" && sec.needed_for !== "draft") continue;
      for (const p of def.steps) if (p.step_id !== s.step_id && p.produces.includes(sec.binding.record_kind)) out.push({ from: p.step_id, to: s.step_id });
    }
  }
  return out;
}

type Server = { kind: "staff"; free: [number, number][]; busy: [number, number][] } | { kind: "fifo"; free_at: number; backlog: number[] | null };

// Earliest start at or after t where the whole job fits in one free window and clashes with no booked job.
function fitStaff(srv: Extract<Server, { kind: "staff" }>, t: number, d: number): number | null {
  for (const [ws, we] of srv.free) {
    let s = Math.max(t, ws);
    for (;;) {
      if (s + d > we) break;
      const clash = srv.busy.find(([bs, be]) => s < be && bs < s + d);
      if (!clash) return s;
      s = clash[1];
    }
  }
  return null;
}

function run(def: WorkflowDefinition, world: World, sch: Schedule, opt: EngineRunOptions): EngineRun {
  const { bindings } = world;
  const order = def.steps.map((s) => s.step_id);
  const facts: Facts = {
    ward_id: sch.ward_id, payer_type: sch.payer_type, expected_disposition: sch.doctor.expected_disposition,
    has_take_home_order: String(sch.doctor.take_home_orders.length > 0), take_home_status: sch.doctor.take_home_orders.length > 0 ? "ordered" : "none",
    expected_discharge_recorded: "false", signoff_recorded: "false", final_bill_issued: "false", insurer_status: "none", payment_status: "unpaid"
  };
  const requires = (doc: string) => wardRequires(world.requirements, sch.ward_id, doc, facts);
  const binding = (id: string) => { const b = bindings.steps[id]; if (!b) throw new Error(`no binding for ${id}`); return b; };

  // Required steps: a true condition, and for an alternative group only the member the schedule selects.
  const required = new Set<string>();
  const groupChoice = new Map<string, string>();
  for (const s of def.steps) {
    if (s.required_when && !evalCondition(s.required_when, facts, requires)) continue;
    if (s.alternative_group) {
      const members = def.steps.filter((m) => m.alternative_group === s.alternative_group);
      const chosen = members.find((m) => { const p = binding(m.step_id).selected_when; return p !== null && readPath(sch, p) !== null; })
        ?? members.find((m) => binding(m.step_id).selected_when === null);
      if (chosen) groupChoice.set(s.alternative_group, chosen.step_id);
      if (chosen?.step_id !== s.step_id) continue;
    }
    required.add(s.step_id);
  }
  const done = new Map<string, { start: number; end: number }>();
  const resolve = (id: string): string | null => {
    const s = def.steps.find((x) => x.step_id === id);
    if (s?.alternative_group) return groupChoice.get(s.alternative_group) ?? null;
    return required.has(id) ? id : null;
  };
  // A dependency on a step that is not required is met from the start; otherwise its completion time, or undefined while pending.
  const depTime = (id: string): number | undefined => { const r = resolve(id); return r === null ? 0 : done.get(r)?.end; };
  const firstEvent = (kind: string): number | undefined => {
    let best: number | undefined;
    for (const [id, t] of done) if (binding(id).event === kind && (best === undefined || t.end < best)) best = t.end;
    return best;
  };
  const predTime = (p: EventPredicate): number | undefined => {
    if ("after" in p) return depTime(p.after.step);
    if ("on" in p) return firstEvent(p.on);
    const xs = ("all_of" in p ? p.all_of : p.any_of).map(predTime);
    if ("all_of" in p) return xs.some((x) => x === undefined) ? undefined : Math.max(...(xs as number[]));
    const known = xs.filter((x): x is number => x !== undefined);
    return known.length ? Math.min(...known) : undefined;
  };
  const derived = deriveDataIntegrity(def);
  const deps = new Map<string, string[]>();
  for (const id of order) deps.set(id, [
    ...def.edges.filter((e) => e.to.step === id).map((e) => e.from.step),
    ...derived.filter((e) => e.to === id).map((e) => e.from),
    ...(opt.practice?.start_after?.[id] ?? [])
  ]);
  const triggerFor = (id: string): EventPredicate[] => {
    const o = opt.practice?.triggers?.[id];
    return o ? [o] : def.triggers.filter((t) => t.target.step === id).map((t) => t.when);
  };

  const servers = new Map<string, Server>();
  const nurseId = sch.staff.nurse;
  const nurse = sch.nurses.find((n) => n.nurse_id === nurseId) ?? sch.nurses[0]!;
  for (const [name, r] of Object.entries(bindings.resources)) {
    if (r.kind === "staff_server") {
      const free: [number, number][] = [];
      let cur = nurse.shift.start;
      for (const b of [...nurse.busy_blocks].sort((a, c) => a.start - c.start)) { if (b.start > cur) free.push([cur, Math.min(b.start, nurse.shift.end)]); cur = Math.max(cur, b.end); }
      if (cur < nurse.shift.end) free.push([cur, nurse.shift.end]);
      servers.set(name, { kind: "staff", free, busy: [] });
    } else servers.set(name, { kind: "fifo", free_at: 0, backlog: r.backlog_path ? (readPath(sch, r.backlog_path) as number[]) : null });
  }
  const service = (key: string): number => {
    const v = sch.service_min[`${key}:1`];
    if (v === undefined) throw new Error(`schedule has no service_min for ${key}:1`);
    return v;
  };
  const num = (path: string | undefined): number => (path ? (readPath(sch, path) as number | null) ?? 0 : 0);
  const book = (resource: string, ready: number, d: number): { start: number; end: number } | null => {
    const srv = servers.get(resource)!;
    if (srv.kind === "staff") {
      const s = fitStaff(srv, ready, d);
      if (s === null) return null;
      srv.busy.push([s, s + d]);
      return { start: s, end: s + d };
    }
    if (srv.backlog) { srv.free_at = Math.max(srv.free_at, ready) + srv.backlog.reduce((a, b) => a + b, 0); srv.backlog = null; }
    const s = Math.max(ready, srv.free_at);
    srv.free_at = s + d;
    return { start: s, end: s + d };
  };

  const violations: string[] = [];
  let blocked = false;
  const pending = new Set(order.filter((id) => required.has(id)));
  for (;;) {
    let pick: { id: string; ready: number } | null = null;
    for (const id of order) {
      if (!pending.has(id)) continue;
      const times = deps.get(id)!.map(depTime);
      const trig = triggerFor(id).map(predTime);
      if ([...times, ...trig].some((t) => t === undefined)) continue;
      let ready = Math.max(0, ...(times as number[]), ...(trig as number[]));
      const tm = binding(id).timing;
      if ("at" in tm) {
        const at = readPath(sch, tm.at);
        if (at === null) { pending.delete(id); blocked = true; continue; }
        ready = Math.max(ready, (at as number) + tm.offset);
      }
      if ("resource" in tm && tm.not_before) ready = Math.max(ready, num(tm.not_before));
      if (!pick || ready < pick.ready) pick = { id, ready };
    }
    if (!pick) break;
    pending.delete(pick.id);
    const step = def.steps.find((s) => s.step_id === pick!.id)!;
    const tm = binding(pick.id).timing;
    let slot: { start: number; end: number } | null;
    if ("at" in tm || "instant" in tm) slot = { start: pick.ready, end: pick.ready };
    else if ("delay" in tm) slot = { start: pick.ready, end: pick.ready + num(tm.delay) };
    else if (opt.preparer === "agent" && step.action_kind === "prepare_document" && step.actor_roles.includes("agent")) {
      const a = pick.ready + opt.parameters.agent_prepare_min.minutes;
      const v = opt.parameters.draft_verification_by_nurse;
      const verify = step.document_ref?.stage === "draft" && v.on && step.actor_roles.includes("nurse") ? book("nurse", a, v.minutes) : { start: a, end: a };
      slot = verify && { start: pick.ready, end: verify.end };
    } else slot = book(tm.resource, pick.ready, (tm.minutes ? num(tm.minutes) : service(tm.service ?? "")) + num(tm.extra));
    if (!slot || slot.end > HORIZON) continue;
    done.set(pick.id, slot);
  }

  // One event per completed step, ordered by occurrence and then by step order.
  const ordinals = new Map<string, number>();
  const events: SimEventT[] = [];
  const stepTimes: Record<string, StepTime> = {};
  const completed = order.filter((id) => done.has(id)).sort((a, b) => done.get(a)!.end - done.get(b)!.end || order.indexOf(a) - order.indexOf(b));
  for (const id of completed) {
    const t = done.get(id)!;
    const step = def.steps.find((s) => s.step_id === id)!;
    const b = binding(id);
    const byAgent = opt.preparer === "agent" && step.action_kind === "prepare_document" && step.actor_roles.includes("agent");
    const role = byAgent ? "agent" : b.actor;
    const actorId = byAgent ? null : sch.staff[role] ?? null;
    let recorded = t.end;
    let reason: string | null = null;
    if (step.clock === "two_clock" && actorId) {
      const key = `${b.event}:${actorId}`;
      const ordinal = (ordinals.get(key) ?? 0) + 1;
      ordinals.set(key, ordinal);
      const lag = sch.entry_lag[`${key}:${ordinal}`] ?? opt.practice?.entry_lag?.({ kind: b.event, actor_id: actorId, ordinal, occurred_at: t.end }) ?? null;
      if (lag) { recorded = Math.min(HORIZON, t.end + lag.lag_min); reason = lag.reason; }
    }
    const e = {
      event_id: eventId(sch.case_id, id), seq: events.length + 1, case_id: sch.case_id, kind: b.event, clock: step.clock,
      occurred_at: t.end, recorded_at: recorded, late_entry_reason: reason, actor_id: actorId, actor_role: role,
      subject: step.document_ref?.document_id ?? null, payload: { step: id, stage: step.document_ref?.stage ?? null }
    };
    const c = checkTwoClock(e);
    if (!c.ok) violations.push(`${id}: ${c.reason}`);
    events.push(SimEvent.parse(e));
    stepTimes[id] = { started_occ: t.start, completed_occ: t.end, completed_rec: recorded };
  }
  const occ = (id: string) => done.get(id)?.end ?? null;
  const signoff = occ(bindings.anchors.signoff);
  const departure = occ(bindings.anchors.departure);
  const release = occ(bindings.anchors.bed_release);
  return {
    case_id: sch.case_id, events, step_times: stepTimes,
    post_signoff_wait_min: signoff !== null && departure !== null ? departure - signoff : null,
    bed_release_delay_min: signoff !== null && release !== null ? release - signoff : null,
    terminal_state: departure !== null ? "departed" : blocked ? "blocked_external" : "horizon_reached",
    invariant_violations: violations
  };
}

export const stubEngine: DischargeEngine = { run, dispatch, applyOperations };
