import { AgentTask, Proof, type ActionKind, type Envelope, type Proof as ProofT, type StoreRef, type TaskState, type Wake } from "@hey-pisgah/contracts";
import { STORE_RECORD_TYPES, type Stream } from "@hey-pisgah/store";

export type Condition = { condition_id: string; description: string; record_id: string; step_id: string };
export type ActionRec = {
  action_id: string; action_kind: ActionKind; args: Record<string, unknown>; args_hash: string; intent_key: string;
  tool_call_id: string; model_response_id: string | null; tick_id: string;
  state: "intended" | "written" | "completed" | "refused" | "retrying" | "failed";
  retries: number; written: { record_id: string; target_record_id: string; event_id: string; effect_at: number; base_version: number | null; reconciled: boolean } | null;
  proof: ProofT | null; refusal: string | null;
};
export type WakeRec = Wake & { tick_id: string; after: { minute: number; port_writes: number } };
export type TurnRec = { response_id: string | null; content: string | null; tool_calls: { id: string; name: string; arguments: string }[]; ledger: StoreRef | null };
export type TickRec = {
  tick_id: string; now: number; user: string; reason: TickReason; turns: TurnRec[]; results: Map<string, string>; ended: string | null; nudge: boolean;
};
export type TickReason =
  | { kind: "opened" }
  | { kind: "resumed"; wake_id: string; trigger: string }
  | { kind: "input"; text: string }
  | { kind: "nudge"; ready: string[] }
  | { kind: "recover" };

export type Projection = {
  task_id: string; owner: string; case_id: string; goal: string; workflow_version: number; run_id: string;
  budget: { max_calls: number; max_usd: number; calls_used: number; usd_used: number };
  created: { occurred_at: number; recorded_at: number; wall_at: string }; updated: { occurred_at: number; recorded_at: number; wall_at: string };
  state: TaskState; reason: string | null; unmet: string[];
  conditions: Condition[]; actions: Map<string, ActionRec>; order: string[];
  wakes: WakeRec[]; resumed: Set<string>;
  cursor: { world_seq: number; now: number };
  ticks: TickRec[];
  counts: { agent_refused: number; completion_refused: number; retries: number; model_calls: number; tool_invalid: number };
  last_resume: { wake_id: string; trigger: string } | null;
  // The reason the next tick must use, set by open, resume, input or a nudge decision and cleared when a tick starts.
  pending_reason: TickReason | null;
  closed: Record<string, unknown> | null;
  head_seq: number;
  // The version monitor's record for this task: failed checks, what they block, and the proposals they raised for a person.
  monitor: {
    checks_failed: number;
    blocked: Map<string, { record_id: string; document_id: string; stage: string; check: "commit" | "outcome"; status: string; seq: number }>;
    reported: Set<string>;
    proposals: { proposal_id: string; kind: "suspension" | "revision"; version: number; seq: number }[];
  };
};

export const TERMINAL: ReadonlySet<TaskState> = new Set(["done", "failed", "cancelled"]);
// States in which the runtime does nothing until a person acts.
export const SETTLED: ReadonlySet<TaskState> = new Set(["done", "failed", "cancelled", "needs_input", "paused"]);

type P = Record<string, unknown>;

// Folds one envelope into the projection; the task stream is the only source of task state.
export function apply(p: Projection | null, e: Envelope): Projection | null {
  if (STORE_RECORD_TYPES.includes(e.record_type)) { if (p) p.head_seq = e.seq; return p; }
  const x = e.payload as P;
  const clocks = { occurred_at: e.occurred_at, recorded_at: e.recorded_at, wall_at: e.wall_at };
  if (e.record_type === "task.opened") {
    return {
      task_id: String(x["task_id"]), owner: String(x["owner"]), case_id: String(x["case_id"]), goal: String(x["goal"]), workflow_version: Number(x["workflow_version"]),
      run_id: String(x["run_id"]), budget: { ...(x["budget"] as { max_calls: number; max_usd: number }), calls_used: 0, usd_used: 0 },
      created: clocks, updated: clocks, state: "running", reason: null, unmet: [], conditions: [], actions: new Map(), order: [], wakes: [], resumed: new Set(),
      cursor: { world_seq: 0, now: e.recorded_at }, ticks: [], counts: { agent_refused: 0, completion_refused: 0, retries: 0, model_calls: 0, tool_invalid: 0 },
      last_resume: null, pending_reason: { kind: "opened" }, closed: null, head_seq: e.seq,
      monitor: { checks_failed: 0, blocked: new Map(), reported: new Set(), proposals: [] }
    };
  }
  if (!p) throw new Error(`task stream starts with ${e.record_type}, not task.opened`);
  p.head_seq = e.seq;
  p.updated = clocks;
  const tick = p.ticks.at(-1);
  const act = (id: unknown) => p.actions.get(String(id));
  switch (e.record_type) {
    case "acceptance.derived": p.conditions = x["conditions"] as Condition[]; break;
    case "tick.started":
      p.ticks.push({ tick_id: String(x["tick_id"]), now: Number(x["now"]), user: String(x["user"]), reason: x["reason"] as TickReason, turns: [], results: new Map(), ended: null, nudge: (x["reason"] as TickReason).kind === "nudge" });
      p.pending_reason = null;
      break;
    case "model.turn":
      tick?.turns.push({ response_id: (x["response_id"] as string | null) ?? null, content: (x["content"] as string | null) ?? null, tool_calls: x["tool_calls"] as TurnRec["tool_calls"], ledger: (x["ledger"] as StoreRef | null) ?? null });
      p.counts.model_calls += 1;
      p.budget.calls_used += 1;
      p.budget.usd_used += Number(x["cost_usd"] ?? 0);
      break;
    case "tool.result": tick?.results.set(`${Number(x["turn"])}:${Number(x["index"])}`, String(x["content"])); if (x["invalid"] === true) p.counts.tool_invalid += 1; break;
    case "tick.ended": if (tick) tick.ended = String(x["outcome"]); if (x["next"]) p.pending_reason = x["next"] as TickReason; break;
    case "action.intent":
      p.actions.set(String(x["action_id"]), {
        action_id: String(x["action_id"]), action_kind: x["action_kind"] as ActionKind, args: x["args"] as Record<string, unknown>, args_hash: String(x["args_hash"]),
        intent_key: String(x["intent_key"]), tool_call_id: String(x["tool_call_id"]), model_response_id: (x["model_response_id"] as string | null) ?? null,
        tick_id: String(x["tick_id"]), state: "intended", retries: 0, written: null, proof: null, refusal: null
      });
      p.order.push(String(x["action_id"]));
      break;
    case "action.retry": { const a = act(x["action_id"]); if (a) { a.retries += 1; a.state = "retrying"; } p.counts.retries += 1; break; }
    case "action.written": { const a = act(x["action_id"]); if (a) { a.state = "written"; a.written = x["written"] as ActionRec["written"]; } break; }
    case "action.refused": { const a = act(x["action_id"]); if (a) { a.state = "refused"; a.refusal = String(x["reason"]); } break; }
    case "action.failed": { const a = act(x["action_id"]); if (a) { a.state = "failed"; a.refusal = String(x["reason"]); } break; }
    case "action.completed": case "proof.refreshed": { const a = act(x["action_id"]); if (a) { a.state = "completed"; a.proof = x["proof"] as ProofT; } break; }
    case "agent.refused": p.counts.agent_refused += 1; break;
    case "completion.attempt_refused": p.counts.completion_refused += 1; break;
    case "wake.registered": p.wakes.push({ ...(x["wake"] as Wake), tick_id: String(x["tick_id"]), after: x["after"] as WakeRec["after"] }); break;
    case "task.resumed": {
      if (tick && tick.ended === null) tick.ended = "interrupted";
      const id = String(x["wake_id"]);
      p.resumed.add(id);
      for (const w of p.wakes) if (w.consumed_by === null) w.consumed_by = w.wake_id === id ? String(x["trigger"]) : "superseded";
      p.state = "running"; p.reason = null; p.unmet = [];
      p.last_resume = { wake_id: id, trigger: String(x["trigger"]) };
      p.pending_reason = { kind: "resumed", wake_id: id, trigger: String(x["trigger"]) };
      p.cursor = { world_seq: Number(x["world_seq"]), now: Number(x["now"]) };
      break;
    }
    case "resumer.cursor": p.cursor = { world_seq: Number(x["world_seq"]), now: Number(x["now"]) }; break;
    case "task.state_changed":
      p.state = x["to"] as TaskState; p.reason = (x["reason"] as string | null) ?? null; p.unmet = (x["unmet"] as string[] | undefined) ?? [];
      if (p.state !== "waiting") for (const w of p.wakes) if (w.consumed_by === null) w.consumed_by = "superseded";
      break;
    case "person.input": if (tick && tick.ended === null) tick.ended = "interrupted"; p.pending_reason = { kind: "input", text: String(x["text"]) }; break;
    case "run.closed": p.closed = x; break;
    case "version.check_failed": {
      const a = x["action"] as { record_id: string; document_id: string; stage: string };
      p.monitor.checks_failed += 1;
      p.monitor.reported.add(String(x["report_key"]));
      p.monitor.blocked.set(a.record_id, { record_id: a.record_id, document_id: a.document_id, stage: a.stage, check: x["check"] as "commit" | "outcome", status: String(x["status"]), seq: e.seq });
      break;
    }
    case "version.check_cleared": p.monitor.blocked.delete(String(x["record_id"])); break;
    case "version.suspension_proposed": case "version.revision_proposed":
      p.monitor.reported.add(String(x["report_key"]));
      p.monitor.proposals.push({ proposal_id: String(x["proposal_id"]), kind: e.record_type === "version.suspension_proposed" ? "suspension" : "revision", version: Number(x["version"]), seq: e.seq });
      break;
    default: break;
  }
  return p;
}

export function project(records: readonly Envelope[]): Projection {
  let p: Projection | null = null;
  for (const e of records) p = apply(p, e);
  if (!p) throw new Error("empty task stream");
  return p;
}

export const openWakes = (p: Projection): WakeRec[] => p.wakes.filter((w) => w.consumed_by === null);
export const openTick = (p: Projection): TickRec | null => { const t = p.ticks.at(-1); return t && t.ended === null ? t : null; };

// The contract view of the task; parsing it enforces "done only with a proof per condition" once more.
export function toAgentTask(p: Projection): AgentTask {
  return AgentTask.parse({
    task_id: p.task_id, owner: p.owner, case_id: p.case_id, goal: p.goal,
    acceptance_conditions: p.conditions.map((c) => ({ condition_id: c.condition_id, description: c.description, proof_action_id: proofActionFor(p, c) })),
    workflow_version: p.workflow_version, state: p.state,
    actions: p.order.map((id) => p.actions.get(id)!).map((a) => ({ action_id: a.action_id, action_kind: a.action_kind, args_hash: a.args_hash, intent_key: a.intent_key, state: a.state, proof: a.proof, decided_by: "model" as const })),
    wakes: p.wakes.map(({ tick_id: _t, after: _a, ...w }) => w),
    budget: p.budget, created: p.created, updated: p.updated
  });
}

// The latest completed action whose proof names this condition's record, or null.
export function proofActionFor(p: Projection, c: Condition): string | null {
  const ids = p.order.filter((id) => { const a = p.actions.get(id)!; return a.state === "completed" && a.proof?.record_id === c.record_id; });
  return ids.at(-1) ?? null;
}

export class TickConflict extends Error {
  readonly code = "tick_conflict";
}

// Writes one task's stream; an append commits only if the head is still where this writer last saw it.
export class TaskWriter {
  private expected: number;
  constructor(readonly stream: Stream, public proj: Projection) {
    this.expected = stream.head().seq;
  }
  append(type: string, payload: unknown, minute: number): Envelope {
    if (this.stream.head().seq !== this.expected) throw new TickConflict(`head moved from ${this.expected} to ${this.stream.head().seq}`);
    const env = this.stream.append(type, payload, { recorded_at: minute, occurred_at: minute });
    this.expected = env.seq;
    apply(this.proj, env);
    return env;
  }
}

export type CompletionGuard = { ok: true; proof: ProofT } | { ok: false; reason: string };

// The state machine's completion guard: an action enters completed only with a proof that parses and names its own intent.
export function guardCompletion(a: Pick<ActionRec, "intent_key" | "written">, proof: unknown): CompletionGuard {
  if (proof === null || proof === undefined) return { ok: false, reason: "no_proof" };
  const r = Proof.safeParse(proof);
  if (!r.success) return { ok: false, reason: "proof_invalid" };
  if (r.data.intent_key !== a.intent_key) return { ok: false, reason: "proof_for_another_intent" };
  if (a.written === null) return { ok: false, reason: "not_written" };
  if (r.data.record_id !== a.written.target_record_id) return { ok: false, reason: "proof_for_another_record" };
  return { ok: true, proof: r.data };
}

