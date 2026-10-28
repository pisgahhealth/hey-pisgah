import { hashJson, type EventPredicate } from "@hey-pisgah/contracts";
import type { Facts } from "@hey-pisgah/workflow";
import type { HospitalPort, RecordView } from "./port.js";
import type { ActionRec, Condition, Projection } from "./task.js";
import { agentSteps } from "./world.js";

// Acceptance conditions come from the adopted version and the requirements in force, never from the model.
export function deriveConditions(port: HospitalPort): Condition[] {
  const facts = port.facts() as Facts;
  return agentSteps(port.def).filter((s) => port.isActive(s, facts)).map((s) => {
    const { document_id, stage } = s.document_ref!;
    return { condition_id: `${document_id}.${stage}`, description: `${document_id} ${stage} prepared, verified and current`, record_id: port.stageRecordId(document_id, stage), step_id: s.step_id };
  });
}
export const conditionsHash = (cs: readonly Condition[]) => hashJson(cs);

export type ConditionStatus = { condition: Condition; met: boolean; action_id: string | null; record: RecordView | null; refresh: boolean; superseded_by?: string };

// A condition is met when a completed action's proof still matches a fresh read of its record, or the record is complete and current again after a revision.
export function conditionStatus(p: Projection, port: HospitalPort, c: Condition): ConditionStatus {
  const rec = port.record(c.record_id);
  const done = p.order.map((id) => p.actions.get(id)!).filter((a) => a.state === "completed" && a.proof?.record_id === c.record_id);
  const last = done.at(-1) ?? null;
  if (!last || !rec) return { condition: c, met: false, action_id: last?.action_id ?? null, record: rec, refresh: false };
  if (rec.hash === last.proof!.record_hash) return { condition: c, met: true, action_id: last.action_id, record: rec, refresh: false };
  const current = rec.status === "complete" && rec.source_refs.every((s) => s.version === s.current_version);
  return { condition: c, met: false, action_id: last.action_id, record: rec, refresh: current };
}

// All conditions at once: a proved draft whose own final is met counts as superseded, since the engine never revises a draft after its final begins.
export function conditionStatuses(p: Projection, port: HospitalPort, conds: readonly Condition[]): ConditionStatus[] {
  const st = conds.map((c) => conditionStatus(p, port, c));
  return st.map((s) => {
    if (s.met || s.action_id === null || !s.condition.condition_id.endsWith(".draft")) return s;
    const fin = st.find((x) => x.condition.condition_id === s.condition.condition_id.replace(/\.draft$/, ".final"));
    return fin?.met && fin.action_id ? { ...s, met: true, superseded_by: fin.action_id } : s;
  });
}

const stepDone = (step_id: string): EventPredicate => ({ on: "step.completed", where: { step_id } });

function leavesOf(p: EventPredicate): EventPredicate[] {
  if ("after" in p) return [stepDone(p.after.step)];
  if ("on" in p) return [p];
  return ("all_of" in p ? p.all_of : p.any_of).flatMap(leavesOf);
}

export type Derived = { leaves: EventPredicate[]; record_ids: string[]; ready: Condition[] };

// Wakes derived from the definition: what each unmet condition, or each written but unverified action, still waits on.
export function deriveWakeLeaves(p: Projection, port: HospitalPort, unmet: readonly Condition[]): Derived {
  const leaves: EventPredicate[] = [];
  const record_ids: string[] = [];
  const ready: Condition[] = [];
  const add = (l: EventPredicate) => { if (!leaves.some((x) => hashJson(x) === hashJson(l))) leaves.push(l); };
  const written = (c: Condition): ActionRec | undefined => p.order.map((id) => p.actions.get(id)!).find((a) => a.written?.target_record_id === c.record_id && (a.state === "written" || a.state === "completed"));
  for (const c of unmet) {
    const step = port.def.steps.find((s) => s.step_id === c.step_id)!;
    const rec = port.record(c.record_id);
    const w = written(c);
    if (rec && rec.status === "stale") { add({ on: "document.revised", where: { document_id: step.document_ref!.document_id, stage: step.document_ref!.stage } }); record_ids.push(c.record_id); continue; }
    if (w || (rec && rec.status === "in_progress")) { add(stepDone(c.step_id)); record_ids.push(c.record_id); continue; }
    if (rec && rec.status === "complete") { ready.push(c); continue; }
    const waiting = port.waitingFor(step);
    if (!waiting.length) { ready.push(c); continue; }
    // A prerequisite that is itself an unwritten agent step is its own condition, so it adds no wake.
    const ownUnwritten = (sid: string) => unmet.some((u) => u.step_id === sid && !written(u));
    for (const x of waiting) {
      if (x.when) leavesOf(x.when).filter((l) => !("on" in l && l.on === "step.completed" && ownUnwritten(String(l.where?.["step_id"])))).forEach(add);
      else if (x.step_id && !ownUnwritten(x.step_id)) add(stepDone(x.step_id));
    }
    record_ids.push(c.record_id);
  }
  return { leaves, record_ids, ready };
}

export const REQUIREMENTS_WAKE: EventPredicate = { on: "requirements.changed" };
