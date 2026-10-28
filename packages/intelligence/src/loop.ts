import { hashJson, sha256 } from "@hey-pisgah/contracts";
import { ModelError, type ChatMessage, type ModelClient, type ProviderId } from "@hey-pisgah/model";
import { ELIDED, NUDGE, REPEAT_NOTE, armHashes, kickoff, systemPrompt } from "./prompts.js";
import type { Session } from "./session.js";
import { dispatch, toolDefs } from "./tools.js";

// Model settings every investigator call carries; they are part of the committed record.
export const SETTINGS = { effort: "xhigh", parallel_tool_calls: true, max_completion_tokens: 32_000, context_chars: 60_000, provider: "modal", model: "meta-models/Muse-Spark-Open-816B-A42B" } as const;

// After this many repeated identical calls in one run, the run ends as stalled.
export const REPEAT_LIMIT = 3;

// Name plus canonical arguments, so key order and spacing do not hide a repeat.
function callKey(name: string, args: string): string {
  try { return `${name} ${hashJson(JSON.parse(args || "{}"))}`; } catch { return `${name} ${args}`; }
}

export type LoopOptions = {
  client: ModelClient;
  session: Session;
  maxCalls: number;
  budgetUsd: number;
  provider?: ProviderId;
  model?: string;
  commitment?: { revision: number | null; hash: string | null };
  sleep?: (ms: number) => Promise<void>;
};

export type LoopOutcome = { stop: string; detail: string; calls: number; usd: number; turns: number };

// Older tool results beyond the context budget are replaced by a short stub; the model can read them again.
export function compact(messages: readonly ChatMessage[], budget: number): ChatMessage[] {
  let used = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    used += m.content.length;
    if (used > budget && m.content.length > ELIDED.length) out[i] = { ...m, content: ELIDED };
  }
  return out;
}

// The investigator loop: one model call per turn, tool calls run in call order, and the run stops on the published stop rule.
export async function runLoop(o: LoopOptions): Promise<LoopOutcome> {
  const s = o.session;
  const arm = s.o.arm;
  const provider = o.provider ?? SETTINGS.provider;
  const model = o.model ?? SETTINGS.model;
  const tools = toolDefs(arm, { insufficientEvidence: s.o.insufficientEvidence });
  const proposals = arm === "prior" ? 1 : 3;
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(arm) },
    { role: "user", content: kickoff(arm, { cases: s.pool.ids().length, calls: o.maxCalls, usd: o.budgetUsd, proposals, cycle: s.o.cycle ?? 1 }) }
  ];
  s.log("session.opened", { run_id: s.runId, arm, cycle: s.o.cycle ?? 1, mode: o.client.mode, provider, model, settings: SETTINGS, max_calls: o.maxCalls, budget_usd: o.budgetUsd, hashes: armHashes(arm), commitment: o.commitment ?? null, insufficient_evidence: s.o.insufficientEvidence ?? false, system_prompt: messages[0]!.content, kickoff: messages[1]!.content });
  let turns = 0;
  let idle = 0;
  let maxCost = 0;
  let previous: string | null = null;
  let repeats = 0;
  let stop: { reason: string; detail: string } | null = null;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  while (!stop) {
    if (s.stop) { stop = { reason: s.stop.reason, detail: s.stop.detail }; break; }
    const u = o.client.runUsage(s.runId);
    if (u.calls >= o.maxCalls) { stop = { reason: "budget_calls", detail: `${u.calls} calls` }; break; }
    if (u.usd + maxCost > o.budgetUsd) { stop = { reason: "budget_usd", detail: `${u.usd.toFixed(4)} spent, next call could pass the cap` }; break; }
    let res;
    let tries = 0;
    for (;;) {
      try {
        res = await o.client.call({
          provider, model, effort: SETTINGS.effort, messages: compact(messages, SETTINGS.context_chars), tools, parallel_tool_calls: SETTINGS.parallel_tool_calls,
          max_completion_tokens: SETTINGS.max_completion_tokens, purpose: `discovery.${arm}`, run_id: s.runId, task_id: null, task_state: null, thread: "main", affinity_key: s.runId
        });
        break;
      } catch (e) {
        if (e instanceof ModelError && e.code === "budget_exhausted") { stop = { reason: "budget_exhausted", detail: String(e.detail.scope ?? "") }; break; }
        if (e instanceof ModelError && e.code === "provider_error" && tries === 0) { tries += 1; s.log("model.retry", { turn: turns, status: e.detail.status ?? null }); await sleep(5000); continue; }
        if (e instanceof ModelError) { stop = { reason: e.code, detail: e.message.slice(0, 200) }; break; }
        throw e;
      }
    }
    if (!res) break;
    turns += 1;
    maxCost = Math.max(maxCost, res.row.cost_usd);
    const msg = res.completion.choices[0]?.message;
    const calls = (msg?.tool_calls ?? []).flatMap((c) => (c.type === "function" ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments ?? "" }] : []));
    s.log("model.turn", { turn: turns, response_id: res.row.response_id, finish_reason: res.completion.choices[0]?.finish_reason ?? null, content: (msg?.content ?? "").slice(0, 4000), tool_calls: calls, cost_usd: res.row.cost_usd, prompt_tokens: res.row.prompt_tokens, completion_tokens: res.row.completion_tokens, reasoning_tokens: res.row.reasoning_tokens, latency_ms: res.row.latency_ms, ledger_seq: res.ref.seq });
    if (!calls.length) {
      idle += 1;
      if (idle >= 2) { stop = { reason: "model_ended", detail: (msg?.content ?? "").slice(0, 200) }; break; }
      messages.push({ role: "assistant", content: msg?.content ?? "" }, { role: "user", content: NUDGE });
      continue;
    }
    idle = 0;
    messages.push({ role: "assistant", content: msg?.content ?? null, tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) });
    for (const [i, c] of calls.entries()) {
      const key = callKey(c.name, c.arguments);
      const repeated = key === previous;
      previous = key;
      if (repeated) repeats += 1;
      const result = repeated ? { ok: false, error: "repeated_call", message: REPEAT_NOTE } : await dispatch(s, c.name, c.arguments);
      const text = JSON.stringify(result);
      s.log("tool.called", { turn: turns, index: i, call_id: c.id, name: c.name, args: c.arguments.slice(0, 8000), args_hash: sha256(c.arguments), result_hash: sha256(text), ok: result.ok !== false, error: result.ok === false ? String(result.error) : null, result: text.slice(0, 30_000) });
      messages.push({ role: "tool", tool_call_id: c.id, content: text });
    }
    if (repeats >= REPEAT_LIMIT && !s.stop) s.stall(repeats);
  }
  const u = o.client.runUsage(s.runId);
  const out: LoopOutcome = { stop: stop!.reason, detail: stop!.detail, calls: u.calls, usd: Math.round(u.usd * 1e6) / 1e6, turns };
  s.log("session.stopped", { ...out, counters: s.counters, repeated_calls: repeats, hypotheses: s.hypotheses.size, experiments: s.experiments.size, proposals: [...s.proposals.keys()], transcript_hash: hashJson(messages) });
  return out;
}
