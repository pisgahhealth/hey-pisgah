import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import OpenAI from "openai";
import type { LedgerRow } from "@hey-pisgah/contracts";
import { loadKeys } from "./env.js";
import { BudgetHit, ProbeLedger, STRENGTH, buildRow, p50, readUsage, shapeOf, type Effort, type Usage } from "./ledger.js";
import { SUITE, SUITE_SYSTEM, judgeToolCalls, toolDefs } from "./tools.js";

type Route = { provider: LedgerRow["provider"]; baseURL: string; key: string | null; model: string; hosted_mode: LedgerRow["hosted_mode"]; headers: Record<string, string> };
type ChatOut = { ok: boolean; status: number; data: any; latency_ms: number; error: string | null };

const ZERO: Usage = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: null, cached_tokens: null };
const MODAL_MODEL = "meta-models/Muse-Spark-Open-816B-A42B";
const EFFORT_PROMPT = "A ward has 3 discharges waiting on pharmacy, 2 waiting on billing and 1 of those waiting on both. How many discharges are waiting on at least one of them? Reply with the number only.";

function routes(k: Record<string, string>): Route[] {
  const modalKey = k.MODAL_PROXY_TOKEN_ID && k.MODAL_PROXY_TOKEN_SECRET ? `${k.MODAL_PROXY_TOKEN_ID}.${k.MODAL_PROXY_TOKEN_SECRET}` : null;
  return [
    { provider: "modal", baseURL: (k.MODAL_ENDPOINT_URL ?? "").replace(/\/$/, ""), key: modalKey && k.MODAL_ENDPOINT_URL ? modalKey : null, model: MODAL_MODEL, hosted_mode: null, headers: {} },
    { provider: "meta", baseURL: "https://api.meta.ai/v1", key: k.MODEL_API_KEY || null, model: "muse-spark-1.3", hosted_mode: "standard", headers: {} },
    { provider: "baseten", baseURL: "https://inference.baseten.co/v1", key: k.BASETEN_API_KEY || null, model: "unknown", hosted_mode: null, headers: {} },
    { provider: "fireworks", baseURL: "https://api.fireworks.ai/inference/v1", key: k.FIREWORKS_API_KEY || null, model: "unknown", hosted_mode: null, headers: {} }
  ];
}

const errText = (e: unknown) => String((e as any)?.error?.message ?? (e as any)?.message ?? e).slice(0, 200);

export class Probe {
  readonly runId = `run-${randomBytes(8).toString("hex").replace(/[^a-z0-9]/g, "").slice(0, 8)}`;
  readonly results: Record<string, unknown> = {};
  private clients = new Map<string, OpenAI>();
  constructor(readonly root: string, readonly ledger: ProbeLedger) {}

  client(r: Route): OpenAI {
    let c = this.clients.get(r.provider);
    if (!c) { c = new OpenAI({ baseURL: r.baseURL, apiKey: r.key ?? "", maxRetries: 0, timeout: 180_000 }); this.clients.set(r.provider, c); }
    return c;
  }

  record(r: Route, effort: Effort, purpose: string, usage: Usage, latency_ms: number, extra: { response_id?: string | null; strength?: number | null; affinity?: string | null; extra_cost_usd?: number } = {}): void {
    this.ledger.append(buildRow({
      provider: r.provider, model: r.model, hosted_mode: r.hosted_mode, effort, effective_strength: extra.strength === undefined ? (r.provider === "meta" ? null : STRENGTH[effort]) : extra.strength,
      response_id: extra.response_id ?? null, usage, latency_ms, purpose, run_id: this.runId, affinity_key: extra.affinity ?? null,
      ...(extra.extra_cost_usd === undefined ? {} : { extra_cost_usd: extra.extra_cost_usd })
    }));
  }

  // One chat call with its ledger row; requested is the raw effort string sent, effort is the ledger's nearest valid value.
  async chat(r: Route, body: Record<string, unknown>, o: { purpose: string; effort: Effort; requested?: string; strength?: number | null; headers?: Record<string, string> }): Promise<ChatOut> {
    this.ledger.reserve();
    const t0 = performance.now();
    const affinity = o.headers?.["Modal-Routing-Affinity-Key"] ?? null;
    try {
      const { data } = await this.client(r).chat.completions.create({ model: r.model, reasoning_effort: o.requested ?? o.effort, ...body } as any, { headers: { ...r.headers, ...o.headers } }).withResponse();
      const latency_ms = performance.now() - t0;
      this.record(r, o.effort, o.purpose, readUsage((data as any).usage), latency_ms, { response_id: (data as any).id ?? null, affinity, ...(o.strength === undefined ? {} : { strength: o.strength }) });
      return { ok: true, status: 200, data, latency_ms, error: null };
    } catch (e) {
      const latency_ms = performance.now() - t0;
      this.record(r, o.effort, `${o.purpose} error`, ZERO, latency_ms, { affinity, strength: null });
      return { ok: false, status: (e as any)?.status ?? 0, data: null, latency_ms, error: errText(e) };
    }
  }

  log(name: string, value: unknown): void {
    this.results[name] = value;
    console.log(`${name}: ${JSON.stringify(value).slice(0, 400)}`);
  }

  save(name: string, data: unknown): void {
    mkdirSync(`${this.root}/.hey-pisgah/logs`, { recursive: true });
    writeFileSync(`${this.root}/.hey-pisgah/logs/${name}.json`, JSON.stringify(data, null, 2) + "\n");
  }

  async models(r: Route): Promise<void> {
    this.ledger.reserve();
    const t0 = performance.now();
    try {
      const page = await this.client(r).models.list();
      this.record(r, "low", "probe:models", ZERO, performance.now() - t0, { strength: null });
      this.log(`models.${r.provider}`, page.data.map((m) => m.id));
    } catch (e) {
      this.record(r, "low", "probe:models error", ZERO, performance.now() - t0, { strength: null });
      this.log(`models.${r.provider}`, { error: errText(e), status: (e as any)?.status ?? 0 });
    }
  }

  async toolRoundTrip(r: Route): Promise<void> {
    const tools = toolDefs(["get_case_state"]);
    const messages: any[] = [{ role: "system", content: "Use the tool to answer." }, { role: "user", content: "What is the current state of case C-104?" }];
    const extra = r.provider === "modal" ? { parallel_tool_calls: false } : {};
    const first = await this.chat(r, { messages, tools, tool_choice: "auto", max_tokens: 1024, ...extra }, { purpose: "probe:tool_call", effort: "low" });
    if (!first.ok) return this.log(`tool_call.${r.provider}`, { status: first.status, error: first.error });
    this.save(`probe-${r.provider}-tool-call`, first.data);
    const choice = first.data.choices?.[0];
    const verdict = judgeToolCalls(choice?.message?.tool_calls);
    const out: Record<string, unknown> = {
      finish_reason: choice?.finish_reason, verdict, message_shape: shapeOf(choice?.message), usage_shape: shapeOf(first.data.usage),
      response_id: first.data.id ?? null, latency_ms: Math.round(first.latency_ms), parallel_tool_calls_sent: r.provider === "modal" ? false : "omitted"
    };
    const call = choice?.message?.tool_calls?.[0];
    if (call) {
      const followUp = [...messages, choice.message, { role: "tool", tool_call_id: call.id, content: JSON.stringify({ case_id: "C-104", state: "waiting", waiting_on: ["pharmacy"] }) }];
      const second = await this.chat(r, { messages: followUp, tools, tool_choice: "auto", max_tokens: 1024, ...extra }, { purpose: "probe:tool_result", effort: "low" });
      out.second_turn = second.ok ? { finish_reason: second.data.choices?.[0]?.finish_reason, text: String(second.data.choices?.[0]?.message?.content ?? "").slice(0, 160) } : { status: second.status, error: second.error };
    }
    this.log(`tool_call.${r.provider}`, out);
  }

  async efforts(r: Route): Promise<void> {
    const tried: Record<string, unknown> = {};
    for (const requested of ["low", "medium", "high", "xhigh", "none", "max"]) {
      const effort: Effort = requested === "none" ? "low" : requested === "max" ? "xhigh" : (requested as Effort);
      const res = await this.chat(r, { messages: [{ role: "user", content: EFFORT_PROMPT }], max_tokens: 8000 }, { purpose: `probe:effort requested=${requested}`, effort, requested, strength: requested === "none" || requested === "max" ? null : STRENGTH[effort] });
      const u = res.ok ? readUsage(res.data.usage) : null;
      tried[requested] = res.ok ? { status: 200, reasoning_tokens: u?.reasoning_tokens, completion_tokens: u?.completion_tokens, answer: String(res.data.choices?.[0]?.message?.content ?? "").trim().slice(0, 40), latency_ms: Math.round(res.latency_ms) } : { status: res.status, error: res.error };
      console.log(`  effort ${requested}: ${JSON.stringify(tried[requested]).slice(0, 200)}`);
    }
    this.log(`efforts.${r.provider}`, tried);
  }

  async strengthLine(r: Route): Promise<void> {
    const res = await this.chat(r, { messages: [{ role: "system", content: "Reasoning strength: 8." }, { role: "user", content: EFFORT_PROMPT }], max_tokens: 8000 }, { purpose: "probe:strength_line xhigh+8", effort: "xhigh", strength: null });
    const u = res.ok ? readUsage(res.data.usage) : null;
    this.log(`strength_line.${r.provider}`, res.ok ? { reasoning_tokens: u?.reasoning_tokens, completion_tokens: u?.completion_tokens, answer: String(res.data.choices?.[0]?.message?.content ?? "").trim().slice(0, 40) } : { status: res.status, error: res.error });
  }

  // Repeats the strength-line test on a harder prompt, where low and xhigh should differ widely.
  async strengthHard(r: Route): Promise<void> {
    const prompt = "How many ordered pairs (a, b) of positive integers with a <= 30 and b <= 30 make a*b + a + b a perfect square? Reply with the number only.";
    const plan: [string, Effort, boolean][] = [["low", "low", false], ["xhigh", "xhigh", false], ["xhigh+line", "xhigh", true], ["xhigh", "xhigh", false], ["xhigh+line", "xhigh", true]];
    const out: unknown[] = [];
    for (const [label, effort, line] of plan) {
      const messages = [...(line ? [{ role: "system", content: "Reasoning strength: 8." }] : []), { role: "user", content: prompt }];
      const res = await this.chat(r, { messages, max_tokens: 8000 }, { purpose: `probe:strength_hard ${label}`, effort, ...(line ? { strength: null } : {}) });
      const u = res.ok ? readUsage(res.data.usage) : null;
      out.push(res.ok ? { label, reasoning_tokens: u?.reasoning_tokens, finish: res.data.choices?.[0]?.finish_reason, answer: String(res.data.choices?.[0]?.message?.content ?? "").trim().slice(0, 20) } : { label, status: res.status, error: res.error });
      console.log(`  ${JSON.stringify(out.at(-1))}`);
    }
    this.log(`strength_hard.${r.provider}`, out);
  }

  async cache(r: Route): Promise<void> {
    const para = (i: number) => `Rule ${i}. A discharge on ward ${["A", "B", "C", "D"][i % 4]} needs the bill settled, the pharmacy pack released, the nurse summary signed and the transport booked before the patient leaves; the clerk records each step with its time and the name of the person who did it.`;
    const handbook = Array.from({ length: 70 }, (_, i) => para(i + 1)).join("\n");
    const messages = [{ role: "system", content: `Ward handbook follows.\n${handbook}` }, { role: "user", content: "Which rule number is the last one? Reply with the number only." }];
    const headers = { "Modal-Routing-Affinity-Key": "probe-1" };
    const out: unknown[] = [];
    for (const n of [1, 2]) {
      const res = await this.chat(r, { messages, max_tokens: 400 }, { purpose: `probe:cache ${n}`, effort: "low", headers });
      out.push(res.ok ? { prompt_tokens: res.data.usage?.prompt_tokens, cached_tokens: readUsage(res.data.usage).cached_tokens, prompt_tokens_details: res.data.usage?.prompt_tokens_details ?? null, usage_keys: Object.keys(res.data.usage ?? {}), latency_ms: Math.round(res.latency_ms) } : { status: res.status, error: res.error });
    }
    this.log(`cache.${r.provider}`, out);
  }

  async reasoningContent(r: Route): Promise<void> {
    const ask = [{ role: "user", content: "Choose a secret whole number between 1 and 100 in your reasoning. Do not write it in your reply. Reply only with the word ready." }];
    const first = await this.chat(r, { messages: ask, max_tokens: 4000 }, { purpose: "probe:reasoning_content turn1", effort: "medium" });
    if (!first.ok) return this.log(`reasoning_content.${r.provider}`, { status: first.status, error: first.error });
    const msg = first.data.choices?.[0]?.message ?? {};
    const reasoning: string | undefined = msg.reasoning_content ?? msg.reasoning;
    const field = msg.reasoning_content !== undefined ? "reasoning_content" : msg.reasoning !== undefined ? "reasoning" : null;
    const follow = { role: "user", content: "What was the secret number? If you cannot see it, reply UNKNOWN." };
    const withR = await this.chat(r, { messages: [...ask, { role: "assistant", content: msg.content ?? "ready", reasoning_content: reasoning ?? "" }, follow], max_tokens: 4000 }, { purpose: "probe:reasoning_content with", effort: "low" });
    const without = await this.chat(r, { messages: [...ask, { role: "assistant", content: msg.content ?? "ready" }, follow], max_tokens: 4000 }, { purpose: "probe:reasoning_content without", effort: "low" });
    const view = (x: ChatOut) => (x.ok ? { prompt_tokens: x.data.usage?.prompt_tokens, answer: String(x.data.choices?.[0]?.message?.content ?? "").trim().slice(0, 60) } : { status: x.status, error: x.error });
    this.log(`reasoning_content.${r.provider}`, { field, reasoning_chars: reasoning?.length ?? 0, turn1_reply: String(msg.content ?? "").slice(0, 40), with: view(withR), without: view(without) });
  }

  async responsesToolSearch(r: Route): Promise<void> {
    this.ledger.reserve();
    const t0 = performance.now();
    const res = await fetch(`${r.baseURL}/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${r.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: r.model, input: "Say hi.", tools: [{ type: "tool_search" }], reasoning: { effort: "low" }, max_output_tokens: 200 })
    });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* non-JSON error bodies are kept as text */ }
    const usage = body?.usage ? readUsage({ prompt_tokens: body.usage.input_tokens, completion_tokens: body.usage.output_tokens, reasoning_tokens: body.usage.output_tokens_details?.reasoning_tokens, cached_tokens: body.usage.input_tokens_details?.cached_tokens }) : ZERO;
    this.record(r, "low", `probe:responses tool_search status=${res.status}`, usage, performance.now() - t0, { strength: null, response_id: body?.id ?? null });
    this.save(`probe-${r.provider}-responses-tool-search`, body ?? text.slice(0, 2000));
    this.log(`responses_tool_search.${r.provider}`, { status: res.status, error: body?.error?.message?.slice?.(0, 200) ?? body?.detail ?? text.slice(0, 200) });
  }

  async transcribe(r: Route): Promise<void> {
    const wav = `${this.root}/.hey-pisgah/tmp/silence-3s-16k.wav`;
    mkdirSync(`${this.root}/.hey-pisgah/tmp`, { recursive: true });
    execFileSync("python3", ["-c", "import sys,wave\nw=wave.open(sys.argv[1],'wb');w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(b'\\x00\\x00'*48000);w.close()", wav]);
    const form = new FormData();
    form.append("request", new Blob([JSON.stringify({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "PUSH_TO_TALK", keywords: ["Ward A", "bed 4"] })], { type: "application/json" }));
    form.append("audio", new Blob([readFileSync(wav)], { type: "audio/wav" }), "silence.wav");
    this.ledger.reserve();
    const t0 = performance.now();
    const res = await fetch("https://api.meta.ai/v1/asr/transcribe?sessionId=probe", { method: "POST", headers: { Authorization: `Bearer ${r.key}`, Accept: "application/json" }, body: form });
    const text = await res.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    const asr: Route = { ...r, model: "muse-voice-transcribe-1.0" };
    this.record(asr, "low", `probe:asr status=${res.status}`, ZERO, performance.now() - t0, { strength: null, extra_cost_usd: res.ok ? (3 * 0.18) / 3600 : 0 });
    this.save("probe-meta-asr", body ?? text.slice(0, 500));
    this.log("asr.meta", { status: res.status, shape: body ? shapeOf(body) : text.slice(0, 200) });
  }

  async suite(r: Route, n: number): Promise<void> {
    const items = SUITE.slice(0, n);
    const tools = toolDefs();
    const verdicts: { i: number; expect: string; got: string | null; valid: boolean; reason: string | null; calls: number; finish: string | null }[] = [];
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        const item = items[i]!;
        const res = await this.chat(r, { messages: [{ role: "system", content: SUITE_SYSTEM }, { role: "user", content: item.prompt }], tools, tool_choice: "auto", parallel_tool_calls: false, max_tokens: 1024 }, { purpose: `probe:suite ${i + 1}`, effort: "low" });
        const choice = res.ok ? res.data.choices?.[0] : null;
        const v = res.ok ? judgeToolCalls(choice?.message?.tool_calls) : { valid: false, reason: `http_${res.status}`, name: null, calls: 0 };
        verdicts.push({ i: i + 1, expect: item.expect, got: v.name, valid: v.valid, reason: v.reason, calls: v.calls, finish: choice?.finish_reason ?? null });
        if (!v.valid) console.log(`  suite ${i + 1} invalid: ${v.reason}${res.ok ? ` args=${String(choice?.message?.tool_calls?.[0]?.function?.arguments ?? "").slice(0, 120)}` : ` ${res.error}`}`);
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    verdicts.sort((a, b) => a.i - b.i);
    const invalid = verdicts.filter((v) => !v.valid).length;
    const wrongTool = verdicts.filter((v) => v.valid && v.got !== v.expect).length;
    const multi = verdicts.filter((v) => v.calls > 1).length;
    this.save(`probe-suite-${this.runId}`, verdicts);
    this.log(`suite.${r.provider}`, { n: verdicts.length, invalid, invalid_rate: verdicts.length ? invalid / verdicts.length : null, wrong_tool: wrongTool, multi_call: multi });
    console.log(`invalid rate: ${invalid}/${verdicts.length} = ${(100 * invalid / Math.max(1, verdicts.length)).toFixed(1)}%`);
  }

  summary(): void {
    const by = new Map<string, LedgerRow[]>();
    for (const row of this.ledger.rows) by.set(row.provider, [...(by.get(row.provider) ?? []), row]);
    const chat = (rows: LedgerRow[]) => rows.filter((x) => x.prompt_tokens > 0);
    const out = Object.fromEntries([...by].map(([p, rows]) => [p, { calls: rows.length, chat_calls: chat(rows).length, p50_latency_ms: p50(chat(rows).map((x) => x.latency_ms)), cost_usd: Number(rows.reduce((s, x) => s + x.cost_usd, 0).toFixed(5)) }]));
    console.log(`ledger: ${this.ledger.rows.length} calls, $${this.ledger.spent.toFixed(4)} total; ${JSON.stringify(out)}`);
  }
}

const STEPS = ["models", "tool_call", "efforts", "strength_line", "strength_hard", "cache", "reasoning_content", "responses", "asr"] as const;

export async function runProbe(root: string, argv: string[]): Promise<number> {
  const keys = loadKeys();
  const maxUsd = Number(keys.HEY_PISGAH_BUDGET_USD ?? 2);
  const ledger = new ProbeLedger(`${root}/.hey-pisgah/store/ledger/probe.jsonl`, Number(keys.HEY_PISGAH_PROBE_MAX_CALLS ?? 60), Number.isFinite(maxUsd) ? maxUsd : 2);
  const probe = new Probe(root, ledger);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? "" : null; };
  if (argv.includes("--summary")) { probe.summary(); return 0; }
  const all = routes(keys);
  for (const r of all) if (!r.key) console.log(`${r.provider}: no key`);
  const modal = all.find((r) => r.provider === "modal" && r.key);
  const meta = all.find((r) => r.provider === "meta" && r.key);
  const suiteN = flag("--tool-suite");
  const only = flag("--only")?.split(",") ?? (suiteN !== null ? [] : [...STEPS]);
  try {
    if (only.includes("models")) for (const r of [modal, meta]) if (r) await probe.models(r);
    if (only.includes("tool_call")) for (const r of [modal, meta]) if (r) await probe.toolRoundTrip(r);
    if (modal && only.includes("efforts")) await probe.efforts(modal);
    if (modal && only.includes("strength_line")) await probe.strengthLine(modal);
    if (modal && only.includes("strength_hard")) await probe.strengthHard(modal);
    if (modal && only.includes("cache")) await probe.cache(modal);
    if (modal && only.includes("reasoning_content")) await probe.reasoningContent(modal);
    if (modal && only.includes("responses")) await probe.responsesToolSearch(modal);
    if (meta && only.includes("asr")) await probe.transcribe(meta);
    if (suiteN !== null) {
      if (!modal) { console.log("tool suite: no Modal key"); return 1; }
      await probe.suite(modal, Math.min(SUITE.length, Math.max(1, Number(suiteN) || 30)));
    }
  } catch (e) {
    if (!(e instanceof BudgetHit)) throw e;
    console.log(`STOP: ${e.message}`);
    probe.save(`probe-${probe.runId}`, probe.results);
    probe.summary();
    return 4;
  }
  probe.save(`probe-${probe.runId}`, probe.results);
  probe.summary();
  return 0;
}
