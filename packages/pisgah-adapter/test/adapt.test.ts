import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ListenSessions, gateUtterance, GATE_SETTINGS, type EmrRuntime } from "@hey-pisgah/agent";
import { ModelClient, secondSparkRoute } from "@hey-pisgah/model";
import { DoorProfile } from "../src/profile.js";
import { PisgahPort } from "../src/port.js";

const ADM = "11111111-2222-4333-8444-555555555555";
const EPI = "22222222-3333-4444-8555-666666666666";
const PAT = "33333333-4444-4555-8666-777777777777";
const VISIT = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const ORDER = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
const DRUG = "88888888-9999-4aaa-8bbb-cccccccccccc";
const OWNER = "44444444-5555-4666-8777-888888888888";
const PROV = { owner: OWNER, evidence: "transcript:u-0000aaaa", spoken_at: "2026-10-31T09:00:00.000Z" };
const TOKEN = `v2.1761700000001.${"N".repeat(22)}.${"a".repeat(43)}`;

const profile = (extra: Record<string, unknown> = {}) => DoorProfile.parse({
  base_url: "http://127.0.0.1:9/door", timeout_ms: 2000,
  headers: { on_behalf_of: "X-For", origin: "X-Origin", evidence: "X-Evidence", spoken_at: "X-Spoken", idempotency: "X-Key", replayed: "X-Replayed" },
  origin_value: "voice", deny: ["stay/settle"],
  ops: {
    read_admission: { method: "GET", path: "stay/{admission_id}", label: "name", visit: "visitId", facts: { ward: "ward" }, proof: { pulse: "latest.p" } },
    write_observation: { method: "POST", path: "stay/entry", body: { episode: "$episode_id", p: "$pulse" }, writes_path: "writes", primary_store: "obs" },
    speaker: { path: "voice/speaker" }
  },
  orders: {
    tests: { malaria_parasite: { words: ["malaria parasite", "malaria test"], name: "Malaria parasite" } },
    drugs: { paracetamol_oral: { words: ["oral paracetamol"], id: DRUG } }
  },
  result_orders: { path: "orders", query: { visitId: "$visit_id" }, list: "orders", id: "stateId", test: "label", state: "orderStatus", states: ["RESULT_UPLOADED"] },
  targets: { admission_by_patient: {}, episode_by_admission: { [ADM]: EPI } },
  vocabulary: ["pulse"],
  ...extra
});

type Call = { url: string; method: string; auth: string; key: string | null };
const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
// A fake door answering by a list of replies in order; every call is kept with its bearer and key.
function fakeFetch(replies: ((u: string) => Response)[]) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url: String(url), method: init?.method ?? "GET", auth: h.get("authorization") ?? "", key: h.get("x-key") });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return r(String(url));
  }) as typeof fetch;
  return { f, calls };
}

describe("a 401 inside the serve re-mints the owner's bearer once and retries under the same key", () => {
  it("401 then 200: one refresh, one write, same key, and the fresh bearer is kept", async () => {
    const { f, calls } = fakeFetch([() => json(401, { error: { code: "unauthorized" } }), () => json(200, { writes: [{ store: "obs", id: ORDER }] })]);
    let refreshed = 0;
    const bearers = { [OWNER]: "old-bearer" };
    const port = new PisgahPort(profile(), { bearers, fetch: f, budget: null, refresh: async () => { refreshed++; return "fresh-bearer"; } });
    const c = await port.commit("record_observation", { admission_id: ADM, pulse: 80 }, "k".repeat(64), PROV);
    expect(c).toMatchObject({ ok: true, record_id: ORDER });
    expect(refreshed).toBe(1);
    expect(calls.map((x) => x.auth)).toEqual(["Bearer old-bearer", "Bearer fresh-bearer"]);
    expect(calls[0]!.key).toBe("k".repeat(64));
    expect(calls[1]!.key).toBe(calls[0]!.key);
    expect(bearers[OWNER]).toBe("fresh-bearer");
  });

  it("an owner with no bearer yet is minted once before the call, and refused when no mint is configured or it gives none", async () => {
    const { f, calls } = fakeFetch([() => json(200, { name: "Test Patient", visitId: VISIT, ward: "Ward A" })]);
    const bearers: Record<string, string> = {};
    const port = new PisgahPort(profile(), { bearers, fetch: f, budget: null, refresh: async () => "first-bearer" });
    await port.resolve({ admission_id: ADM }, PROV);
    expect(calls.map((x) => x.auth)).toEqual(["Bearer first-bearer"]);
    expect(bearers[OWNER]).toBe("first-bearer");
    const none = fakeFetch([() => json(200, {})]);
    await expect(new PisgahPort(profile(), { bearers: {}, fetch: none.f, budget: null }).resolve({ admission_id: ADM }, PROV)).rejects.toThrow();
    await expect(new PisgahPort(profile(), { bearers: {}, fetch: none.f, budget: null, refresh: async () => null }).resolve({ admission_id: ADM }, PROV)).rejects.toThrow();
    expect(none.calls).toEqual([]);
  });

  it("two requests refused together share one refresh, and a refresh that gives no bearer is tried once", async () => {
    const auths: string[] = [];
    const g = (async (_url: string | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      auths.push(auth);
      return auth === "Bearer fresh-bearer" ? json(200, { name: "Test Patient", visitId: VISIT, ward: "Ward A" }) : json(401, {});
    }) as typeof fetch;
    let refreshed = 0;
    const port = new PisgahPort(profile(), { bearers: { [OWNER]: "old-bearer" }, fetch: g, budget: null, refresh: async () => { refreshed++; await new Promise((r) => setTimeout(r, 20)); return "fresh-bearer"; } });
    await Promise.all([port.resolve({ admission_id: ADM }, PROV), port.resolve({ admission_id: ADM }, PROV)]);
    expect(refreshed).toBe(1);
    expect(auths).toEqual(["Bearer old-bearer", "Bearer old-bearer", "Bearer fresh-bearer", "Bearer fresh-bearer"]);
    // A refresh that gives no bearer leaves the 401 as the door's answer, after one try.
    const { f: always, calls } = fakeFetch([() => json(401, {})]);
    let tried = 0;
    const p2 = new PisgahPort(profile(), { bearers: { [OWNER]: "old-bearer" }, fetch: always, budget: null, refresh: async () => { tried++; return null; } });
    expect(await p2.commit("record_observation", { admission_id: ADM, pulse: 80 }, "k".repeat(64), PROV)).toMatchObject({ ok: false, reason: "door_401" });
    expect(calls).toHaveLength(1);
    expect(tried).toBe(1);
  });

  it("negative control: without a refresh the 401 stays a refusal and nothing is sent again", async () => {
    const { f, calls } = fakeFetch([() => json(401, {}), () => json(200, { writes: [{ store: "obs", id: ORDER }] })]);
    const port = new PisgahPort(profile(), { bearers: { [OWNER]: "old-bearer" }, fetch: f, budget: null });
    expect(await port.commit("record_observation", { admission_id: ADM, pulse: 80 }, "k".repeat(64), PROV)).toMatchObject({ ok: false, reason: "door_401" });
    expect(calls).toHaveLength(1);
  });
});

describe("a door 429 on the speaker match is retried once after a second", () => {
  it("429 then owner gives the owner after two requests and one 1 s sleep", async () => {
    const { f, calls } = fakeFetch([() => json(429, {}), () => json(200, { speaker: "owner", token: TOKEN })]);
    const sleeps: number[] = [];
    const port = new PisgahPort(profile(), { bearers: { [OWNER]: "b" }, fetch: f, budget: null, sleep: async (ms) => { sleeps.push(ms); } });
    expect(await port.speaker!(OWNER, [0.1, 0.2], PROV)).toEqual({ speaker: "owner", token: TOKEN });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it("two 429s give unverified, never the owner, after one retry", async () => {
    const { f, calls } = fakeFetch([() => json(429, {})]);
    const sleeps: number[] = [];
    const port = new PisgahPort(profile(), { bearers: { [OWNER]: "b" }, fetch: f, budget: null, sleep: async (ms) => { sleeps.push(ms); } });
    expect(await port.speaker!(OWNER, [0.1, 0.2], PROV)).toEqual({ speaker: "unverified", reason: "door_429" });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it("negative control: any other refusal is not retried", async () => {
    const { f, calls } = fakeFetch([() => json(403, {})]);
    const sleeps: number[] = [];
    const port = new PisgahPort(profile(), { bearers: { [OWNER]: "b" }, fetch: f, budget: null, sleep: async (ms) => { sleeps.push(ms); } });
    expect(await port.speaker!(OWNER, [0.1, 0.2], PROV)).toEqual({ speaker: "unverified", reason: "door_403" });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});

describe("a budget named in the profile paces the door", () => {
  it("lets reads go up to the profile's capacity and paces the next one, with no budget passed to the port", async () => {
    const { f, calls } = fakeFetch([() => json(200, {}), () => json(200, {}), () => json(200, {})]);
    const port = new PisgahPort(profile({ budget: { capacity: 2, per_second: 0.001, write_reserve: 1, read_wait_ms: 0 } }), { bearers: { [OWNER]: "b" }, fetch: f });
    expect((await port.request("GET", `stay/${ADM}`, PROV)).kind).toBe("response");
    expect(await port.request("GET", `stay/${ADM}`, PROV)).toEqual({ kind: "network_error", reason: "paced" });
    expect(calls).toHaveLength(1);
  });
});

describe("the hints sent to the ear carry the profile's drug and test words", () => {
  it("after the patient's own words and the staff names", async () => {
    const { f } = fakeFetch([() => json(200, { name: "Test Patient", visitId: VISIT, ward: "Ward A" })]);
    const port = new PisgahPort(profile(), { bearers: { [OWNER]: "b" }, fetch: f, budget: null });
    const l = new ListenSessions({ port, listenContext: port.resolve.bind(port) } as unknown as EmrRuntime, { transcribe: async () => { throw new Error("no ear here"); }, staff: ["Dr Test"] });
    const hints = await l.hintsFor(OWNER, { admission_id: ADM }, "s-0000aaaa", Date.parse(PROV.spoken_at));
    expect(hints).toEqual(expect.arrayContaining(["oral paracetamol", "malaria parasite", "malaria test", "Dr Test", "Test Patient"]));
    expect(hints.indexOf("oral paracetamol")).toBeGreaterThan(hints.indexOf("Dr Test"));
  });
});

describe("resolving an admission learns its visit, so results fire for a ward-opened patient", () => {
  it("resolve(admission) returns the visit and resultsFor reads that visit's orders", async () => {
    const { f, calls } = fakeFetch([
      () => json(200, { name: "Test Patient", visitId: VISIT, ward: "Ward A" }),
      () => json(200, { orders: [{ stateId: ORDER, label: "Malaria parasite", orderStatus: "RESULT_UPLOADED" }] })
    ]);
    const port = new PisgahPort(profile(), { bearers: { [OWNER]: "b" }, fetch: f, budget: null });
    const ctx = await port.resolve({ admission_id: ADM }, PROV);
    expect(ctx.visit_id).toBe(VISIT);
    const rows = await port.orderResults!(OWNER, { admission_id: ADM }, PROV);
    expect(rows).toEqual([{ id: ORDER, test: "malaria_parasite", state: "RESULT_UPLOADED" }]);
    expect(calls[1]!.url).toContain(`visitId=${VISIT}`);
  });

  it("negative control: a profile without the visit path learns nothing and reads no orders", async () => {
    const { f, calls } = fakeFetch([() => json(200, { name: "Test Patient", visitId: VISIT, ward: "Ward A" })]);
    const p = profile();
    const { visit: _drop, ...plain } = p.ops.read_admission;
    const port = new PisgahPort({ ...p, ops: { ...p.ops, read_admission: plain } }, { bearers: { [OWNER]: "b" }, fetch: f, budget: null });
    expect((await port.resolve({ admission_id: ADM }, PROV)).visit_id).toBeNull();
    expect(await port.orderResults!(OWNER, { admission_id: ADM }, PROV)).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("the serve can pick a second Spark Open route by name once its key exists", () => {
  it("names only a route whose key is set", () => {
    expect(secondSparkRoute("baseten", { BASETEN_API_KEY: "x" })).toEqual({ provider: "baseten", model: "meta-models/muse-spark-open" });
    expect(secondSparkRoute("fireworks", { FIREWORKS_API_KEY: "x" })).toEqual({ provider: "fireworks", model: "accounts/fireworks/models/muse-spark-open" });
    expect(secondSparkRoute("baseten", {})).toBeNull();
    expect(secondSparkRoute("meta", { MODEL_API_KEY: "x" })).toBeNull();
    expect(secondSparkRoute(undefined, { BASETEN_API_KEY: "x" })).toBeNull();
  });

  it("a forced Modal error with the second route configured lands on it (fake fetch, no paid call)", async () => {
    const seen: string[] = [];
    const server = createServer(async (req, res) => {
      for await (const _ of req) { /* drain */ }
      seen.push(req.url ?? "");
      if ((req.url ?? "").startsWith("/modal")) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "down" } })); return; }
      const args = { clauses: [{ words: "pulse eighty", class: "instruction", kind: "record_observation", pulse: 80, confidence: 0.95 }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "r-1", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "gate", arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const root = mkdtempSync(join(tmpdir(), "hp-adapt-"));
      const keys = { MODAL_ENDPOINT_URL: `${base}/modal`, MODAL_PROXY_TOKEN_ID: "id", MODAL_PROXY_TOKEN_SECRET: "secret", BASETEN_API_KEY: "fake" };
      const client = new ModelClient({ storeRoot: root, mode: "live", keys, record: false, baseURLOverride: { modal: `${base}/modal`, baseten: `${base}/baseten` } });
      const second = secondSparkRoute("baseten", keys)!;
      const input = { kinds: ["record_observation"], names: { page_targets: {}, clinics: {}, wards: {} }, today: "2026-10-31", openQuestion: null, recent: [], said: "pulse eighty", context: { admission_id: ADM, patient_id: PAT, label: "Test Patient", facts: {}, keywords: [] }, actions: [] };
      const r = await gateUtterance(client, input as never, { run_id: "run-adapt000", task_id: "t-adapt000" }, { ...GATE_SETTINGS, fallback: second });
      expect(r).toMatchObject({ provider: "baseten", model: "meta-models/muse-spark-open", fallback_reason: "modal_provider_error" });
      expect(seen.map((u) => u.split("/")[1])).toEqual(["modal", "baseten"]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// Coordinator smoke, 1 Nov: the hospital's reason for a refused write reaches the runtime so the owner's strip can say why.
describe("a refused write carries the hospital's own reason", () => {
  it("keeps a short plain error message and nothing when the hospital gives none", async () => {
    const said = fakeFetch([() => json(409, { error: { code: "conflict", retryable: false, message: "Record the patient's vitals before assigning.   Missing temperature." } })]);
    const port = new PisgahPort(profile(), { bearers: { [OWNER]: "b" }, fetch: said.f, budget: null });
    expect(await port.commit("record_observation", { admission_id: ADM, pulse: 80 }, "k".repeat(64), PROV)).toMatchObject({ ok: false, reason: "door_409_conflict", message: "Record the patient's vitals before assigning. Missing temperature." });
    const bare = fakeFetch([() => json(409, { error: { code: "conflict" } })]);
    const quiet = new PisgahPort(profile(), { bearers: { [OWNER]: "b" }, fetch: bare.f, budget: null });
    expect(await quiet.commit("record_observation", { admission_id: ADM, pulse: 80 }, "k".repeat(64), PROV)).not.toHaveProperty("message");
  });
});
