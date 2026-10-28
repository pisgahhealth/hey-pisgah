import { RUNTIME_EVENT_TYPES, TaskState, type RunResult, type WorkflowDefinition } from "@hey-pisgah/contracts";
import type { Manifest } from "@hey-pisgah/cases";
import { boundRecordKinds, evalCondition, isPreparingStep, type Facts } from "@hey-pisgah/workflow";
import { loadContentRules, rulesFor, type ContentRules } from "./acceptance/rules.js";
import { Trace, finalFacts } from "./acceptance/trace.js";

// One record from a task's own stream; RUNTIME_EVENT_TYPES names the types the runtime writes.
export type RuntimeEvent = { seq: number; record_type: string; payload: unknown };
export const RUNTIME_TYPES: ReadonlySet<string> = new Set(RUNTIME_EVENT_TYPES);

// Seam to the agent runtime: what each task claimed and what its guard refused; never used for the verdict.
export interface TaskStreamReader {
  taskIds(): string[];
  caseOf(taskId: string): string;
  events(taskId: string): readonly RuntimeEvent[];
}

// One prepared document stage as the hospital record holds it; source versions are what the stage cites against what is current.
export type StageRecord = {
  document_id: string;
  stage: "draft" | "final";
  status: "complete" | "pending" | "absent";
  version: number;
  source_refs: { record_kind: string; version: number; current_version: number }[];
  handed_over: boolean;
};
export type RecordState = { case_id: string; ward_id: string; requirement_version: string; facts: Facts; stages: StageRecord[] };

// Seam to the hospital side: the actual record state at the end of a run; null means the read failed.
export interface RecordStateReader {
  recordState(caseId: string): RecordState | null;
}

export type Unmet = { condition: string; reason: "absent" | "not_complete" | "stale_source" | "content_rule" | "record_unavailable" };
export type Verdict = { case_id: string; pass: boolean; required: string[]; unmet: Unmet[] };

// The stages the agent must leave complete: agent-preparable stages whose step is required under the case's facts.
export function requiredStages(def: WorkflowDefinition, facts: Facts): { id: string; document_id: string; stage: "draft" | "final"; step_id: string }[] {
  return def.steps
    .filter((s) => isPreparingStep(s) && !s.external && s.actor_roles.includes("agent"))
    .filter((s) => def.documents.find((d) => d.document_id === s.document_ref!.document_id)?.preparable_by.includes("agent"))
    .filter((s) => s.required_when === null || evalCondition(s.required_when, facts))
    .map((s) => ({ id: `${s.document_ref!.document_id}.${s.document_ref!.stage}`, document_id: s.document_ref!.document_id, stage: s.document_ref!.stage, step_id: s.step_id }));
}

// FR-5: judges completion from the record state alone; it takes no task stream, so the agent's claim cannot reach the verdict.
export function verifyCompletion(def: WorkflowDefinition, state: RecordState | null, caseId: string, rules: ContentRules = loadContentRules()): Verdict {
  if (state === null) return { case_id: caseId, pass: false, required: [], unmet: [{ condition: "record_state", reason: "record_unavailable" }] };
  const req = requiredStages(def, state.facts);
  const stage = (doc: string, st: string) => state.stages.find((x) => x.document_id === doc && x.stage === st);
  const content = rulesFor(rules, state.ward_id, state.requirement_version).filter((r) => r.applies_when === null || evalCondition(r.applies_when, state.facts));
  const unmet: Unmet[] = [];
  for (const r of req) {
    const s = stage(r.document_id, r.stage);
    const fin = r.stage === "draft" ? stage(r.document_id, "final") : undefined;
    // A draft is settled once its own final is complete, since a draft is never revised after its final begins.
    const target = s?.status === "complete" ? s : fin?.status === "complete" ? fin : s;
    if (!target || target.status === "absent") { unmet.push({ condition: r.id, reason: "absent" }); continue; }
    if (target.status !== "complete") { unmet.push({ condition: r.id, reason: "not_complete" }); continue; }
    if (target.source_refs.some((x) => x.version !== x.current_version)) { unmet.push({ condition: r.id, reason: "stale_source" }); continue; }
    for (const c of content.filter((x) => x.document_id === r.document_id && x.source_exists_before === target.stage)) {
      if (!target.source_refs.some((x) => x.record_kind === c.source.record_kind && x.version >= 1)) unmet.push({ condition: r.id, reason: "content_rule" });
    }
  }
  return { case_id: caseId, pass: unmet.length === 0, required: req.map((r) => r.id), unmet };
}

// Builds the record state from a definition-executor run, so sim runs go through the same verifier.
export function recordStateFromRun(run: RunResult, def: WorkflowDefinition, manifest: Manifest, requirementVersion = manifest.requirement_version): RecordState | null {
  if (run.outcome !== "ok") return null;
  const trace = new Trace(run, def);
  const last = trace.events.at(-1)?.seq ?? 0;
  const stages: StageRecord[] = def.steps.filter(isPreparingStep).map((s) => {
    const kinds = boundRecordKinds(def, s);
    const captured = trace.capturedAt(s.step_id, last);
    const current = trace.versionsAt(last, kinds);
    const done = trace.completion(s.step_id) !== undefined;
    const handover = def.steps.find((h) => h.action_kind === "hand_over_document" && h.document_ref?.document_id === s.document_ref!.document_id && h.document_ref.stage === s.document_ref!.stage);
    return {
      document_id: s.document_ref!.document_id, stage: s.document_ref!.stage,
      status: done ? "complete" : captured ? "pending" : "absent",
      version: 1 + trace.ofStep(s.step_id, "document.revised").length,
      source_refs: captured ? kinds.map((k) => ({ record_kind: k, version: captured[k] ?? 0, current_version: current[k] ?? 0 })) : [],
      handed_over: handover !== undefined && trace.completion(handover.step_id) !== undefined
    };
  });
  return { case_id: run.case_id, ward_id: manifest.ward_id, requirement_version: requirementVersion, facts: finalFacts(run), stages };
}

type Cell = "done_pass" | "done_fail" | "needs_input_pass" | "needs_input_fail";
export type CompletionRow = {
  task_id: string; case_id: string; agent_state: TaskState; verdict: Verdict; cell: Cell | null;
  premature: { action: number; task: number }; retries: number;
};
export type CompletionSummary = {
  runs: number;
  matrix: Record<Cell, number>;
  off_diagonal: number;
  false_done: number;
  premature_attempts: number;
  premature_by_target: { action: number; task: number };
  premature_attempts_counted: boolean;
  states: Record<TaskState, number>;
  retrying: { events: number; tasks: number };
  rows: CompletionRow[];
};

// The state the agent ended in, from its own transitions; a task that never moved is still running.
export function claimedState(events: readonly RuntimeEvent[]): TaskState {
  let state: TaskState = "running";
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.record_type !== "task.state_changed") continue;
    const to = TaskState.safeParse((e.payload as { to?: unknown } | null)?.to);
    if (to.success) state = to.data;
  }
  return state;
}

// The 2x2 agreement matrix over every run, plus premature completion attempts, with waiting, retrying, cancelled and needs_input kept apart.
export function completionMatrix(tasks: TaskStreamReader, records: RecordStateReader, defFor: (caseId: string) => WorkflowDefinition): CompletionSummary {
  const matrix: Record<Cell, number> = { done_pass: 0, done_fail: 0, needs_input_pass: 0, needs_input_fail: 0 };
  const states = Object.fromEntries(TaskState.options.map((s) => [s, 0])) as Record<TaskState, number>;
  const rows: CompletionRow[] = [];
  const prem = { action: 0, task: 0 };
  let retryEvents = 0, retryTasks = 0;
  for (const id of tasks.taskIds()) {
    const caseId = tasks.caseOf(id);
    const events = tasks.events(id);
    const agent = claimedState(events);
    const verdict = verifyCompletion(defFor(caseId), records.recordState(caseId), caseId);
    states[agent] += 1;
    const cell: Cell | null = agent === "done" ? (verdict.pass ? "done_pass" : "done_fail") : agent === "needs_input" ? (verdict.pass ? "needs_input_pass" : "needs_input_fail") : null;
    if (cell) matrix[cell] += 1;
    const p = { action: 0, task: 0 };
    for (const e of events.filter((x) => x.record_type === "completion.attempt_refused")) {
      if ((e.payload as { target?: unknown } | null)?.target === "task") p.task += 1; else p.action += 1;
    }
    const retries = events.filter((x) => x.record_type === "action.retry").length;
    prem.action += p.action; prem.task += p.task;
    retryEvents += retries; if (retries > 0) retryTasks += 1;
    rows.push({ task_id: id, case_id: caseId, agent_state: agent, verdict, cell, premature: p, retries });
  }
  return {
    runs: rows.length, matrix, off_diagonal: matrix.done_fail + matrix.needs_input_pass, false_done: matrix.done_fail,
    premature_attempts: prem.action + prem.task, premature_by_target: prem, premature_attempts_counted: true,
    states, retrying: { events: retryEvents, tasks: retryTasks }, rows
  };
}
