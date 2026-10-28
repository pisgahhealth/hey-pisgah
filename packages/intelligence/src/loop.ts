import { hashJson, sha256 } from "@hey-pisgah/contracts";
import { ModelError, type ChatMessage, type ModelClient, type ProviderId } from "@hey-pisgah/model";
import { ARGS_NOTE, DROPPED_NOTE, resultDigest } from "./digest.js";
import { ELIDED, NOTES_HEADER, NUDGE, REPEAT_NOTE, armHashes, kickoff, systemPrompt } from "./prompts.js";
import type { Session } from "./session.js";
import { dispatch, toolDefs } from "./tools.js";

// Model settings every investigator call carries; they are part of the committed record.
export const SETTINGS = { effort: "xhigh", parallel_tool_calls: true, max_completion_tokens: 32_000, context_chars: 30_000, history_chars: 70_000, turn_result_chars: 20_000, provider: "modal", model: "meta-models/Muse-Spark-Open-816B-A42B" } as const;

// After this many repeated identical calls in one run, the run ends as stalled.
export const REPEAT_LIMIT = 3;

// The case ids one call's arguments name, so its result can stay whole while a hypothesis cites the case.
function casesOf(args: string): string[] {
  try {
    const a = JSON.parse(args || "{}") as { case_id?: unknown; case_ids?: unknown };
    return [...(typeof a.case_id === "string" ? [a.case_id] : []), ...(Array.isArray(a.case_ids) ? a.case_ids.filter((x): x is string => typeof x === "string") : [])];
  } catch { return []; }
}

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

// What compaction knows about each tool result: the tool name and its short form.
export type Digests = Map<string, { name: string; digest: string | null; cases: string[] }>;

const ELIDED_ARGS = JSON.stringify({ elided: ARGS_NOTE });
// The smallest stub, for results and arguments older than the short-form tier.
export const ELIDED_MIN = JSON.stringify({ elided: true });
// Older assistant text past the budget keeps only its opening characters.
const TEXT_KEEP = 240;

// Newest first: the turn the model has not seen stays whole and outside the budget; results on a case an active hypothesis cites stay whole; the latest definition read becomes its short form and stays; then full results up to the budget, short forms up to the budget again, and the smallest stub after that.
export function compact(messages: readonly ChatMessage[], budget: number, digests: Digests = new Map(), pinned: ReadonlySet<string> = new Set()): ChatMessage[] {
  let used = 0;
  let shortUsed = 0;
  let definitionPinned = false;
  const out = [...messages];
  let lastAssistant = -1;
  for (let i = out.length - 1; i >= 0; i--) if (out[i]!.role === "assistant") { lastAssistant = i; break; }
  const shorten = (full: string, short: string | null): string => {
    if (used + full.length <= budget) { used += full.length; return full; }
    used = budget + 1;
    if (short !== null && short.length < full.length && shortUsed + short.length <= budget) { shortUsed += short.length; return short; }
    return full.length > ELIDED_MIN.length ? ELIDED_MIN : full;
  };
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role === "assistant") {
      if (i === lastAssistant) continue;
      const text = typeof m.content === "string" && m.content.length > TEXT_KEEP && used > budget ? m.content.slice(0, TEXT_KEEP) : m.content;
      if (typeof m.content === "string") used += m.content.length;
      const calls = m.tool_calls?.map((c) => (c.type !== "function" ? c : { ...c, function: { ...c.function, arguments: shorten(c.function.arguments, ELIDED_ARGS) } }));
      out[i] = { ...m, content: text ?? null, ...(calls ? { tool_calls: calls } : {}) } as ChatMessage;
      continue;
    }
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    if (i > lastAssistant) continue;
    const d = digests.get(m.tool_call_id);
    if (d?.name === "get_workflow_definition") {
      out[i] = { ...m, content: definitionPinned || !d.digest ? ELIDED_MIN : d.digest };
      definitionPinned = true;
      continue;
    }
    if (pinned.has(m.tool_call_id)) { used += m.content.length; continue; }
    out[i] = { ...m, content: shorten(m.content, d?.digest ?? ELIDED) };
  }
  return out;
}

// When the older turns after the kickoff still pass the cap, whole older turns go, oldest first and turns holding a pinned result last, and one note says how many and keeps the short forms of the definition and the case list.
export function dropOldTurns(messages: readonly ChatMessage[], cap: number, pinned: ReadonlySet<string> = new Set()): ChatMessage[] {
  const head = messages.slice(0, 2);
  let lastAssistant = messages.length - 1;
  while (lastAssistant >= 2 && messages[lastAssistant]!.role !== "assistant") lastAssistant -= 1;
  if (lastAssistant < 2) return [...messages];
  const newest = messages.slice(lastAssistant);
  const size = (ms: readonly ChatMessage[]) => ms.reduce((n, m) => n + JSON.stringify(m).length, 0);
  const groups: ChatMessage[][] = [];
  for (const m of messages.slice(2, lastAssistant)) {
    if (m.role === "tool" && groups.length) groups.at(-1)!.push(m);
    else groups.push([m]);
  }
  let total = groups.reduce((n, g) => n + size(g), 0);
  if (total <= cap) return [...messages];
  const kept: Record<string, unknown> = {};
  const keep = (m: ChatMessage) => {
    if (m.role !== "tool" || typeof m.content !== "string") return;
    try {
      const v = JSON.parse(m.content) as Record<string, unknown>;
      if (Array.isArray(v.steps) && Array.isArray(v.edges)) kept.definition = v;
      if (Array.isArray(v.cases) && typeof v.cases[0] === "string") kept.cases = v.cases;
    } catch { /* a stub or text */ }
  };
  const holdsPin = (g: ChatMessage[]) => g.some((m) => m.role === "tool" && pinned.has(m.tool_call_id));
  const gone = new Set<number>();
  for (const pass of [false, true]) {
    for (let i = 0; i < groups.length && total > cap; i++) {
      if (gone.has(i) || holdsPin(groups[i]!) !== pass) continue;
      gone.add(i);
      total -= size(groups[i]!);
    }
  }
  for (const i of [...gone].sort((a, b) => a - b)) for (const m of groups[i]!) keep(m);
  const note = JSON.stringify({ elided_turns: gone.size, note: DROPPED_NOTE, ...kept });
  return [...head, { role: "user", content: note }, ...groups.flatMap((g, i) => (gone.has(i) ? [] : g)), ...newest];
}

// The investigator's saved notes, numbered, as one message placed after the kickoff; null when there are none.
export function notesMessage(notes: readonly string[]): ChatMessage | null {
  return notes.length ? { role: "user", content: `${NOTES_HEADER}\n${notes.map((n, i) => `${i + 1}. ${n}`).join("\n")}` } : null;
}

// Puts the notes message right after the system prompt and the kickoff.
export function withNotes(messages: readonly ChatMessage[], notes: readonly string[]): ChatMessage[] {
  const n = notesMessage(notes);
  return n ? [...messages.slice(0, 2), n, ...messages.slice(2)] : [...messages];
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
  const digests: Digests = new Map();
  while (!stop) {
    if (s.stop) { stop = { reason: s.stop.reason, detail: s.stop.detail }; break; }
    const u = o.client.runUsage(s.runId);
    if (u.calls >= o.maxCalls) { stop = { reason: "budget_calls", detail: `${u.calls} calls` }; break; }
    if (u.usd + maxCost > o.budgetUsd) { stop = { reason: "budget_usd", detail: `${u.usd.toFixed(4)} spent, next call could pass the cap` }; break; }
    const cited = s.citedCases();
    const pinned = new Set([...digests.entries()].filter(([, d]) => d.cases.some((c) => cited.has(c))).map(([id]) => id));
    let res;
    let tries = 0;
    for (;;) {
      try {
        res = await o.client.call({
          provider, model, effort: SETTINGS.effort, messages: withNotes(dropOldTurns(compact(messages, SETTINGS.context_chars, digests, pinned), SETTINGS.history_chars, pinned), s.notes), tools, parallel_tool_calls: SETTINGS.parallel_tool_calls,
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
    const pageChars = Math.max(2_000, Math.floor(SETTINGS.turn_result_chars / calls.length));
    for (const [i, c] of calls.entries()) {
      const key = callKey(c.name, c.arguments);
      const repeated = key === previous;
      previous = key;
      if (repeated) repeats += 1;
      const result = repeated ? { ok: false, error: "repeated_call", message: REPEAT_NOTE } : await dispatch(s, c.name, c.arguments, { pageChars });
      const text = JSON.stringify(result);
      s.log("tool.called", { turn: turns, index: i, call_id: c.id, name: c.name, args: c.arguments.slice(0, 8000), args_hash: sha256(c.arguments), result_hash: sha256(text), ok: result.ok !== false, error: result.ok === false ? String(result.error) : null, result: text.slice(0, 30_000) });
      const short = resultDigest(c.name, result, s.base);
      digests.set(c.id, { name: c.name, digest: short ? JSON.stringify(short) : null, cases: casesOf(c.arguments) });
      messages.push({ role: "tool", tool_call_id: c.id, content: text });
    }
    if (repeats >= REPEAT_LIMIT && !s.stop) s.stall(repeats);
  }
  const u = o.client.runUsage(s.runId);
  const out: LoopOutcome = { stop: stop!.reason, detail: stop!.detail, calls: u.calls, usd: Math.round(u.usd * 1e6) / 1e6, turns };
  s.log("session.stopped", { ...out, counters: s.counters, repeated_calls: repeats, hypotheses: s.hypotheses.size, experiments: s.experiments.size, proposals: [...s.proposals.keys()], transcript_hash: hashJson(messages) });
  return out;
}
