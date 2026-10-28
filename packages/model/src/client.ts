import { join } from "node:path";
import OpenAI from "openai";
import { Effort, LedgerRow, TaskState, estimateCostUsd, type StoreRef } from "@hey-pisgah/contracts";
import { openStream, type Stream } from "@hey-pisgah/store";
import type { z } from "zod";
import { budgetFromEnv, weekSpendUsd, type Budget } from "./budget.js";
import { loadKeys } from "./env.js";
import { ModelError } from "./errors.js";
import { DEFAULT_RECORDINGS_DIR, pickHeaders, readRecording, requestHash, wireJson, writeRecording } from "./recordings.js";
import { ROUTES, parseUsage, routeFor, type EffortLevel, type ProviderId } from "./routes.js";

export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;
export type Mode = LedgerRow["mode"];
type TaskStateValue = z.infer<typeof TaskState>;

export type CallArgs = {
  provider: ProviderId;
  model: string;
  effort: EffortLevel;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
  parallel_tool_calls?: boolean;
  max_completion_tokens?: number;
  // Route-specific body fields such as chat_template_args; they are part of the request hash.
  extra?: Record<string, unknown>;
  purpose: string;
  run_id: string | null;
  task_id: string | null;
  task_state: TaskStateValue | null;
  thread: "main" | "side";
  affinity_key: string | null;
  repairs?: number;
};

export type CallResult = { completion: ChatCompletion; row: LedgerRow; ref: StoreRef; hash: string };

export type MockResponder = (req: { provider: ProviderId; body: Record<string, unknown>; hash: string }) => ChatCompletion;

export type ClientOptions = {
  storeRoot: string;
  mode?: Mode;
  recordingsDir?: string;
  keys?: Record<string, string>;
  budget?: Budget;
  mock?: MockResponder;
  // The projected task state wins over the caller's argument, so a stale caller cannot slip past the waiting gate.
  taskStateOf?: (taskId: string) => TaskStateValue | null;
  baseURLOverride?: Partial<Record<ProviderId, string>>;
  timeoutMs?: number;
  now?: () => Date;
};

const DENY_EFFORT_LINE = /Reasoning strength:/i;

function contentText(m: ChatMessage): string {
  const c = (m as { content?: unknown }).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("\n");
  return "";
}

// The fixed mock reply: one call to the first declared tool with empty arguments, or a short text.
export const fixedMock: MockResponder = ({ body, hash }) => {
  const tools = (body.tools ?? []) as ChatTool[];
  const first = tools.find((t) => t.type === "function");
  const message: OpenAI.Chat.Completions.ChatCompletionMessage = first
    ? { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "call_mock_1", type: "function", function: { name: first.function.name, arguments: "{}" } }] }
    : { role: "assistant", content: "mock", refusal: null };
  return {
    id: `mock-${hash.slice(0, 12)}`,
    object: "chat.completion",
    created: 0,
    model: String(body.model),
    choices: [{ index: 0, message, finish_reason: first ? "tool_calls" : "stop", logprobs: null }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
};

export class ModelClient {
  readonly mode: Mode;
  private readonly keys: Record<string, string>;
  private readonly budget: Budget;
  private readonly ledgers = new Map<string, Stream>();
  private readonly inflight = new Map<string, number>();
  private readonly sdk = new Map<string, OpenAI>();
  private readonly recordingsDir: string;

  constructor(private readonly opts: ClientOptions) {
    const m = opts.mode ?? (process.env.HEY_PISGAH_MODE as Mode | undefined) ?? "mock";
    if (m !== "live" && m !== "replay" && m !== "mock") throw new Error(`HEY_PISGAH_MODE must be live, replay or mock`);
    this.mode = m;
    this.keys = opts.keys ?? (m === "live" ? loadKeys() : {});
    this.budget = opts.budget ?? budgetFromEnv();
    this.recordingsDir = opts.recordingsDir ?? DEFAULT_RECORDINGS_DIR;
  }

  ledgerStreamId(runId: string | null): string {
    return `ledger/${runId ?? "adhoc"}`;
  }

  private ledger(runId: string | null): Stream {
    const id = this.ledgerStreamId(runId);
    let s = this.ledgers.get(id);
    if (!s) {
      s = openStream(this.opts.storeRoot, id, { writer: true });
      this.ledgers.set(id, s);
    }
    return s;
  }

  // Calls and spend already on this run's ledger, plus calls in flight.
  runUsage(runId: string | null): { calls: number; usd: number } {
    const rows = this.ledger(runId)
      .records()
      .filter((e) => e.record_type === "model.call")
      .map((e) => e.payload as LedgerRow);
    return { calls: rows.length + (this.inflight.get(this.ledgerStreamId(runId)) ?? 0), usd: rows.reduce((s, r) => s + r.cost_usd, 0) };
  }

  private refuse(args: CallArgs, code: "refused_while_waiting" | "budget_exhausted", detail: Record<string, unknown>): never {
    this.ledger(args.run_id).append(
      "model.refused",
      { reason: code, provider: args.provider, model: args.model, purpose: args.purpose, task_id: args.task_id, task_state: args.task_state, thread: args.thread, at_wall: this.now().toISOString(), ...detail },
      { recorded_at: 0, occurred_at: 0 }
    );
    throw new ModelError(code, code === "budget_exhausted" ? "budget reached before the call" : "the task is waiting, so no model call is allowed", detail);
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private gate(args: CallArgs): TaskStateValue | null {
    const projected = args.task_id && this.opts.taskStateOf ? this.opts.taskStateOf(args.task_id) : null;
    const state = projected ?? args.task_state;
    if (state === "waiting" && args.thread !== "side") this.refuse({ ...args, task_state: state }, "refused_while_waiting", { projected: projected !== null });
    return state;
  }

  private checkBudget(args: CallArgs): void {
    const run = this.runUsage(args.run_id);
    if (run.calls >= this.budget.runMaxCalls) this.refuse(args, "budget_exhausted", { scope: "run_calls", used: run.calls, cap: this.budget.runMaxCalls });
    if (run.usd >= this.budget.runUsd) this.refuse(args, "budget_exhausted", { scope: "run_usd", used: run.usd, cap: this.budget.runUsd });
    const week = weekSpendUsd(join(this.opts.storeRoot, "ledger"), this.budget.weekSince());
    const stop = this.budget.weekUsd * this.budget.weekStopFraction;
    if (week >= stop) this.refuse(args, "budget_exhausted", { scope: "week_usd", used: week, cap: stop });
  }

  private body(args: CallArgs): Record<string, unknown> {
    const reserved = ["model", "messages", "reasoning_effort", "tools", "stream"];
    const extra = Object.fromEntries(Object.entries(args.extra ?? {}).filter(([k]) => !reserved.includes(k)));
    return wireJson({
      ...extra,
      model: args.model,
      messages: args.messages,
      reasoning_effort: args.effort,
      ...(args.tools ? { tools: args.tools } : {}),
      ...(args.tool_choice !== undefined ? { tool_choice: args.tool_choice } : {}),
      ...(args.parallel_tool_calls !== undefined ? { parallel_tool_calls: args.parallel_tool_calls } : {}),
      ...(args.max_completion_tokens !== undefined ? { max_completion_tokens: args.max_completion_tokens } : {})
    });
  }

  private client(provider: ProviderId): OpenAI {
    let c = this.sdk.get(provider);
    if (c) return c;
    const route = ROUTES[provider];
    const apiKey = route.apiKey(this.keys);
    const baseURL = this.opts.baseURLOverride?.[provider] ?? route.baseURL(this.keys);
    if (!apiKey || !baseURL) throw new ModelError("no_key", "this route has no key in ~/.hey-pisgah.env", { provider });
    // Retries are off so a timed-out call is never billed twice without a ledger row.
    c = new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: this.opts.timeoutMs ?? 120_000 });
    this.sdk.set(provider, c);
    return c;
  }

  async call(args: CallArgs): Promise<CallResult> {
    const route = routeFor(args.provider, args.model);
    if (!Effort.safeParse(args.effort).success) throw new ModelError("effort_required", "every call names low, medium, high or xhigh", { effort: args.effort });
    if (!args.purpose) throw new Error("purpose is required");
    for (const m of args.messages) {
      if ((m.role === "system" || m.role === "developer") && DENY_EFFORT_LINE.test(contentText(m))) {
        throw new ModelError("effort_override_refused", "a system line would override the effort parameter");
      }
    }
    if (route.toolChoiceAutoOnly && args.tool_choice !== undefined && args.tool_choice !== "auto") {
      throw new ModelError("unsupported_param", "this route accepts tool_choice auto only", { provider: args.provider });
    }
    const taskState = this.gate(args);
    if (this.mode === "live") this.client(args.provider);
    this.checkBudget(args);

    const body = this.body(args);
    const hash = requestHash(args.provider, body);
    const ledgerId = this.ledgerStreamId(args.run_id);
    this.inflight.set(ledgerId, (this.inflight.get(ledgerId) ?? 0) + 1);
    let completion: ChatCompletion;
    let latency = 0;
    try {
      if (this.mode === "mock") {
        completion = (this.opts.mock ?? fixedMock)({ provider: args.provider, body, hash });
      } else if (this.mode === "replay") {
        const rec = readRecording(this.recordingsDir, hash);
        completion = rec.response as ChatCompletion;
        latency = rec.latency_ms;
      } else {
        const headers: Record<string, string> = {};
        if (route.affinityHeader && args.affinity_key) headers[route.affinityHeader] = args.affinity_key;
        const t0 = performance.now();
        let res: { data: ChatCompletion; response: Response };
        try {
          res = await this.client(args.provider)
            .chat.completions.create(body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, { headers })
            .withResponse();
        } catch (e) {
          const status = (e as { status?: number }).status ?? null;
          throw new ModelError("provider_error", `the route answered with an error${status ? ` (${status})` : ""}`, { provider: args.provider, status });
        }
        latency = Math.round(performance.now() - t0);
        completion = res.data;
        writeRecording(
          this.recordingsDir,
          { hash, provider: args.provider, request: body, response: completion, headers: pickHeaders(res.response.headers), status: res.response.status, latency_ms: latency, recorded_at: this.now().toISOString() },
          Object.values(this.keys).filter((v) => v.length >= 6).concat(route.apiKey(this.keys) ?? [])
        );
      }
    } finally {
      this.inflight.set(ledgerId, Math.max(0, (this.inflight.get(ledgerId) ?? 1) - 1));
    }

    const usage = parseUsage(args.provider, completion.usage);
    const row = LedgerRow.parse({
      at_wall: this.now().toISOString(),
      provider: args.provider,
      model: args.model,
      mode: this.mode,
      hosted_mode: route.hostedMode(args.model),
      effort: args.effort,
      effective_strength: route.strength(args.model, args.effort),
      response_id: completion.id ?? null,
      ...usage,
      latency_ms: Math.max(0, latency),
      repairs: args.repairs ?? 0,
      cost_usd: estimateCostUsd(usage),
      purpose: args.purpose,
      run_id: args.run_id,
      task_id: args.task_id,
      task_state: taskState,
      thread: args.thread,
      affinity_key: args.affinity_key
    });
    const env = this.ledger(args.run_id).append("model.call", row, { recorded_at: 0, occurred_at: 0 });
    return { completion, row, ref: { stream_id: env.stream_id, seq: env.seq }, hash };
  }

  appendRecord(runId: string | null, recordType: string, payload: unknown): StoreRef {
    const e = this.ledger(runId).append(recordType, payload, { recorded_at: 0, occurred_at: 0 });
    return { stream_id: e.stream_id, seq: e.seq };
  }

  close(): void {
    for (const s of this.ledgers.values()) s.close();
    this.ledgers.clear();
  }
}

export function createModelClient(opts: ClientOptions): ModelClient {
  return new ModelClient(opts);
}
