import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { LedgerRow, estimateCostUsd, verifyChain } from "@hey-pisgah/contracts";
import { readStream } from "@hey-pisgah/store";
import { DEFAULT_RECORDINGS_DIR, KEYS_PATH, ModelError, callStructured, createModelClient, runRecordingKey, parseUsage, secretValues, type CallArgs, type ChatCompletion, type ClientOptions, type MockResponder } from "./index.js";
import { SMOKE_REQUEST, SmokeArgs } from "./smoke.js";

let dir: string;
let store: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hp-model-"));
  store = join(dir, "store");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const budget = (over: Partial<NonNullable<ClientOptions["budget"]>> = {}) => ({ runUsd: 5, runMaxCalls: 50, weekUsd: 120, weekStopFraction: 0.8, weekSince: () => new Date(0), ...over });

const base: CallArgs = {
  provider: "modal",
  model: "meta-models/Muse-Spark-Open-816B-A42B",
  effort: "low",
  messages: [{ role: "user", content: "hello" }],
  purpose: "test",
  run_id: "run-test0001",
  task_id: null,
  task_state: null,
  thread: "main",
  affinity_key: null
};

function completion(message: Partial<ChatCompletion["choices"][0]["message"]>, usage: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }): ChatCompletion {
  return {
    id: "cmpl-1",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: null, refusal: null, ...message }, finish_reason: "stop", logprobs: null }],
    usage: usage as unknown as NonNullable<ChatCompletion["usage"]>
  };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ModelError) return e.code;
    throw e;
  }
  return "no_error";
}

const rows = (runId = "run-test0001") => readStream(store, `ledger/${runId}`);

describe("registry and request shape", () => {
  it("refuses a route with no key before any network call", async () => {
    const c = createModelClient({ storeRoot: store, mode: "live", keys: {}, budget: budget() });
    expect(await code(c.call({ ...base, provider: "baseten", model: "meta-models/muse-spark-open" }))).toBe("no_key");
    expect(await code(c.call({ ...base, provider: "fireworks", model: "accounts/fireworks/models/muse-spark-open" }))).toBe("no_key");
    expect(await code(c.call(base))).toBe("no_key");
    expect(await code(c.call({ ...base, model: "gpt-x" }))).toBe("unknown_model");
    expect(await code(c.call({ ...base, provider: "groq" as never }))).toBe("unknown_provider");
    c.close();
  });

  it("requires an explicit effort and always sends reasoning_effort", async () => {
    const seen: Record<string, unknown>[] = [];
    const c = createModelClient({ storeRoot: store, mode: "mock", budget: budget(), mock: (r) => (seen.push(r.body), completion({ content: "ok" })) });
    expect(await code(c.call({ ...base, effort: undefined as never }))).toBe("effort_required");
    expect(await code(c.call({ ...base, effort: "none" as never }))).toBe("effort_required");
    await c.call({ ...base, effort: "medium" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reasoning_effort).toBe("medium");
    c.close();
  });

  it("refuses a system line that would override the effort", async () => {
    const c = createModelClient({ storeRoot: store, mode: "mock", budget: budget() });
    const sys = (content: string) => ({ ...base, messages: [{ role: "system" as const, content }, ...base.messages] });
    expect(await code(c.call(sys("Be brief.\nReasoning strength: 8.")))).toBe("effort_override_refused");
    expect(await code(c.call(sys("reasoning STRENGTH: 512")))).toBe("effort_override_refused");
    expect(await code(c.call(sys("Be brief.")))).toBe("no_error");
    c.close();
  });

  it("refuses tool_choice other than auto on the hosted route", async () => {
    const c = createModelClient({ storeRoot: store, mode: "mock", budget: budget() });
    expect(await code(c.call({ ...base, provider: "meta", model: "muse-spark-1.3", tool_choice: "required" }))).toBe("unsupported_param");
    c.close();
  });
});

describe("usage and the ledger", () => {
  it("parses Modal's top-level reasoning and Meta's nested details", () => {
    expect(parseUsage("modal", { prompt_tokens: 674, completion_tokens: 98, prompt_tokens_details: null, reasoning_tokens: 22 })).toEqual({ prompt_tokens: 674, completion_tokens: 98, reasoning_tokens: 22, cached_tokens: null });
    expect(parseUsage("meta", { prompt_tokens: 683, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 12 }, prompt_tokens_details: { cached_tokens: 497 } })).toEqual({ prompt_tokens: 683, completion_tokens: 40, reasoning_tokens: 12, cached_tokens: 497 });
  });

  it("appends one chained ledger row per call with cost from estimateCostUsd", async () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 50 }, prompt_tokens_details: { cached_tokens: 400 } };
    const c = createModelClient({ storeRoot: store, mode: "mock", budget: budget(), mock: () => completion({ content: "ok" }, usage) });
    const r = await c.call({ ...base, provider: "meta", model: "muse-spark-1.3", task_id: "t-abcd1234", task_state: "running", affinity_key: "k1" });
    c.close();
    const env = rows();
    expect(verifyChain(env)).toEqual({ ok: true });
    expect(env).toHaveLength(1);
    const row = LedgerRow.parse(env[0]!.payload);
    expect(row).toEqual(r.row);
    expect(row).toMatchObject({ provider: "meta", mode: "mock", hosted_mode: "standard", effort: "low", effective_strength: null, reasoning_tokens: 50, cached_tokens: 400, task_state: "running", thread: "main", affinity_key: "k1", repairs: 0 });
    expect(row.cost_usd).toBe(estimateCostUsd({ prompt_tokens: 1000, completion_tokens: 200, cached_tokens: 400 }));
    expect(r.ref).toEqual({ stream_id: "ledger/run-test0001", seq: 1 });
  });
});

describe("the waiting gate", () => {
  it("refuses a main-thread call while the task is waiting and makes no call", async () => {
    let calls = 0;
    const c = createModelClient({ storeRoot: store, mode: "mock", budget: budget(), mock: () => (calls++, completion({ content: "ok" })) });
    expect(await code(c.call({ ...base, task_id: "t-abcd1234", task_state: "waiting" }))).toBe("refused_while_waiting");
    expect(calls).toBe(0);
    await c.call({ ...base, task_id: "t-abcd1234", task_state: "waiting", thread: "side" });
    expect(calls).toBe(1);
    c.close();
    expect(rows().map((e) => e.record_type)).toEqual(["model.refused", "model.call"]);
  });

  it("uses the projected task state over a stale argument", async () => {
    let calls = 0;
    const c = createModelClient({ storeRoot: store, mode: "mock", budget: budget(), taskStateOf: () => "waiting", mock: () => (calls++, completion({ content: "ok" })) });
    expect(await code(c.call({ ...base, task_id: "t-abcd1234", task_state: "running" }))).toBe("refused_while_waiting");
    expect(calls).toBe(0);
    c.close();
  });
});

describe("budgets", () => {
  it("stops at the run call cap before the call", async () => {
    let calls = 0;
    const c = createModelClient({ storeRoot: store, mode: "mock", budget: budget({ runMaxCalls: 2 }), mock: () => (calls++, completion({ content: "ok" })) });
    await c.call(base);
    await c.call(base);
    expect(await code(c.call(base))).toBe("budget_exhausted");
    expect(calls).toBe(2);
    expect(await code(c.call({ ...base, run_id: "run-test0002" }))).toBe("no_error");
    c.close();
  });

  it("stops at the run dollar cap", async () => {
    const big = { prompt_tokens: 0, completion_tokens: 300_000, total_tokens: 300_000 };
    const c = createModelClient({ storeRoot: store, mode: "mock", budget: budget({ runUsd: 1 }), mock: () => completion({ content: "ok" }, big) });
    await c.call(base);
    let err: ModelError | undefined;
    try {
      await c.call(base);
    } catch (e) {
      err = e as ModelError;
    }
    expect(err?.code).toBe("budget_exhausted");
    expect(err?.detail).toMatchObject({ scope: "run_usd", cap: 1 });
    c.close();
  });

  it("counts every ledger in the week, including bare probe rows, and stops at 80%", async () => {
    mkdirSync(join(store, "ledger"), { recursive: true });
    const probeRow = LedgerRow.parse({ at_wall: new Date().toISOString(), provider: "modal", model: "m", mode: "live", hosted_mode: null, effort: "low", effective_strength: 8, response_id: null, prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: null, cached_tokens: null, latency_ms: 0, repairs: 0, cost_usd: 9, purpose: "probe", run_id: null, task_id: null, task_state: null, thread: "main", affinity_key: null });
    writeFileSync(join(store, "ledger", "probe.jsonl"), `${JSON.stringify(probeRow)}\n`);
    let calls = 0;
    const c = createModelClient({ storeRoot: store, mode: "mock", budget: budget({ weekUsd: 10 }), mock: () => (calls++, completion({ content: "ok" })) });
    let err: ModelError | undefined;
    try {
      await c.call(base);
    } catch (e) {
      err = e as ModelError;
    }
    expect(err?.code).toBe("budget_exhausted");
    expect(err?.detail).toMatchObject({ scope: "week_usd", used: 9, cap: 8 });
    expect(calls).toBe(0);
    c.close();
  });
});

type Handler = (body: any, headers: IncomingHttpHeaders) => unknown;

async function fakeRoute(handlers: Handler[]): Promise<{ url: string; server: Server; seen: { body: any; headers: IncomingHttpHeaders }[] }> {
  const seen: { body: any; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ body, headers: req.headers });
      const h = handlers[Math.min(seen.length - 1, handlers.length - 1)]!;
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "req-1", "set-cookie": "s=1" });
      res.end(JSON.stringify(h(body, req.headers)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, server, seen };
}

const toolReply = (args: string) => () => completion({ tool_calls: [{ id: "call_1", type: "function", function: { name: "get_case_state", arguments: args } }] }, { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, reasoning_tokens: 3, prompt_tokens_details: null });

describe("record and replay", () => {
  const fakeKeys = { MODAL_PROXY_TOKEN_ID: "wk-fakeid1234", MODAL_PROXY_TOKEN_SECRET: "ws-fakesecret5678" };

  it("records live bodies without keys, replays them exactly and fails loudly on a miss", async () => {
    const route = await fakeRoute([toolReply('{"case_id":"c-ab12cd34"}')]);
    const rec = join(dir, "rec");
    try {
      const keys = { ...fakeKeys, MODAL_ENDPOINT_URL: route.url };
      const live = createModelClient({ storeRoot: store, mode: "live", keys, recordingsDir: rec, budget: budget() });
      const a = await live.call({ ...base, affinity_key: "case-1" });
      live.close();
      expect(route.seen[0]!.headers.authorization).toBe("Bearer wk-fakeid1234.ws-fakesecret5678");
      expect(route.seen[0]!.headers["modal-routing-affinity-key"]).toBe("case-1");
      expect(route.seen[0]!.body.reasoning_effort).toBe("low");
      const files = readdirSync(rec);
      const own = runRecordingKey("modal", a.hash, base.run_id!, 1);
      expect(files.sort()).toEqual([`${a.hash}.json`, `${own}.json`].sort());
      expect(JSON.parse(readFileSync(join(rec, `${own}.json`), "utf8"))).toMatchObject({ body_hash: a.hash, run_id: base.run_id, occurrence: 1 });
      expect(JSON.parse(readFileSync(join(rec, `${own}.json`), "utf8"))).not.toHaveProperty("request");
      const text = readFileSync(join(rec, `${a.hash}.json`), "utf8");
      for (const v of Object.values(keys)) expect(text).not.toContain(v);
      expect(text.toLowerCase()).not.toContain("set-cookie");
      expect(Object.keys(JSON.parse(text).headers).sort()).toEqual(["content-type", "date", "x-request-id"]);

      const replay = createModelClient({ storeRoot: store, mode: "replay", recordingsDir: rec, budget: budget() });
      const b = await replay.call({ ...base, affinity_key: "case-1" });
      expect(b.completion).toEqual(a.completion);
      expect(b.row).toMatchObject({ mode: "replay", reasoning_tokens: 3, cached_tokens: null, cost_usd: a.row.cost_usd });
      let miss: ModelError | undefined;
      try {
        await replay.call({ ...base, messages: [{ role: "user", content: "something new" }] });
      } catch (e) {
        miss = e as ModelError;
      }
      expect(miss?.code).toBe("replay_miss");
      expect(miss?.message).toContain("HEY_PISGAH_MODE=live");
      replay.close();
    } finally {
      route.server.close();
    }
  });

  it("keys recordings by run as well as body, so two runs with one body each replay their own reply", async () => {
    const route = await fakeRoute([() => completion({ content: "first run" }), () => completion({ content: "second run" }), () => completion({ content: "second run, same body again" })]);
    const rec = join(dir, "rec-runs");
    try {
      const keys = { ...fakeKeys, MODAL_ENDPOINT_URL: route.url };
      const live = createModelClient({ storeRoot: join(dir, "r1"), mode: "live", keys, recordingsDir: rec, budget: budget() });
      await live.call({ ...base, run_id: "run-aaaa0001" });
      await live.call({ ...base, run_id: "run-aaaa0002" });
      await live.call({ ...base, run_id: "run-aaaa0002" });
      live.close();
      const replay = createModelClient({ storeRoot: join(dir, "r2"), mode: "replay", recordingsDir: rec, budget: budget() });
      const text = async (run: string) => (await replay.call({ ...base, run_id: run })).completion.choices[0]!.message.content;
      expect(await text("run-aaaa0001")).toBe("first run");
      expect(await text("run-aaaa0002")).toBe("second run");
      expect(await text("run-aaaa0002")).toBe("second run, same body again");
      expect(await text("run-unseen01")).toBe("second run, same body again");
      replay.close();
    } finally {
      route.server.close();
    }
  });

  it("refuses to write a recording that would contain a key", async () => {
    const route = await fakeRoute([() => completion({ content: "echo ws-fakesecret5678" })]);
    try {
      const c = createModelClient({ storeRoot: store, mode: "live", keys: { ...fakeKeys, MODAL_ENDPOINT_URL: route.url }, recordingsDir: join(dir, "rec"), budget: budget() });
      expect(await code(c.call(base))).toBe("secret_in_recording");
      c.close();
    } finally {
      route.server.close();
    }
  });

  it("the committed Modal recording replays with its usage shape", async () => {
    const c = createModelClient({ storeRoot: store, mode: "replay", budget: budget() });
    const r = await callStructured(c, SmokeArgs, SMOKE_REQUEST, { toolName: "get_case_state" });
    c.close();
    expect(r.value).toEqual({ case_id: "c-ab12cd34" });
    expect(r.repairs).toBe(0);
    expect(r.result.row.reasoning_tokens).toBeGreaterThan(0);
    expect(r.result.row.cached_tokens).toBeNull();
    expect(r.result.row.completion_tokens).toBeGreaterThanOrEqual(r.result.row.reasoning_tokens!);
    expect(r.result.row.effective_strength).toBe(8);
  });

  it("no committed recording contains any value from the keys file", () => {
    const files = readdirSync(DEFAULT_RECORDINGS_DIR).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    const secrets = secretValues(KEYS_PATH);
    for (const f of files) {
      const text = readFileSync(join(DEFAULT_RECORDINGS_DIR, f), "utf8");
      for (const s of secrets) expect(text.includes(s), `a key value appears in ${f}`).toBe(false);
      expect(/authorization|bearer /i.test(text), `an auth header appears in ${f}`).toBe(false);
    }
  });
});

describe("structured repair", () => {
  const Schema = z.strictObject({ case_id: z.string().regex(/^c-[a-z0-9]{8}$/) });
  const args: CallArgs = { ...base, tools: SMOKE_REQUEST.tools! };

  it("feeds the zod path back, counts the repair and records the route that enforced", async () => {
    const seen: any[] = [];
    const replies = [toolReply('{"case_id":42}')(), toolReply('{"case_id":"c-ab12cd34"}')()];
    const mock: MockResponder = (r) => (seen.push(r.body), replies[seen.length - 1]!);
    const c = createModelClient({ storeRoot: store, mode: "mock", budget: budget(), mock });
    const r = await callStructured(c, Schema, args, { toolName: "get_case_state" });
    c.close();
    expect(r).toMatchObject({ value: { case_id: "c-ab12cd34" }, repairs: 1, enforced_by: null, source: "tool_call" });
    const repairTurn = seen[1].messages.at(-1);
    expect(repairTurn).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(repairTurn.content).toContain("$.case_id");
    const env = rows();
    expect(env.map((e) => e.record_type)).toEqual(["model.call", "model.call", "model.structured"]);
    expect(env.slice(0, 2).map((e) => (e.payload as LedgerRow).repairs)).toEqual([0, 1]);
    expect(env[2]!.payload).toMatchObject({ ok: true, repairs: 1, enforced_by: null });
  });

  it("validates JSON content too and fails closed after two repairs", async () => {
    let calls = 0;
    const c = createModelClient({ storeRoot: store, mode: "mock", budget: budget(), mock: () => (calls++, completion({ content: '```json\n{"case_id":"nope"}\n```' })) });
    expect(await code(callStructured(c, Schema, base))).toBe("structured_invalid");
    expect(calls).toBe(3);
    c.close();
    expect(rows().at(-1)!.payload).toMatchObject({ ok: false, repairs: 2 });
  });

  it("repairs replay from recorded fixtures with the same count", async () => {
    const route = await fakeRoute([toolReply("not json"), toolReply('{"case_id":"C-BAD"}'), toolReply('{"case_id":"c-ab12cd34"}')]);
    const rec = join(dir, "rec");
    try {
      const keys = { MODAL_PROXY_TOKEN_ID: "wk-fakeid1234", MODAL_PROXY_TOKEN_SECRET: "ws-fakesecret5678", MODAL_ENDPOINT_URL: route.url };
      const live = createModelClient({ storeRoot: join(dir, "s1"), mode: "live", keys, recordingsDir: rec, budget: budget() });
      const a = await callStructured(live, Schema, args);
      live.close();
      const replay = createModelClient({ storeRoot: join(dir, "s2"), mode: "replay", recordingsDir: rec, budget: budget() });
      const b = await callStructured(replay, Schema, args);
      replay.close();
      expect(a.repairs).toBe(2);
      expect(b.repairs).toBe(2);
      expect(b.value).toEqual(a.value);
      expect(readdirSync(rec)).toHaveLength(6);
    } finally {
      route.server.close();
    }
  });
});
