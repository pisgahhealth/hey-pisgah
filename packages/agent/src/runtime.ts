import { canonical, hashJson, sha256, type EventPredicate, type Proof, type Wake } from "@hey-pisgah/contracts";
import { ModelError, ROUTES, type ChatMessage, type EffortLevel, type ModelClient, type ProviderId } from "@hey-pisgah/model";
import { listStreams, openStream, type Stream } from "@hey-pisgah/store";
import type { WorldRules } from "@hey-pisgah/simulator";
import type { Registry } from "@hey-pisgah/workflow";
import { REQUIREMENTS_WAKE, conditionStatuses, conditionsHash, deriveConditions, deriveWakeLeaves, type ConditionStatus } from "./acceptance.js";
import { shortHash } from "./ids.js";
import { HospitalPort, type RecordView } from "./port.js";
import { SYSTEM_PROMPT, toolDefs, userMessage } from "./prompt.js";
import { ARGS, isWriteTool, type ToolName } from "./schemas.js";
import {
  SETTLED, TaskWriter, TickConflict, guardCompletion, openTick, openWakes, project, toAgentTask,
  type ActionRec, type Projection, type TickReason, type TickRec, type TurnRec
} from "./task.js";
import { firstFiring, type Firing } from "./wakes.js";
import { requirementsAt, type CaseWorld } from "./world.js";

export type Boundary = "after_turn" | "after_intent" | "after_port_write" | "after_written" | "after_completed" | "after_wake_registered" | "after_waiting" | "after_resumed";

export type RuntimeOptions = {
  storeRoot: string;
  client: ModelClient;
  cases: ReadonlyMap<string, CaseWorld>;
  registry: Registry;
  // The hospital's world-decided service times; null runs the bare definition executor.
  world: WorldRules | null;
  provider?: ProviderId;
  model?: string;
  effort?: EffortLevel;
  pollMs?: number;
  clock?: "auto" | "manual";
  maxTurnsPerTick?: number;
  globalCap?: number;
  defaultBudget?: { max_calls: number; max_usd: number };
  // Called at every action and wake boundary; crash tests kill the process here.
  boundary?: (b: Boundary, info: { task_id: string; action_id?: string }) => void;
  wallNow?: () => Date;
  log?: (line: string) => void;
};

type Live = { id: string; stream: Stream; port: HospitalPort; queue: Promise<void>; queued: number; cache: { seq: number; proj: Projection } | null };
type ToolOutcome = { content: string; invalid: boolean; ok: boolean };
type LoopOutcome = "model_ended" | "control" | "turn_cap" | "invalid_tool_calls" | "budget" | "provider_error";

// Tool results are canonical JSON, so a reloaded record and a live one render to the same bytes.
const json = (v: unknown) => canonical(JSON.parse(JSON.stringify(v)));
const intentKey = (taskId: string, actionId: string, args: unknown) => sha256(canonical([taskId, actionId, args]));

// The personal agent runtime: durable tasks, journaled writes, proofs, wakes and the resumer, one serial queue per task.
export class AgentRuntime {
  private readonly tasks = new Map<string, Live>();
  private readonly ports = new Map<string, HospitalPort>();
  private readonly sizes = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private slots = 0;
  private readonly waiters: (() => void)[] = [];
  private refusedResumes = 0;
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort: EffortLevel;

  constructor(private readonly o: RuntimeOptions) {
    this.provider = o.provider ?? "modal";
    this.model = o.model ?? ROUTES[this.provider].models[0]!;
    this.effort = o.effort ?? "low";
  }

  private get pollMs() { return this.o.pollMs ?? 250; }
  private wall(): string { return (this.o.wallNow?.() ?? new Date()).toISOString(); }
  private log(s: string) { this.o.log?.(s); }
  private boundary(b: Boundary, info: { task_id: string; action_id?: string }) { this.o.boundary?.(b, info); }

  portFor(caseId: string): HospitalPort {
    let p = this.ports.get(caseId);
    if (!p) {
      const world = this.o.cases.get(caseId);
      if (!world) throw new Error(`unknown case ${caseId}`);
      p = HospitalPort.open(this.o.storeRoot, world, this.o.registry, this.o.world);
      this.ports.set(caseId, p);
    }
    return p;
  }

  // The task projection, rebuilt from the stream whenever its head moved; it never calls the model.
  projection(id: string): Projection {
    const live = this.tasks.get(id);
    if (!live) throw new Error(`unknown task ${id}`);
    const seq = live.stream.head().seq;
    if (!live.cache || live.cache.seq !== seq) live.cache = { seq, proj: project(live.stream.records()) };
    return live.cache.proj;
  }
  taskIds(): string[] { return [...this.tasks.keys()].sort(); }
  stateOf = (id: string) => (this.tasks.has(id) ? this.projection(id).state : null);
  private writer(id: string): TaskWriter {
    const live = this.tasks.get(id)!;
    return new TaskWriter(live.stream, project(live.stream.records()));
  }

  // Rebuilds every task from its stream, re-registers open wakes through the resumer and continues interrupted ticks.
  start(): void {
    for (const sid of listStreams(this.o.storeRoot, "tasks")) {
      const id = sid.slice("tasks/".length);
      if (this.tasks.has(id)) continue;
      const stream = openStream(this.o.storeRoot, sid, { writer: true });
      const p = project(stream.records());
      const live: Live = { id, stream, port: this.portFor(p.case_id), queue: Promise.resolve(), queued: 0, cache: null };
      this.tasks.set(id, live);
      if (p.state === "running") this.enqueue(id, p.pending_reason ?? { kind: "recover" });
    }
    if (!this.timer) this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.tasks.values()].map((l) => l.queue));
    for (const l of this.tasks.values()) l.stream.close();
    for (const p of this.ports.values()) p.close();
    this.tasks.clear();
    this.ports.clear();
  }

  openTask(req: { case_id: string; goal: string; owner: string; budget?: { max_calls: number; max_usd: number } }): string {
    const port = this.portFor(req.case_id);
    const n = listStreams(this.o.storeRoot, "tasks").length;
    const id = `t-${shortHash(req.case_id, req.owner, req.goal, n)}`;
    const stream = openStream(this.o.storeRoot, `tasks/${id}`, { writer: true });
    const now = port.now();
    const budget = req.budget ?? this.o.defaultBudget ?? { max_calls: 60, max_usd: 1 };
    stream.append("task.opened", {
      task_id: id, owner: req.owner, case_id: req.case_id, goal: req.goal.slice(0, 500), workflow_version: port.def.version, run_id: `run-${shortHash(id, "run")}`,
      budget, requirement_version: requirementsAt(port.world, now).set.requirement_version, engine_run_id: port.engineRunId
    }, { recorded_at: now, occurred_at: now });
    const live: Live = { id, stream, port, queue: Promise.resolve(), queued: 0, cache: null };
    this.tasks.set(id, live);
    const w = this.writer(id);
    w.append("acceptance.derived", { conditions: deriveConditions(port), requirement_version: requirementsAt(port.world, now).set.requirement_version }, now);
    this.enqueue(id, { kind: "opened" });
    return id;
  }

  private enqueue(id: string, reason: TickReason): void {
    const live = this.tasks.get(id)!;
    live.queued += 1;
    live.queue = live.queue
      .then(() => this.withSlot(() => this.tick(id, reason)))
      .catch((e: unknown) => this.fail(id, e))
      .finally(() => { live.queued -= 1; });
  }
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    const cap = this.o.globalCap ?? 2;
    while (this.slots >= cap) await new Promise<void>((r) => this.waiters.push(r));
    this.slots += 1;
    try { return await fn(); } finally { this.slots -= 1; this.waiters.shift()?.(); }
  }
  private fail(id: string, e: unknown): void {
    if (e instanceof TickConflict) { this.log(`tick conflict on ${id}: ${e.message}`); return; }
    const msg = e instanceof Error ? e.message : String(e);
    this.log(`task ${id} failed: ${msg}`);
    try {
      const w = this.writer(id);
      if (!SETTLED.has(w.proj.state)) w.append("task.state_changed", { from: w.proj.state, to: "failed", reason: `runtime_error: ${msg.slice(0, 200)}` }, this.tasks.get(id)!.port.now());
    } catch { /* the stream may be closed during shutdown */ }
  }

  // One tick: the model loop and then the runtime's own evaluation, all against one stream head.
  private async tick(id: string, reason: TickReason): Promise<void> {
    const live = this.tasks.get(id);
    if (!live) return;
    const w = this.writer(id);
    if (w.proj.state !== "running") return;
    const port = live.port;
    if (!openTick(w.proj)) {
      this.refreshProofs(w, port);
      const r = w.proj.pending_reason ?? reason;
      const since = w.proj.ticks.at(-1)?.now ?? w.proj.created.recorded_at;
      const statuses = this.statuses(w.proj, port);
      const tickId = `k-${shortHash(id, w.proj.ticks.length + 1)}`;
      w.append("tick.started", { tick_id: tickId, now: port.now(), reason: r, user: userMessage(w.proj, port, r, statuses, since) }, port.now());
    }
    const outcome = await this.loop(w, port);
    this.evaluate(w, port, outcome);
  }

  private messages(t: TickRec): ChatMessage[] {
    const m: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: t.user }];
    t.turns.forEach((turn, i) => {
      m.push(turn.tool_calls.length
        ? { role: "assistant", content: turn.content, tool_calls: turn.tool_calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) }
        : { role: "assistant", content: turn.content ?? "" });
      turn.tool_calls.forEach((c, j) => {
        const r = t.results.get(`${i}:${j}`);
        if (r !== undefined) m.push({ role: "tool", tool_call_id: c.id, content: r });
      });
    });
    return m;
  }

  private async loop(w: TaskWriter, port: HospitalPort): Promise<LoopOutcome> {
    const max = this.o.maxTurnsPerTick ?? 12;
    for (;;) {
      const t = openTick(w.proj)!;
      const ti = t.turns.length - 1;
      const last = t.turns[ti];
      if (last) {
        for (let j = 0; j < last.tool_calls.length; j++) {
          if (t.results.has(`${ti}:${j}`)) continue;
          const r = await this.dispatch(w, port, t, ti, j, last);
          w.append("tool.result", { tick_id: t.tick_id, turn: ti, index: j, tool_call_id: last.tool_calls[j]!.id, name: last.tool_calls[j]!.name, content: r.content, invalid: r.invalid }, port.now());
        }
        if (last.tool_calls.length === 0) return "model_ended";
        const tt = openTick(w.proj)!;
        if (last.tool_calls.some((c, j) => (c.name === "wait_until" || c.name === "finish_task") && (JSON.parse(tt.results.get(`${ti}:${j}`) ?? "{}") as { ok?: boolean }).ok === true)) return "control";
        if (this.invalidStreak(tt) >= 3) return "invalid_tool_calls";
      }
      if (t.turns.length >= max) return "turn_cap";
      const p = w.proj;
      if (p.budget.calls_used >= p.budget.max_calls || p.budget.usd_used >= p.budget.max_usd) {
        w.append("task.state_changed", { from: "running", to: "paused", reason: "task_budget_exhausted" }, port.now());
        return "budget";
      }
      let res;
      try {
        res = await this.o.client.call({
          provider: this.provider, model: this.model, effort: this.effort, messages: this.messages(t), tools: toolDefs(), parallel_tool_calls: false,
          purpose: "agent.execute", run_id: p.run_id, task_id: p.task_id, task_state: p.state, thread: "main", affinity_key: p.task_id
        });
      } catch (e) {
        if (!(e instanceof ModelError)) throw e;
        const to = "paused";
        w.append("task.state_changed", { from: "running", to, reason: `model_${e.code}` }, port.now());
        return e.code === "budget_exhausted" ? "budget" : "provider_error";
      }
      const msg = res.completion.choices[0]?.message;
      const calls = (msg?.tool_calls ?? []).flatMap((c) => (c.type === "function" ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments ?? "" }] : []));
      w.append("model.turn", { tick_id: t.tick_id, response_id: res.completion.id ?? null, content: msg?.content ?? null, tool_calls: calls, ledger: res.ref, cost_usd: res.row.cost_usd, mode: res.row.mode }, port.now());
      this.boundary("after_turn", { task_id: p.task_id });
    }
  }

  // Consecutive invalid tool calls at the end of the tick; two repairs are allowed, the third closes the tick.
  private invalidStreak(t: TickRec): number {
    let n = 0;
    for (let i = t.turns.length - 1; i >= 0; i--) {
      const turn = t.turns[i]!;
      if (!turn.tool_calls.length) break;
      const bad = turn.tool_calls.every((_c, j) => (JSON.parse(t.results.get(`${i}:${j}`) ?? "{}") as { error?: string }).error === "invalid_arguments");
      if (!bad) break;
      n += 1;
    }
    return n;
  }

  private async dispatch(w: TaskWriter, port: HospitalPort, t: TickRec, ti: number, j: number, turn: TurnRec): Promise<ToolOutcome> {
    const call = turn.tool_calls[j]!;
    const p = w.proj;
    const now = port.now();
    const ok = (v: unknown): ToolOutcome => ({ content: json({ ok: true, ...(v as object) }), invalid: false, ok: true });
    const err = (error: string, detail: unknown = {}, invalid = false): ToolOutcome => ({ content: json({ ok: false, error, detail }), invalid, ok: false });
    const actionId = `a-${shortHash(p.task_id, t.tick_id, ti, j)}`;
    // A journaled intent wins over whatever the model sends now, so a regenerated argument cannot change the key.
    const journaled = p.actions.get(actionId);
    if (journaled) return this.executeWrite(w, port, journaled, true);
    if (!(call.name in ARGS)) {
      w.append("agent.refused", { tool_name: call.name, reason: "no_such_tool", attempt: p.counts.agent_refused + 1, at: now }, now);
      return err("unknown_tool", { tool_name: call.name, note: "no tool exists for this; work of this kind belongs to people" });
    }
    const name = call.name as ToolName;
    let raw: unknown;
    try { raw = JSON.parse(call.arguments || "{}"); } catch { return err("invalid_arguments", { issues: ["arguments are not valid JSON"] }, true); }
    const parsed = ARGS[name].safeParse(raw);
    if (!parsed.success) return err("invalid_arguments", { issues: parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).slice(0, 6) }, true);
    const args = parsed.data as Record<string, unknown>;
    if ("case_id" in args && args["case_id"] !== port.caseId) return err("unknown_id");
    switch (name) {
      case "get_case_state": return ok({ state: port.caseState(args["page"] as number | undefined) });
      case "get_ward_requirements": return ok({ requirements: port.wardRequirements() });
      case "get_workflow_definition": return ok({ definition: port.workflowDefinition() });
      case "get_record": { const r = port.record(String(args["record_id"])); return r ? ok({ record: r }) : err("unknown_id"); }
      case "wait_until": return this.waitUntil(w, port, t, actionId, args);
      case "finish_task": return this.finishTask(w, port);
      default: break;
    }
    if (!isWriteTool(name)) return err("unknown_tool");
    w.append("action.intent", {
      action_id: actionId, intent_key: intentKey(p.task_id, actionId, args), action_kind: name, args, args_hash: hashJson(args),
      tool_call_id: call.id, model_response_id: turn.response_id, tick_id: t.tick_id
    }, now);
    this.boundary("after_intent", { task_id: p.task_id, action_id: actionId });
    return this.executeWrite(w, port, w.proj.actions.get(actionId)!, false);
  }

  // Reconcile before retry: a resumed intent first looks for its own effect at the port, and retries the write at most once.
  private executeWrite(w: TaskWriter, port: HospitalPort, a0: ActionRec, resumed: boolean): ToolOutcome {
    const now = port.now();
    const tid = w.proj.task_id;
    if (a0.state === "intended" || a0.state === "retrying") {
      const found = resumed ? port.findWrite(a0.intent_key) : null;
      if (found) {
        w.append("action.written", { action_id: a0.action_id, written: { record_id: found.record_id, target_record_id: found.target_record_id, event_id: found.event_id, effect_at: found.effect_at, base_version: found.base_version, reconciled: true } }, now);
      } else {
        if (resumed && a0.retries >= 1) {
          w.append("action.failed", { action_id: a0.action_id, reason: "retry_exhausted" }, now);
          return this.actionResult(w.proj.actions.get(a0.action_id)!);
        }
        if (resumed) w.append("action.retry", { action_id: a0.action_id, intent_key: a0.intent_key, reason: "no_effect_found_at_port" }, now);
        const r = port.commit(a0.action_kind, a0.args, a0.intent_key);
        this.boundary("after_port_write", { task_id: tid, action_id: a0.action_id });
        if (!r.ok) {
          if (r.counted) w.append("agent.refused", { tool_name: a0.action_kind, reason: r.reason, attempt: w.proj.counts.agent_refused + 1, at: now, layer: "port" }, now);
          w.append("action.refused", { action_id: a0.action_id, reason: r.reason, detail: r.detail }, now);
          return this.actionResult(w.proj.actions.get(a0.action_id)!, r.detail);
        }
        const x = r.write;
        w.append("action.written", { action_id: a0.action_id, written: { record_id: x.record_id, target_record_id: x.target_record_id, event_id: x.event_id, effect_at: x.effect_at, base_version: x.base_version, reconciled: false } }, now);
      }
      this.boundary("after_written", { task_id: tid, action_id: a0.action_id });
    }
    const a = w.proj.actions.get(a0.action_id)!;
    if (a.state === "written") this.tryProof(w, port, a);
    return this.actionResult(w.proj.actions.get(a0.action_id)!);
  }

  private actionResult(a: ActionRec, detail?: unknown): ToolOutcome {
    const base = { action_id: a.action_id, action_kind: a.action_kind, state: a.state };
    if (a.state === "refused" || a.state === "failed") return { content: json({ ok: false, error: a.refusal, ...base, ...(detail ? { detail } : {}) }), invalid: false, ok: false };
    const w = a.written!;
    return {
      content: json({ ok: true, ...base, record_id: w.target_record_id, effect_at: w.effect_at, verified: a.state === "completed", ...(a.proof ? { record_version: a.proof.record_version } : { note: "accepted; the runtime verifies it from the record once the work is recorded" }) }),
      invalid: false, ok: true
    };
  }

  private proofMatches(a: ActionRec, rec: RecordView): boolean {
    const w = a.written!;
    if (a.action_kind === "prepare_document" || a.action_kind === "revise_document") {
      const current = rec.source_refs.every((s) => s.version === s.current_version);
      const same = rec.content["document_id"] === a.args["document_id"] && rec.content["stage"] === a.args["stage"];
      const revised = a.action_kind !== "revise_document" || rec.version > (w.base_version ?? 0);
      return rec.kind === "document_stage" && rec.status === "complete" && current && same && revised && rec.produced_event_ids.length >= 2;
    }
    return rec.kind === "agent_write" && rec.produced_event_ids.includes(w.event_id) && hashJson(rec.content["args"]) === hashJson(a.args);
  }

  private buildProof(a: ActionRec, rec: RecordView, now: number): Proof {
    return {
      verified_at: { occurred_at: now, recorded_at: now, wall_at: this.wall() }, record_id: rec.record_id, record_version: rec.version, record_hash: rec.hash,
      produced_event_ids: rec.produced_event_ids, source_refs: rec.source_refs.map((s) => ({ record_id: s.record_id, version: s.version })),
      intent_key: a.intent_key, tool_call_ids: [a.tool_call_id], model_response_id: a.model_response_id
    };
  }

  // Proof by a fresh read through the port; nothing else can move an action to completed.
  private tryProof(w: TaskWriter, port: HospitalPort, a: ActionRec): boolean {
    if (!a.written) return false;
    const rec = port.record(a.written.target_record_id);
    if (!rec || !this.proofMatches(a, rec)) return false;
    return this.complete(w, a, this.buildProof(a, rec, port.now()), port.now());
  }

  // The completion guard; a refused attempt is appended and counted, never dropped.
  complete(w: TaskWriter, a: ActionRec, proof: unknown, minute: number): boolean {
    const g = guardCompletion(a, proof);
    if (!g.ok) {
      w.append("completion.attempt_refused", { target: "action", action_id: a.action_id, reason: g.reason }, minute);
      return false;
    }
    w.append("action.completed", { action_id: a.action_id, proof: g.proof }, minute);
    this.boundary("after_completed", { task_id: w.proj.task_id, action_id: a.action_id });
    return true;
  }

  private refreshProofs(w: TaskWriter, port: HospitalPort): void {
    for (const id of [...w.proj.order]) {
      const a = w.proj.actions.get(id)!;
      if (a.state === "written") this.tryProof(w, port, a);
    }
  }

  private statuses(p: Projection, port: HospitalPort): ConditionStatus[] {
    return conditionStatuses(p, port, p.conditions);
  }

  private waitUntil(w: TaskWriter, port: HospitalPort, t: TickRec, actionId: string, args: Record<string, unknown>): ToolOutcome {
    const now = port.now();
    const deadline = Number(args["deadline_simulated_min"]);
    if (deadline <= now) return { content: json({ ok: false, error: "invalid_arguments", detail: { issues: [`deadline_simulated_min must be after now (${now})`] } }), invalid: true, ok: false };
    const where: Record<string, string> = {};
    if (typeof args["step_id"] === "string") where["step_id"] = args["step_id"];
    if (typeof args["record_kind"] === "string") where["record_kind"] = args["record_kind"];
    const kind = typeof args["event_kind"] === "string" ? args["event_kind"] : typeof args["record_kind"] === "string" ? "record.versioned" : "step.completed";
    const predicate: EventPredicate = Object.keys(where).length ? { on: kind, where } : { on: kind };
    const wakeId = `w-${shortHash(w.proj.task_id, t.tick_id, actionId, "model")}`;
    this.registerWake(w, port, t, { wake_id: wakeId, predicate, record_ids: [], deadline_simulated_min: deadline, registered_by: "model" });
    return { content: json({ ok: true, wake_id: wakeId, predicate, deadline_simulated_min: deadline }), invalid: false, ok: true };
  }

  private registerWake(w: TaskWriter, port: HospitalPort, t: TickRec, wk: Omit<Wake, "registered_at" | "consumed_by">): void {
    if (w.proj.wakes.some((x) => x.wake_id === wk.wake_id)) return;
    const now = port.now();
    const wake = { ...wk, registered_at: { occurred_at: now, recorded_at: now, wall_at: this.wall() }, consumed_by: null };
    w.append("wake.registered", { wake, tick_id: t.tick_id, after: { minute: now, port_writes: port.allWrites().length } }, now);
    this.boundary("after_wake_registered", { task_id: w.proj.task_id });
  }

  private finishTask(w: TaskWriter, port: HospitalPort): ToolOutcome {
    const st = conditionStatuses(w.proj, port, deriveConditions(port));
    const unmet = st.filter((s) => !s.met).map((s) => s.condition.condition_id);
    if (unmet.length) {
      w.append("completion.attempt_refused", { target: "task", reason: "unmet_conditions", unmet }, port.now());
      return { content: json({ ok: false, error: "unmet_conditions", detail: { unmet } }), invalid: false, ok: false };
    }
    return { content: json({ ok: true, note: "every condition has a proof; the runtime closes the task" }), invalid: false, ok: true };
  }

  // The runtime's end-of-tick decision, model-free: done with proofs, waiting on wakes, or needs_input with the unmet list.
  private evaluate(w: TaskWriter, port: HospitalPort, outcome: LoopOutcome): void {
    const t = openTick(w.proj)!;
    const now = port.now();
    const end = (next?: TickReason) => w.append("tick.ended", { tick_id: t.tick_id, outcome, ...(next ? { next } : {}) }, now);
    if (w.proj.state !== "running") { end(); return; }
    this.refreshProofs(w, port);
    const conds = deriveConditions(port);
    if (conditionsHash(conds) !== conditionsHash(w.proj.conditions)) w.append("acceptance.derived", { conditions: conds, requirement_version: requirementsAt(port.world, now).set.requirement_version }, now);
    let st = this.statuses(w.proj, port);
    for (const s of st) {
      if (s.met || !s.refresh || !s.action_id || !s.record) continue;
      const a = w.proj.actions.get(s.action_id)!;
      w.append("proof.refreshed", { action_id: a.action_id, proof: this.buildProof(a, s.record, now) }, now);
    }
    st = this.statuses(w.proj, port);
    const unmet = st.filter((s) => !s.met);
    if (!unmet.length) {
      if (!w.proj.closed) w.append("run.closed", this.runSummary(w.proj, port), now);
      w.append("task.state_changed", { from: "running", to: "done", reason: "every_condition_proved" }, now);
      end();
      return;
    }
    const ids = unmet.map((s) => s.condition.condition_id);
    const d = deriveWakeLeaves(w.proj, port, unmet.map((s) => s.condition));
    const modelWakes = openWakes(w.proj).filter((x) => x.registered_by === "model" && x.tick_id === t.tick_id);
    const toNeedsInput = (reason: string) => { w.append("task.state_changed", { from: "running", to: "needs_input", reason, unmet: ids }, now); end(); };
    if (now >= port.horizon) return toNeedsInput("horizon_reached");
    if (d.ready.length && !modelWakes.length) {
      if (!t.nudge && (outcome === "model_ended" || outcome === "turn_cap" || outcome === "control")) {
        const next: TickReason = { kind: "nudge", ready: d.ready.map((c) => c.condition_id) };
        end(next);
        this.enqueue(w.proj.task_id, next);
        return;
      }
      return toNeedsInput("work_left_undone");
    }
    if (!d.leaves.length && !modelWakes.length) return toNeedsInput("no_wake");
    if (d.leaves.length) {
      const predicate: EventPredicate = d.leaves.length === 1 ? d.leaves[0]! : { any_of: d.leaves };
      this.registerWake(w, port, t, { wake_id: `w-${shortHash(w.proj.task_id, t.tick_id, "runtime")}`, predicate, record_ids: d.record_ids, deadline_simulated_min: null, registered_by: "runtime" });
    }
    this.registerWake(w, port, t, { wake_id: `w-${shortHash(w.proj.task_id, t.tick_id, "requirements")}`, predicate: REQUIREMENTS_WAKE, record_ids: [], deadline_simulated_min: null, registered_by: "runtime" });
    w.append("task.state_changed", { from: "running", to: "waiting", reason: "awaiting_recorded_events", unmet: ids }, now);
    this.boundary("after_waiting", { task_id: w.proj.task_id });
    end();
  }

  // The run's effect identity and counts, written once when the task closes.
  runSummary(p: Projection, port: HospitalPort): Record<string, unknown> {
    const run = port.run();
    return {
      run_id: p.run_id, task_id: p.task_id, case_id: p.case_id, engine_run_id: port.engineRunId, executor: "model_agent", version_hash: port.def.definition_hash,
      schedule_hash: run.schedule_hash, rules_hash: run.rules_hash, effect_set_hash: port.effectSetHash(), metrics: run.metrics,
      port_writes: port.allWrites().length, agent_refused_in_task: p.counts.agent_refused, agent_refused_at_port: port.refusedCount(), completion_refused: p.counts.completion_refused,
      model_calls: p.counts.model_calls, decided_by: { model: p.order.length, runtime: run.decided_by_counts.runtime, person: run.decided_by_counts.person }
    };
  }

  // The writer refuses a second resume for one wake, so a watcher notice plus a restart replay cannot resume twice.
  appendResumed(id: string, f: Pick<Firing, "wake_id" | "trigger">): boolean {
    const live = this.tasks.get(id)!;
    const w = this.writer(id);
    if (w.proj.resumed.has(f.wake_id) || w.proj.state !== "waiting" || !openWakes(w.proj).some((x) => x.wake_id === f.wake_id)) {
      this.refusedResumes += 1;
      return false;
    }
    w.append("task.resumed", { wake_id: f.wake_id, trigger: f.trigger, world_seq: live.port.headSeq(), now: live.port.now() }, live.port.now());
    this.boundary("after_resumed", { task_id: id });
    return true;
  }
  refusedResumeCount(): number { return this.refusedResumes; }

  private checkWakes(id: string): void {
    const live = this.tasks.get(id)!;
    const p = this.projection(id);
    if (p.state !== "waiting") return;
    const port = live.port;
    const f = firstFiring(openWakes(p), port.events(), port.now(), port.horizon);
    if (!f) {
      if (p.cursor.world_seq !== port.headSeq()) this.writer(id).append("resumer.cursor", { world_seq: port.headSeq(), now: port.now() }, port.now());
      return;
    }
    if (this.appendResumed(id, f)) this.enqueue(id, { kind: "resumed", wake_id: f.wake_id, trigger: f.trigger });
  }

  // The resumer: polls each world stream's size, matches waiting tasks' wakes, then moves the clock when every task on the case is idle.
  poll(): void {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const [caseId, port] of this.ports) {
        const ids = this.taskIds().filter((id) => this.tasks.get(id)!.port === port);
        const size = port.streamSize();
        if (size !== this.sizes.get(caseId)) {
          this.sizes.set(caseId, size);
          for (const id of ids) this.checkWakes(id);
        }
        if ((this.o.clock ?? "auto") === "auto") this.drive(port, ids);
      }
    } catch (e) {
      this.log(`resumer error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.polling = false;
    }
  }

  private drive(port: HospitalPort, ids: string[]): void {
    if (ids.some((id) => this.tasks.get(id)!.queued > 0 || this.projection(id).state === "running")) return;
    const waiting = ids.map((id) => this.projection(id)).filter((p) => p.state === "waiting");
    if (!waiting.length || port.now() >= port.horizon) return;
    const deadlines = waiting.flatMap((p) => openWakes(p).map((w) => w.deadline_simulated_min)).filter((d): d is number => d !== null && d > port.now());
    port.advanceTo(Math.min(port.nextEventTime() ?? port.horizon, ...deadlines));
  }

  cancel(id: string, by: string): boolean {
    const w = this.writer(id);
    if (SETTLED.has(w.proj.state) && w.proj.state !== "needs_input" && w.proj.state !== "paused") return false;
    w.append("task.state_changed", { from: w.proj.state, to: "cancelled", reason: `cancelled_by:${by}` }, this.tasks.get(id)!.port.now());
    return true;
  }

  // A person answers needs_input or lifts a pause; the runtime never skips either on its own.
  resume(id: string, text: string, by: string): boolean {
    const w = this.writer(id);
    if (w.proj.state !== "needs_input" && w.proj.state !== "paused") return false;
    const now = this.tasks.get(id)!.port.now();
    w.append("person.input", { text: text.slice(0, 500), by }, now);
    w.append("task.state_changed", { from: w.proj.state, to: "running", reason: `person:${by}` }, now);
    this.enqueue(id, { kind: "input", text });
    return true;
  }

  // The side thread: status straight from the projection and a fresh port read, with no model call.
  status(id: string): Record<string, unknown> {
    const p = this.projection(id);
    const port = this.tasks.get(id)!.port;
    let task: unknown = null;
    try { task = toAgentTask(p); } catch (e) { task = { invalid: e instanceof Error ? e.message.slice(0, 300) : "invalid" }; }
    return {
      task_id: p.task_id, case_id: p.case_id, state: p.state, reason: p.reason, unmet: p.unmet, now: port.now(),
      conditions: this.statuses(p, port).map((s) => ({ condition_id: s.condition.condition_id, met: s.met, action_id: s.action_id })),
      actions: p.order.map((id2) => { const a = p.actions.get(id2)!; return { action_id: a.action_id, action_kind: a.action_kind, state: a.state, refusal: a.refusal, proof: a.proof }; }),
      open_wakes: openWakes(p).map((w) => ({ wake_id: w.wake_id, predicate: w.predicate, deadline_simulated_min: w.deadline_simulated_min, registered_by: w.registered_by })),
      counts: p.counts, budget: p.budget, closed: p.closed, task
    };
  }

  // Resolves once every task is settled (done, needs_input, paused, failed or cancelled), or also waiting when asked, and no tick is queued.
  async settled(timeoutMs = 60_000, opts: { orWaiting?: boolean } = {}): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      const ids = this.taskIds();
      const quiet = (s: string) => SETTLED.has(s as never) || (opts.orWaiting === true && s === "waiting");
      if (ids.every((id) => this.tasks.get(id)!.queued === 0 && quiet(this.projection(id).state))) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`not settled after ${timeoutMs} ms: ${ids.map((id) => `${id}=${this.projection(id).state}`).join(", ")}`);
      await new Promise((r) => setTimeout(r, Math.max(5, Math.floor(this.pollMs / 2))));
    }
  }
}
