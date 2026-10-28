import {
  AGENT_ALLOWED_KINDS, RunResult, WorkflowDefinition, definitionHash, hashJson,
  type ActionKind, type EventPredicate, type RecordKind, type RunMetrics, type SimEvent, type Step, type WorkflowDefinition as WD
} from "@hey-pisgah/contracts";
import { boundRecordKinds, deriveDataIntegrityFences, evalCondition, isPreparingStep, type FactValue } from "@hey-pisgah/workflow";
import { Engine, SimInvariantViolation } from "./engine.js";
import { PermissionGate } from "./permissions.js";
import { Phase } from "./queue.js";
import { Server } from "./resources.js";
import { effectiveParams, rulesHashFor } from "./rules.js";
import { ExternalSchedule, ScheduleMissingDraw, entryLagKey, scheduleHash, serviceKey, type ExternalSchedule as Schedule } from "./schedule.js";

export type RunOptions = {
  run_id?: string;
  executor?: "definition" | "historical";
  // When false, steps the agent could prepare go to the first staff role instead.
  use_agent?: boolean;
};

type StepState = "idle" | "queued" | "running" | "held" | "revising" | "verifying" | "occurring" | "done";
type JobKind = "step" | "revise" | "verify" | "recheck";
type Job = {
  job_id: string; kind: JobKind; step_id: string; role: string; actor_id: string; action_kind: ActionKind;
  document_id: string | null; stage: string | null; attempt: number; duration: number;
};
type StageRec = {
  step_id: string; document_id: string; stage: string; role: string; actor_id: string; agent: boolean;
  captured: Record<string, number>; minutes: number; revisions: number; pending: number; completed: boolean;
  checks: { step_id: string; role: string; actor_id: string; attempt: number }[]; handed_over: boolean; verifications: number;
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const AGENT = "agent";

// Runs one workflow definition against one frozen schedule; the result is a pure function of the two inputs and the rules.
export function runDefinition(defIn: WD, scheduleIn: Schedule, opts: RunOptions = {}): RunResult {
  const def = WorkflowDefinition.parse(defIn) as WD;
  const schedule = ExternalSchedule.parse(scheduleIn);
  const params = effectiveParams(schedule.params);
  const executor = opts.executor ?? "definition";
  const useAgent = opts.use_agent ?? true;
  const version_hash = definitionHash(def);
  const schedule_hash = scheduleHash(schedule);
  const rules_hash = rulesHashFor(params);
  const run_id = opts.run_id ?? `run-${hashJson({ version_hash, schedule_hash, executor, rules_hash, useAgent }).slice(0, 8)}`;

  const eng = new Engine(schedule.case_id, run_id);
  const gate = new PermissionGate(def.permissions);
  const steps = [...def.steps].sort((a, b) => cmp(a.step_id, b.step_id));
  const byId = new Map(steps.map((s) => [s.step_id, s]));
  const derived = deriveDataIntegrityFences(def);
  const facts: Record<string, FactValue> = structuredClone(schedule.facts);
  const records = new Map<string, { version: number; payload: unknown }>();
  const state = new Map<string, StepState>(steps.map((s) => [s.step_id, "idle"]));
  const times = new Map<string, { started_occ: number | null; completed_occ: number | null; completed_rec: number | null }>(
    steps.map((s) => [s.step_id, { started_occ: null, completed_occ: null, completed_rec: null }])
  );
  const fired = new Set<number>();
  const stages = new Map<string, StageRec>();
  const dueAfter = new Map<string, number>();
  const servers = new Map<string, Server>();
  for (const [role, spec] of Object.entries(schedule.resources).sort(([a], [b]) => cmp(a, b))) servers.set(role, new Server(role, spec.busy_blocks));
  const staffMin: Record<string, number> = {};
  const intents = new Set<string>();
  const m = { planned_checks: 0, unplanned: 0, duplicates: 0, stale: 0, rework_events: 0, rework_min: 0, agent_actions: 0, runtime: 0, person: 0 };
  const wakes = new Set<number>();
  const picks = new Set<string>();
  let jobSeq = 0;

  const actorId = (role: string) => schedule.actors[role] ?? `${role}-1`;
  const draw = (id: string) => schedule.steps[id];
  const stageKey = (doc: string, stage: string) => `${doc}|${stage}`;
  const docOf = (id: string) => def.documents.find((d) => d.document_id === id);

  function serviceMin(kind: string, doc: string | null, stage: string | null, attempt: number): number {
    const v = schedule.service_min[serviceKey(kind, doc, stage, attempt)] ?? schedule.service_default_min[kind];
    if (v === undefined) throw new ScheduleMissingDraw(`no service time for ${serviceKey(kind, doc, stage, attempt)}`);
    return v;
  }

  function groupMembers(s: Step): Step[] {
    return s.alternative_group === null ? [s] : steps.filter((x) => x.alternative_group === s.alternative_group);
  }
  function selected(s: Step): boolean {
    if (s.alternative_group === null) return true;
    const pick = schedule.alternatives[s.alternative_group] ?? groupMembers(s)[0]?.step_id;
    return pick === s.step_id;
  }
  function isActive(s: Step): boolean {
    return selected(s) && (s.required_when === null || evalCondition(s.required_when, facts));
  }
  // An edge from a step is satisfied once any member of its group completed, or once no member is required.
  function fromSatisfied(stepId: string): boolean {
    const s = byId.get(stepId);
    if (!s) return false;
    const members = groupMembers(s);
    return members.some((x) => state.get(x.step_id) === "done") || members.every((x) => !isActive(x));
  }
  const startEdges = (s: Step) => def.edges.filter((e) => e.to.step === s.step_id && e.gate === "start");
  const completeEdges = (s: Step) => [
    ...def.edges.filter((e) => e.to.step === s.step_id && e.gate === "complete").map((e) => e.from.step),
    ...derived.filter((e) => e.to.step === s.step_id).map((e) => e.from.step)
  ];
  const startGatesOk = (s: Step) => startEdges(s).every((e) => fromSatisfied(e.from.step));
  const completeGatesOk = (s: Step) => completeEdges(s).every(fromSatisfied);

  function holds(p: EventPredicate): boolean {
    if ("after" in p) return fromSatisfied(p.after.step);
    if ("on" in p) {
      const where = Object.entries(p.where ?? {});
      return eng.events.some((e) => e.kind === p.on && where.every(([k, v]) => {
        const got = (e.payload as Record<string, unknown> | null)?.[k];
        return typeof got === "string" && got === v;
      }));
    }
    return "all_of" in p ? p.all_of.every(holds) : p.any_of.some(holds);
  }
  function triggerOk(s: Step): boolean {
    const idx = def.triggers.map((t, i) => (t.target.step === s.step_id ? i : -1)).filter((i) => i >= 0);
    return idx.length === 0 || idx.some((i) => fired.has(i));
  }
  function citedStage(s: Step): StageRec | undefined {
    if (!s.document_ref || isPreparingStep(s)) return undefined;
    return stages.get(stageKey(s.document_ref.document_id, s.document_ref.stage));
  }
  function externalDue(s: Step): number | null {
    const due = draw(s.step_id)?.due;
    if (due === undefined || due === "never") return null;
    if ("at" in due) return due.at;
    return dueAfter.get(s.step_id) ?? null;
  }
  const currentVersions = (s: Step) => Object.fromEntries(boundRecordKinds(def, s).map((rk) => [rk, records.get(rk)?.version ?? 0]));
  const staleKinds = (s: Step, captured: Record<string, number>) => boundRecordKinds(def, s).filter((rk) => (records.get(rk)?.version ?? 0) !== (captured[rk] ?? 0));

  function wake(at: number): void {
    const t = Math.max(at, eng.now);
    if (wakes.has(t) || t > eng.horizon) return;
    wakes.add(t);
    eng.at(t, Phase.executor_decision, `decide@${t}`, 0, () => { wakes.delete(t); decide(); });
  }
  const requestDecide = () => wake(eng.now);

  function chooseRole(s: Step): string {
    const doc = s.document_ref ? docOf(s.document_ref.document_id) : undefined;
    const agentOk = s.actor_roles.includes(AGENT) && AGENT_ALLOWED_KINDS.has(s.action_kind) && (!doc || doc.preparable_by.includes(AGENT));
    if (useAgent && agentOk) return AGENT;
    return s.actor_roles.find((r) => r !== AGENT) ?? s.actor_roles[0]!;
  }

  function pump(role: string): void {
    const key = `${role}@${eng.now}`;
    if (picks.has(key)) return;
    picks.add(key);
    eng.at(eng.now, Phase.staff_reaction, `pick:${role}`, eng.now, () => { picks.delete(key); pick(role); });
  }
  const own = new Map<string, Job>();
  function pick(role: string): void {
    const sv = servers.get(role)!;
    if (!sv.idle(eng.now)) return;
    const head = sv.queue[0];
    if (!head) return;
    const start = sv.earliestStart(eng.now, head.duration);
    if (start > eng.now) {
      eng.at(start, Phase.staff_reaction, `pick:${role}`, start, () => pick(role));
      return;
    }
    sv.queue.shift();
    sv.busyUntil = eng.now + head.duration;
    const job = own.get(head.job_id);
    if (job) startJob(job);
    else eng.at(eng.now + head.duration, Phase.resource_completion, head.job_id, 1, () => pump(role));
  }

  function submit(job: Job): void {
    const sv = servers.get(job.role);
    if (!sv || job.role === AGENT) {
      eng.at(eng.now, Phase.staff_reaction, job.job_id, job.attempt, () => startJob(job));
      return;
    }
    own.set(job.job_id, job);
    sv.enqueue({ job_id: job.job_id, key: hashJson([schedule.case_id, job.job_id, job.attempt]), enqueued_at: eng.now, duration: job.duration, own: true });
    pump(job.role);
  }
  function makeJob(kind: JobKind, s: Step, role: string, action_kind: ActionKind, attempt: number, duration: number, doc: string | null, stage: string | null): Job {
    jobSeq += 1;
    return { job_id: `${kind}:${s.step_id}:${attempt}:${jobSeq}`, kind, step_id: s.step_id, role, actor_id: actorId(role), action_kind, document_id: doc, stage, attempt, duration };
  }
  function duration(role: string, kind: ActionKind, doc: string | null, stage: string | null, attempt: number): number {
    return role === AGENT ? params.agent_prep_min : serviceMin(kind, doc, stage, attempt);
  }

  function startJob(job: Job): void {
    if (!gate.attempt(job.role, job.action_kind)) {
      eng.emit({ kind: "action.refused", actor_id: job.actor_id, actor_role: job.role, subject: job.step_id, payload: { action_kind: job.action_kind, job_kind: job.kind } });
      return;
    }
    const s = byId.get(job.step_id)!;
    if (job.kind === "step") {
      state.set(s.step_id, "running");
      times.get(s.step_id)!.started_occ = eng.now;
      eng.emit({ kind: "step.started", actor_id: job.actor_id, actor_role: job.role, subject: s.step_id, payload: { step_id: s.step_id, action_kind: s.action_kind, attempt: job.attempt } });
      if (isPreparingStep(s)) {
        const ref = s.document_ref!;
        stages.set(stageKey(ref.document_id, ref.stage), {
          step_id: s.step_id, document_id: ref.document_id, stage: ref.stage, role: job.role, actor_id: job.actor_id, agent: job.role === AGENT,
          captured: currentVersions(s), minutes: 0, revisions: 0, pending: 0, completed: false, checks: [], handed_over: false, verifications: 0
        });
      }
    }
    if (job.role !== AGENT) staffMin[job.role] = (staffMin[job.role] ?? 0) + job.duration;
    const st = job.document_id && job.stage ? stages.get(stageKey(job.document_id, job.stage)) : undefined;
    if (st && (job.kind === "step" || job.kind === "revise")) st.minutes += job.duration;
    eng.at(eng.now + job.duration, Phase.resource_completion, job.job_id, job.attempt, () => finishJob(job));
  }

  function countDecision(role: string): void {
    if (role === AGENT) { m.runtime += 1; m.agent_actions += 1; } else m.person += 1;
  }

  function finishJob(job: Job): void {
    if (servers.has(job.role) && job.role !== AGENT) pump(job.role);
    const s = byId.get(job.step_id)!;
    const st = job.document_id && job.stage ? stages.get(stageKey(job.document_id, job.stage)) : undefined;
    const evBase = { actor_id: job.actor_id, actor_role: job.role, subject: job.step_id };
    if (job.kind === "step") {
      if (isPreparingStep(s)) tryFinalize(s);
      else completeWithLag(s, job.role, job.actor_id, job.attempt);
    } else if (job.kind === "revise" && st) {
      eng.emit({ ...evBase, kind: "document.revised", payload: { action_kind: job.action_kind, document_id: st.document_id, stage: st.stage, attempt: job.attempt } });
      countDecision(job.role);
      m.rework_events += 1;
      m.rework_min += job.duration;
      st.captured = currentVersions(s);
      st.revisions += 1;
      if (!st.completed) tryFinalize(s);
      else {
        st.pending -= 1;
        afterRevision(s, st);
      }
    } else if (job.kind === "verify" && st) {
      eng.emit({ ...evBase, kind: "check.verified", payload: { action_kind: job.action_kind, document_id: st.document_id, stage: st.stage, attempt: job.attempt } });
      countDecision(job.role);
      st.verifications += 1;
      if (st.verifications === 1) m.planned_checks += 1;
      else { m.unplanned += 1; m.rework_min += job.duration; }
      if (!st.completed) completeWithLag(s, st.role, st.actor_id, 1);
      else st.pending -= 1;
    } else if (job.kind === "recheck" && st) {
      eng.emit({ ...evBase, kind: "check.repeated", payload: { action_kind: job.action_kind, document_id: st.document_id, stage: st.stage, attempt: job.attempt } });
      countDecision(job.role);
      m.unplanned += 1;
      m.rework_min += job.duration;
      st.pending -= 1;
    }
    requestDecide();
  }

  function verificationRole(st: StageRec): string | null {
    const doc = docOf(st.document_id);
    if (!params.draft_verification.on || !st.agent || st.stage !== "draft" || !doc?.check) return null;
    return doc.check.role;
  }

  // A prepared stage completes only when its complete gates hold, its sources are current and, for an agent draft, the checker has verified it.
  function tryFinalize(s: Step): void {
    const ref = s.document_ref!;
    const st = stages.get(stageKey(ref.document_id, ref.stage))!;
    if (!completeGatesOk(s)) {
      if (state.get(s.step_id) !== "held") {
        state.set(s.step_id, "held");
        eng.emit({ kind: "step.held", actor_id: st.actor_id, actor_role: st.role, subject: s.step_id, payload: { step_id: s.step_id, action_kind: s.action_kind } });
      }
      return;
    }
    const stale = staleKinds(s, st.captured);
    if (stale.length) {
      state.set(s.step_id, "revising");
      eng.emit({ kind: "document.stale", actor_id: null, actor_role: null, subject: s.step_id, payload: { document_id: ref.document_id, stage: ref.stage, record_kinds: stale } });
      const attempt = st.revisions + 1;
      submit(makeJob("revise", s, st.role, "revise_document", attempt, duration(st.role, "revise_document", ref.document_id, ref.stage, attempt), ref.document_id, ref.stage));
      return;
    }
    const vr = verificationRole(st);
    if (vr !== null && st.verifications === 0) {
      state.set(s.step_id, "verifying");
      submit(makeJob("verify", s, vr, "check_document", 1, params.draft_verification.min, ref.document_id, ref.stage));
      return;
    }
    completeWithLag(s, st.role, st.actor_id, 1);
  }

  function afterRevision(s: Step, st: StageRec): void {
    const vr = verificationRole(st);
    if (vr !== null) {
      st.pending += 1;
      submit(makeJob("verify", s, vr, "check_document", st.verifications + 1, params.draft_verification.min, st.document_id, st.stage));
    }
    for (const c of st.checks) {
      st.pending += 1;
      c.attempt += 1;
      const cs = byId.get(c.step_id)!;
      submit(makeJob("recheck", cs, c.role, "check_document", c.attempt, serviceMin("check_document", st.document_id, st.stage, c.attempt), st.document_id, st.stage));
    }
  }

  function completeWithLag(s: Step, role: string, actor: string, attempt: number): void {
    const occ = eng.now;
    const lag = s.clock === "two_clock" ? schedule.entry_lag[entryLagKey("step.completed", s.step_id, actor, attempt)] : undefined;
    const lagMin = lag?.lag_min ?? 0;
    if (lagMin > 0) {
      state.set(s.step_id, "occurring");
      eng.at(occ + lagMin, Phase.external, `record:${s.step_id}`, attempt, () => complete(s, role, actor, attempt, occ, lag?.reason ?? null));
      return;
    }
    complete(s, role, actor, attempt, occ, lag?.reason ?? null, occ + lagMin);
  }

  function complete(s: Step, role: string, actor: string, attempt: number, occ: number, reason: string | null, rec = eng.now): void {
    state.set(s.step_id, "done");
    const t = times.get(s.step_id)!;
    t.started_occ ??= occ;
    t.completed_occ = occ;
    t.completed_rec = rec;
    const ref = s.document_ref;
    eng.emit({
      kind: "step.completed", clock: s.clock, occurred_at: occ, recorded_at: rec, late_entry_reason: reason, actor_id: actor, actor_role: role, subject: s.step_id,
      payload: { step_id: s.step_id, action_kind: s.action_kind, attempt, ...(ref ? { document_id: ref.document_id, stage: ref.stage } : {}) }
    });
    countDecision(role);
    if (ref && isPreparingStep(s)) {
      const st = stages.get(stageKey(ref.document_id, ref.stage))!;
      st.completed = true;
      const intent = hashJson({ step_id: s.step_id, captured: st.captured });
      if (intents.has(intent)) m.duplicates += 1;
      intents.add(intent);
    }
    const cited = citedStage(s);
    if (cited) {
      const prep = byId.get(cited.step_id)!;
      if (staleKinds(prep, cited.captured).length > 0) m.stale += 1;
      if (s.action_kind === "check_document") { m.planned_checks += 1; cited.checks.push({ step_id: s.step_id, role, actor_id: actor, attempt: 1 }); }
      else cited.handed_over = true;
    }
    for (const rk of s.produces) bumpRecord(rk, draw(s.step_id)?.payload ?? null, s.step_id);
    for (const [k, v] of Object.entries(draw(s.step_id)?.sets_facts ?? {}).sort(([a], [b]) => cmp(a, b))) facts[k] = v;
    for (const x of steps) {
      const due = draw(x.step_id)?.due;
      if (x.external && due !== undefined && due !== "never" && "after" in due && due.after === s.step_id && !dueAfter.has(x.step_id)) {
        dueAfter.set(x.step_id, rec + due.delay_min);
        wake(rec + due.delay_min);
      }
    }
    requestDecide();
  }

  function bumpRecord(rk: RecordKind, payload: unknown, stepId: string | null): void {
    const version = (records.get(rk)?.version ?? 0) + 1;
    records.set(rk, { version, payload });
    eng.emit({ kind: "record.versioned", actor_id: null, actor_role: null, subject: rk, payload: { record_kind: rk, version, step_id: stepId } });
    // A completed stage that binds this record goes stale and is revised, unless a later stage has begun or it was handed over.
    for (const st of [...stages.values()].sort((a, b) => cmp(a.step_id, b.step_id))) {
      if (!st.completed || st.handed_over) continue;
      const prep = byId.get(st.step_id)!;
      if (!boundRecordKinds(def, prep).includes(rk)) continue;
      const laterBegun = st.stage === "draft" && steps.some((x) => isPreparingStep(x) && x.document_ref!.document_id === st.document_id && x.document_ref!.stage === "final" && state.get(x.step_id) !== "idle");
      if (laterBegun) continue;
      if (staleKinds(prep, st.captured).length === 0) continue;
      eng.emit({ kind: "document.stale", actor_id: null, actor_role: null, subject: st.step_id, payload: { document_id: st.document_id, stage: st.stage, record_kinds: [rk] } });
      if (!gate.allowed(st.role, "revise_document")) continue;
      st.pending += 1;
      const attempt = st.revisions + 1;
      submit(makeJob("revise", prep, st.role, "revise_document", attempt, duration(st.role, "revise_document", st.document_id, st.stage, attempt), st.document_id, st.stage));
    }
  }

  function occurExternal(s: Step): void {
    state.set(s.step_id, "occurring");
    const role = s.actor_roles[0]!;
    if (!gate.attempt(role, s.action_kind)) {
      eng.emit({ kind: "action.refused", actor_id: actorId(role), actor_role: role, subject: s.step_id, payload: { action_kind: s.action_kind, job_kind: "step" } });
      return;
    }
    times.get(s.step_id)!.started_occ = eng.now;
    completeWithLag(s, role, actorId(role), 1);
  }

  function decide(): void {
    def.triggers.forEach((t, i) => {
      if (!fired.has(i) && holds(t.when) && (t.condition === null || evalCondition(t.condition, facts))) fired.add(i);
    });
    for (const s of steps) {
      const st = state.get(s.step_id);
      if (st === "held" && completeGatesOk(s)) { tryFinalize(s); continue; }
      if (st !== "idle" || !isActive(s)) continue;
      if (!startGatesOk(s) || !triggerOk(s)) continue;
      const cited = citedStage(s);
      if (cited && cited.pending > 0) continue;
      const d = draw(s.step_id);
      if (d?.blocked) continue;
      if (d?.not_before !== undefined && d.not_before > eng.now) { wake(d.not_before); continue; }
      if (s.external) {
        const due = externalDue(s);
        if (due === null) continue;
        if (due > eng.now) { wake(due); continue; }
        if (!completeGatesOk(s)) continue;
        occurExternal(s);
        continue;
      }
      const role = chooseRole(s);
      const ref = s.document_ref;
      state.set(s.step_id, "queued");
      eng.emit({ kind: "job.queued", actor_id: actorId(role), actor_role: role, subject: s.step_id, payload: { step_id: s.step_id, action_kind: s.action_kind, attempt: 1 } });
      submit(makeJob("step", s, role, s.action_kind, 1, duration(role, s.action_kind, ref?.document_id ?? null, ref?.stage ?? null, 1), ref?.document_id ?? null, ref?.stage ?? null));
    }
  }

  // Exogenous world events at absolute minutes; they never depend on what the workflow does.
  for (const [role, spec] of Object.entries(schedule.resources).sort(([a], [b]) => cmp(a, b))) {
    spec.busy_blocks.forEach((b, i) => {
      eng.at(b.from, Phase.external, `busy:${role}:${i}`, 0, () => eng.emit({ kind: "world.busy_started", actor_id: actorId(role), actor_role: role, subject: null, payload: { role, until: b.to } }));
      eng.at(b.to, Phase.external, `busy_end:${role}:${i}`, 0, () => { eng.emit({ kind: "world.busy_ended", actor_id: actorId(role), actor_role: role, subject: null, payload: { role } }); pump(role); });
    });
    for (const j of spec.backlog) {
      eng.at(j.arrive_at, Phase.external, `backlog:${role}:${j.job_id}`, 0, () => {
        eng.emit({ kind: "world.backlog_arrived", actor_id: null, actor_role: role, subject: null, payload: { role, job_id: j.job_id, service_min: j.service_min } });
        servers.get(role)!.enqueue({ job_id: `backlog:${j.job_id}`, key: hashJson([schedule.case_id, j.job_id]), enqueued_at: eng.now, duration: j.service_min, own: false });
        pump(role);
      });
    }
  }
  for (const u of schedule.record_updates) {
    eng.at(u.at, Phase.external, `update:${u.update_id}`, 0, () => {
      eng.emit({ kind: "world.record_updated", actor_id: actorId(u.actor_role), actor_role: u.actor_role, subject: u.record_kind, payload: { update_id: u.update_id, record_kind: u.record_kind } });
      bumpRecord(u.record_kind, u.payload, null);
      requestDecide();
    });
  }
  for (const s of steps) {
    const due = draw(s.step_id)?.due;
    if (s.external && due !== undefined && due !== "never" && "at" in due) {
      eng.at(due.at, Phase.external, `due:${s.step_id}`, 0, () => { eng.emit({ kind: "world.due", actor_id: null, actor_role: null, subject: s.step_id, payload: { step_id: s.step_id } }); requestDecide(); });
    }
  }
  wake(0);

  installRunInvariants(eng, def, gate, isActive);

  const base = { run_id, case_id: schedule.case_id, version_hash, executor, rules_hash, schedule_hash };
  try {
    eng.run();
  } catch (e) {
    if (e instanceof SimInvariantViolation) {
      return RunResult.parse({ outcome: "aborted", ...base, invariant_violations: e.violations, aborted_at: e.at });
    }
    throw e;
  }

  const active = steps.filter(isActive);
  const done = (s: Step) => state.get(s.step_id) === "done";
  const firstDone = (pred: (s: Step) => boolean) => steps.filter((s) => pred(s) && done(s)).map((s) => times.get(s.step_id)!.completed_occ!).sort((a, b) => a - b)[0];
  const signoff = firstDone((s) => s.produces.includes(params.markers.signoff_record as RecordKind));
  const departure = firstDone((s) => s.action_kind === params.markers.departure_action);
  const bedRelease = firstDone((s) => s.action_kind === params.markers.bed_release_action);
  const scheduledBlocker = (s: Step) => draw(s.step_id)?.blocked === true || (s.external && (draw(s.step_id)?.due === undefined || draw(s.step_id)?.due === "never"));
  const terminal: RunMetrics["terminal_state"] = departure !== undefined ? "departed" : active.some((s) => !done(s) && scheduledBlocker(s)) ? "blocked_external" : "horizon_reached";
  let unnecessaryDocs = 0, unnecessaryMin = 0;
  for (const st of [...stages.values()].sort((a, b) => cmp(a.step_id, b.step_id))) {
    if (!isActive(byId.get(st.step_id)!)) { unnecessaryDocs += 1; unnecessaryMin += st.minutes; }
  }
  const metrics: RunMetrics = {
    required_steps_done: active.filter(done).length,
    required_steps_total: active.length,
    prohibited_attempted: gate.attempted,
    prohibited_executed: gate.executed,
    planned_checks: m.planned_checks,
    unplanned_interventions: m.unplanned,
    unnecessary_docs: unnecessaryDocs,
    unnecessary_min: unnecessaryMin,
    duplicates: m.duplicates,
    stale_actions: m.stale,
    rework_events: m.rework_events,
    rework_min: m.rework_min,
    staff_min_by_role: Object.fromEntries(Object.entries(staffMin).sort(([a], [b]) => cmp(a, b))),
    agent_actions: m.agent_actions,
    post_signoff_wait_min: signoff !== undefined && departure !== undefined && departure >= signoff ? departure - signoff : null,
    bed_release_delay_min: signoff !== undefined && bedRelease !== undefined && bedRelease >= signoff ? bedRelease - signoff : null,
    terminal_state: terminal
  };
  const recordList = [...records.entries()].sort(([a], [b]) => cmp(a, b)).map(([record_kind, r]) => ({ record_kind, version: r.version, payload: r.payload ?? null }));
  const factList = Object.entries(facts).sort(([a], [b]) => cmp(a, b));
  const stageList = [...stages.values()].filter((s) => s.completed).sort((a, b) => cmp(a.step_id, b.step_id)).map((s) => ({ document_id: s.document_id, stage: s.stage, captured: s.captured, revisions: s.revisions }));
  return RunResult.parse({
    outcome: "ok",
    ...base,
    final_state: { facts: Object.fromEntries(factList), records: Object.fromEntries(recordList.map((r) => [r.record_kind, r.version])), steps: Object.fromEntries([...state.entries()]) },
    events: eng.events,
    step_times: Object.fromEntries(steps.map((s) => [s.step_id, times.get(s.step_id)!])),
    metrics,
    decided_by_counts: { model: 0, runtime: m.runtime, person: m.person },
    effect_set_hash: hashJson({ records: recordList, facts: factList, stages: stageList }),
    invariant_violations: []
  });
}

// Fence order, permissions and data integrity, checked from the event log itself after every processed entry.
export function installRunInvariants(eng: Engine, def: WD, gate: PermissionGate, isActive: (s: Step) => boolean): void {
  const derived = deriveDataIntegrityFences(def);
  const byId = new Map(def.steps.map((s) => [s.step_id, s]));
  const doneAt = new Map<string, number>();
  const versions = new Map<string, number>();
  const fences = def.edges.filter((e) => e.kind === "fence");
  const satisfied = (from: string, at: number) => {
    const s = byId.get(from);
    if (!s) return false;
    const members = s.alternative_group === null ? [s] : def.steps.filter((x) => x.alternative_group === s.alternative_group);
    return members.some((x) => (doneAt.get(x.step_id) ?? Infinity) <= at) || members.every((x) => !isActive(x));
  };
  eng.addInvariant((fresh: readonly SimEvent[]) => {
    const out: string[] = [];
    for (const e of fresh) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (e.actor_role !== null && typeof p["action_kind"] === "string" && (e.kind.startsWith("step.") || e.kind.startsWith("check.") || e.kind === "document.revised")) {
        if (!gate.allowed(e.actor_role, p["action_kind"])) out.push(`permission ${e.actor_role} on ${p["action_kind"]} at seq ${e.seq}`);
      }
      if (e.kind === "record.versioned") versions.set(String(p["record_kind"]), Number(p["version"]));
      const sid = typeof p["step_id"] === "string" ? p["step_id"] : null;
      if (sid === null || (e.kind !== "step.started" && e.kind !== "step.completed")) continue;
      const step = byId.get(sid);
      if (!step) continue;
      const checkStart = e.kind === "step.started" || (step.external && e.kind === "step.completed");
      for (const f of fences) {
        if (f.to.step !== sid) continue;
        if ((f.gate === "start" && checkStart) || (f.gate === "complete" && e.kind === "step.completed")) {
          if (!satisfied(f.from.step, e.occurred_at)) out.push(`fence ${f.edge_id} ${f.from.step} before ${sid} broken at seq ${e.seq}`);
        }
      }
      if (e.kind === "step.completed") {
        for (const d of derived) {
          if (d.to.step === sid && !satisfied(d.from.step, e.occurred_at)) out.push(`data_integrity ${d.from.step} before ${sid} broken at seq ${e.seq}`);
        }
        if (isPreparingStep(step)) {
          for (const rk of boundRecordKinds(def, step)) {
            const producers = def.steps.filter((x) => x.produces.includes(rk));
            const needed = producers.some((x) => isActive(x));
            if (needed && (versions.get(rk) ?? 0) === 0 && producers.length > 0) out.push(`data_integrity ${rk} missing when ${sid} completed at seq ${e.seq}`);
          }
        }
        doneAt.set(sid, e.occurred_at);
      }
    }
    return out;
  });
}
