import { documentLabel, humanize } from "./labels.js";
import type { Env } from "./paths.js";

export const TASK_STATES = ["running", "waiting", "needs_input", "paused", "cancelled", "failed", "done"] as const;
export type TaskState = (typeof TASK_STATES)[number];
// The runtime has seven task states; retrying is shown on a running task while one of its writes is being retried.
export const DISPLAY_STATES = [...TASK_STATES, "retrying"] as const;
export type DisplayState = (typeof DISPLAY_STATES)[number];
export const ACTION_STATES = ["intended", "written", "completed", "refused", "retrying", "failed"] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export type ProofView = {
  record_id: string; record_version: number; record_hash: string; produced_event_ids: string[];
  source_refs: { record_id: string; version: number }[]; tool_call_ids: string[]; model_response_id: string | null; verified_at: number | null;
};
export type ActionView = {
  action_id: string; kind: string; label: string; detail: string | null; document: { id: string; stage: string | null } | null;
  at: number; seq: number; state: ActionState; refusal: string | null; refusal_detail: string[]; retries: number;
  written: { record_id: string; event_id: string; effect_at: number } | null; proof: ProofView | null;
};
export type Resume = { wake_id: string; trigger: string; label: string };
export type Period = { kind: TaskState; from: number; to: number; from_seq: number; to_seq: number; calls: number; ticks: number; reason: string | null; resume: Resume | null; open: boolean };
export type Condition = { condition_id: string; description: string; met: boolean };
export type TaskView = {
  task_id: string; case_id: string; owner: string; goal: string; workflow_version: number; requirement_version: string | null; run_id: string;
  state: TaskState; reason: string | null; unmet: string[]; opened_at: number; updated_at: number;
  conditions: Condition[]; actions: ActionView[]; periods: Period[];
  counts: { model_calls: number; agent_refused: number; completion_refused: number; retries: number; tool_invalid: number };
  effect_set_hash: string | null;
};

type P = Record<string, unknown>;
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

// Names what a wake waits for, in words a ward reader follows.
export function wakeLabel(predicate: unknown, labels: ReadonlyMap<string, string>): string {
  const p = (predicate ?? {}) as P;
  if (Array.isArray(p["any_of"])) return (p["any_of"] as unknown[]).map((x) => wakeLabel(x, labels)).join(", or ");
  const on = str(p["on"]);
  const where = (p["where"] ?? {}) as P;
  const step = str(where["step_id"]);
  if (on === "step.completed" && step) return `${labels.get(step) ?? step} recorded`;
  if (on === "step.completed") return "next step recorded";
  if (on === "requirements.changed") return "ward requirements changed";
  if (on === "record.versioned") return "record updated";
  return on ? humanize(on) : "recorded event";
}

function actionLabel(kind: string, args: P): { label: string; detail: string | null; document: ActionView["document"] } {
  if (kind === "prepare_document") {
    const id = str(args["document_id"]);
    const stage = str(args["stage"]) || null;
    return { label: `Prepare ${documentLabel(id, stage).toLowerCase()}`, detail: null, document: { id, stage } };
  }
  if (kind === "ask_staff") return { label: `Ask the ${humanize(str(args["role"])).toLowerCase()}`, detail: str(args["question"]) || null, document: null };
  if (kind === "raise_workflow_conflict") return { label: "Raise a workflow conflict", detail: str(args["explanation"]) || null, document: null };
  return { label: humanize(kind), detail: null, document: null };
}

function refusalDetail(detail: unknown, labels: ReadonlyMap<string, string>): string[] {
  const d = (detail ?? {}) as P;
  const w = Array.isArray(d["waiting_for"]) ? (d["waiting_for"] as P[]) : [];
  return w.map((x) => {
    const kind = humanize(str(x["kind"])).toLowerCase();
    const step = str(x["step_id"]) || str(((x["when"] ?? {}) as P)["after"] && (((x["when"] as P)["after"] as P)["step"]));
    return step ? `${kind}: waits for ${labels.get(step) ?? step}` : kind;
  });
}

function proofOf(v: unknown): ProofView | null {
  if (!v || typeof v !== "object") return null;
  const p = v as P;
  const at = (p["verified_at"] ?? null) as P | null;
  return {
    record_id: str(p["record_id"]), record_version: num(p["record_version"]), record_hash: str(p["record_hash"]),
    produced_event_ids: (p["produced_event_ids"] as string[] | undefined) ?? [], source_refs: (p["source_refs"] as ProofView["source_refs"] | undefined) ?? [],
    tool_call_ids: (p["tool_call_ids"] as string[] | undefined) ?? [], model_response_id: (p["model_response_id"] as string | null | undefined) ?? null,
    verified_at: at ? num(at["occurred_at"]) : null
  };
}

// Folds a task stream into the view the task page renders; the runtime's own projection stays the source of task state.
export function foldTask(records: readonly Env[], labels: ReadonlyMap<string, string>): TaskView {
  const first = records.find((e) => e.record_type === "task.opened");
  if (!first) throw new Error("task stream has no task.opened record");
  const o = first.payload;
  const v: TaskView = {
    task_id: str(o["task_id"]), case_id: str(o["case_id"]), owner: str(o["owner"]), goal: str(o["goal"]), workflow_version: num(o["workflow_version"]),
    requirement_version: (o["requirement_version"] as string | undefined) ?? null, run_id: str(o["run_id"]),
    state: "running", reason: null, unmet: [], opened_at: first.occurred_at, updated_at: first.occurred_at, conditions: [], actions: [], periods: [],
    counts: { model_calls: 0, agent_refused: 0, completion_refused: 0, retries: 0, tool_invalid: 0 }, effect_set_hash: null
  };
  const acts = new Map<string, ActionView>();
  const wakes = new Map<string, unknown>();
  let cur: Period = { kind: "running", from: first.occurred_at, to: first.occurred_at, from_seq: first.seq, to_seq: first.seq, calls: 0, ticks: 0, reason: null, resume: null, open: true };
  const turnTo = (kind: TaskState, e: Env, reason: string | null) => {
    cur.to = e.occurred_at; cur.to_seq = e.seq; cur.open = false;
    v.periods.push(cur);
    cur = { kind, from: e.occurred_at, to: e.occurred_at, from_seq: e.seq, to_seq: e.seq, calls: 0, ticks: 0, reason, resume: null, open: true };
  };
  for (const e of records) {
    const x = e.payload;
    v.updated_at = Math.max(v.updated_at, e.occurred_at);
    cur.to = e.occurred_at; cur.to_seq = e.seq;
    switch (e.record_type) {
      case "acceptance.derived":
        v.conditions = ((x["conditions"] as P[] | undefined) ?? []).map((c) => ({ condition_id: str(c["condition_id"]), description: str(c["description"]), met: false }));
        break;
      case "tick.started": cur.ticks += 1; break;
      case "model.turn": cur.calls += 1; v.counts.model_calls += 1; break;
      case "tool.result": if (x["invalid"] === true) v.counts.tool_invalid += 1; break;
      case "action.intent": {
        const kind = str(x["action_kind"]);
        const l = actionLabel(kind, (x["args"] ?? {}) as P);
        const a: ActionView = { action_id: str(x["action_id"]), kind, ...l, at: e.occurred_at, seq: e.seq, state: "intended", refusal: null, refusal_detail: [], retries: 0, written: null, proof: null };
        acts.set(a.action_id, a);
        v.actions.push(a);
        break;
      }
      case "action.written": {
        const a = acts.get(str(x["action_id"]));
        const w = (x["written"] ?? {}) as P;
        if (a) { a.state = "written"; a.written = { record_id: str(w["record_id"]), event_id: str(w["event_id"]), effect_at: num(w["effect_at"]) }; }
        break;
      }
      case "action.retry": { const a = acts.get(str(x["action_id"])); if (a) { a.state = "retrying"; a.retries += 1; } v.counts.retries += 1; break; }
      case "action.refused": { const a = acts.get(str(x["action_id"])); if (a) { a.state = "refused"; a.refusal = str(x["reason"]); a.refusal_detail = refusalDetail(x["detail"], labels); } break; }
      case "action.failed": { const a = acts.get(str(x["action_id"])); if (a) { a.state = "failed"; a.refusal = str(x["reason"]); } break; }
      case "action.completed": case "proof.refreshed": { const a = acts.get(str(x["action_id"])); if (a) { a.state = "completed"; a.proof = proofOf(x["proof"]); } break; }
      case "agent.refused": v.counts.agent_refused += 1; break;
      case "completion.attempt_refused": v.counts.completion_refused += 1; break;
      case "wake.registered": { const w = (x["wake"] ?? {}) as P; wakes.set(str(w["wake_id"]), w["predicate"]); break; }
      case "task.resumed": {
        const id = str(x["wake_id"]);
        cur.resume = { wake_id: id, trigger: str(x["trigger"]), label: wakeLabel(wakes.get(id), labels) };
        turnTo("running", e, null);
        v.state = "running"; v.reason = null; v.unmet = [];
        break;
      }
      case "task.state_changed": {
        const to = str(x["to"]) as TaskState;
        if (to !== cur.kind) turnTo(to, e, (x["reason"] as string | null | undefined) ?? null);
        v.state = to; v.reason = (x["reason"] as string | null | undefined) ?? null; v.unmet = (x["unmet"] as string[] | undefined) ?? [];
        break;
      }
      case "run.closed": v.effect_set_hash = (x["effect_set_hash"] as string | undefined) ?? null; break;
      default: break;
    }
  }
  cur.open = !["done", "failed", "cancelled"].includes(cur.kind);
  v.periods.push(cur);
  const done = new Set(v.actions.filter((a) => a.state === "completed" && a.document).map((a) => `${a.document!.id}.${a.document!.stage ?? ""}`));
  for (const c of v.conditions) c.met = done.has(c.condition_id) && !v.unmet.includes(c.condition_id);
  return v;
}

export const STATE_TEXT: Record<DisplayState, string> = {
  running: "Working", waiting: "Waiting on the ward", needs_input: "Needs a person", paused: "Paused", retrying: "Retrying a write",
  cancelled: "Cancelled", failed: "Failed", done: "Done"
};
export const ACTION_TEXT: Record<ActionState, string> = {
  intended: "Intended", written: "Written, proof pending", completed: "Proved", refused: "Refused", retrying: "Retrying", failed: "Failed"
};

export function displayState(v: Pick<TaskView, "state" | "actions">): DisplayState {
  return v.state === "running" && v.actions.some((a) => a.state === "retrying") ? "retrying" : v.state;
}
