import { createServer, type IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { DoorProfile, fillPath, fillTemplate, pathPattern } from "../src/profile.js";
import { PisgahPort, type DoorLog } from "../src/port.js";

const ADM = "11111111-2222-4333-8444-555555555555";
const EPI = "22222222-3333-4444-8555-666666666666";
const PAT = "33333333-4444-4555-8666-777777777777";
const OWNER = "44444444-5555-4666-8777-888888888888";
const PROV = { owner: OWNER, evidence: "transcript:u-0000aaaa", spoken_at: "2026-10-28T09:00:00.000Z" };

type Seen = { method: string; path: string; headers: IncomingMessage["headers"]; body: unknown };
// A stand-in door: one read, one write, idempotency by key with replay, and a switch to lose the first reply.
async function fakeDoor(opts: { loseFirstReply?: boolean } = {}) {
  const seen: Seen[] = [];
  const stored = new Map<string, { id: string; body: any }>();
  let latest: any = null;
  let lose = opts.loseFirstReply ?? false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    const path = (req.url ?? "").replace(/^\/door\/v9\//, "");
    seen.push({ method: req.method ?? "", path, headers: req.headers, body });
    const send = (status: number, j: unknown, h: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...h }); res.end(JSON.stringify(j)); };
    if (req.method === "GET" && path === "ward/list") return send(200, { rows: [{ adm: ADM, who: "Test Patient" }, { adm: "not-an-id", who: "x" }] });
    if (req.method === "GET" && path === `ward/${ADM}`) return send(200, { name: "Test Patient", ward: "Ward A", latest: latest ? { t: latest.values.t ?? null, p: latest.values.p === undefined ? null : String(latest.values.p), bp: latest.values.bp ?? null } : null });
    if (req.method === "POST" && path === "ward/entry") {
      const key = String(req.headers["x-door-key"]);
      const hit = stored.get(key);
      if (hit) return send(200, { ok: true, writes: [{ store: "obs", id: hit.id }, { store: "note", id: `n-${hit.id}` }] }, { "x-door-replayed": "true" });
      const id = `55555555-6666-4777-8888-${String(stored.size + 1).padStart(12, "0")}`;
      stored.set(key, { id, body });
      latest = body;
      if (lose) { lose = false; res.destroy(); return; }
      return send(200, { ok: true, writes: [{ store: "obs", id }, { store: "note", id: `n-${id}` }] });
    }
    send(404, { error: { code: "not_found_opaque" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { seen, stored, base: `http://127.0.0.1:${port}/door/v9`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const profile = (base: string) => DoorProfile.parse({
  base_url: base, timeout_ms: 2000,
  headers: { on_behalf_of: "X-Door-For", origin: "X-Door-Origin", evidence: "X-Door-Evidence", spoken_at: "X-Door-Spoken", idempotency: "X-Door-Key", replayed: "X-Door-Replayed" },
  origin_value: "voice",
  deny: ["ward/close", "ward/pay", "ward/entry/void"],
  ops: {
    read_admission: { method: "GET", path: "ward/{admission_id}", label: "name", facts: { ward: "ward", pulse: "latest.p" }, proof: { temp_c: "latest.t", pulse: "latest.p", bp: "latest.bp" } },
    write_observation: { method: "POST", path: "ward/entry", body: { episode: "$episode_id", kind: "obs", values: { t: "$temp_c", p: "$pulse", bp: "$bp", note: "$remarks" } }, writes_path: "writes", primary_store: "obs" },
    census: { method: "GET", path: "ward/list", list_path: "rows", admission_path: "adm", label_path: "who" }
  },
  targets: { admission_by_patient: { [PAT]: ADM }, episode_by_admission: { [ADM]: EPI } },
  vocabulary: ["pulse"]
});

describe("PisgahPort", () => {
  it("carries the bearer and every provenance header on reads and writes, and the key on writes only", async () => {
    const door = await fakeDoor();
    const logs: DoorLog[] = [];
    const port = new PisgahPort(profile(door.base), { bearers: { [OWNER]: "agent-token-1" }, onRequest: (l) => logs.push(l) });
    const ctx = await port.resolve({ patient_id: PAT }, PROV);
    expect(ctx).toMatchObject({ admission_id: ADM, patient_id: PAT, label: "Test Patient", facts: { ward: "Ward A", pulse: null } });
    expect(ctx.keywords).toEqual(["Test Patient", "Ward A", "pulse"]);
    const c = await port.commit("record_observation", { admission_id: ADM, temp_c: "37.8", pulse: 92 }, "k".repeat(64), PROV);
    expect(c).toEqual({ ok: true, record_id: "55555555-6666-4777-8888-000000000001", record_version: 1, event_ids: ["obs:55555555-6666-4777-8888-000000000001", "note:n-55555555-6666-4777-8888-000000000001"], replayed: false });
    for (const s of door.seen) {
      expect(s.headers["authorization"]).toBe("Bearer agent-token-1");
      expect(s.headers["x-door-for"]).toBe(OWNER);
      expect(s.headers["x-door-origin"]).toBe("voice");
      expect(s.headers["x-door-evidence"]).toBe("transcript:u-0000aaaa");
      expect(s.headers["x-door-spoken"]).toBe("2026-10-28T09:00:00.000Z");
    }
    expect(door.seen[0]!.headers["x-door-key"]).toBeUndefined();
    expect(door.seen[1]!.headers["x-door-key"]).toBe("k".repeat(64));
    expect(door.seen[1]!.body).toEqual({ episode: EPI, kind: "obs", values: { t: "37.8", p: 92 } });
    expect(logs.every((l) => l.headers["authorization"] === undefined || l.headers["authorization"] === "Bearer <redacted>")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("agent-token-1");
    const proof = await port.prove("record_observation", { admission_id: ADM, temp_c: "37.8", pulse: 92 }, { record_id: c.ok ? c.record_id : "", record_version: 1, event_ids: [] }, PROV);
    expect(proof).toMatchObject({ record_id: "55555555-6666-4777-8888-000000000001", record_version: 1, read: "fresh admission read shows temp_c, pulse as written" });
    expect(await port.prove("record_observation", { admission_id: ADM, pulse: 93 }, { record_id: "x", record_version: 1, event_ids: [] }, PROV)).toBeNull();
    expect(port.refusedCount()).toBe(0);
    await door.close();
  });

  it("refuses denied, unlisted and owner-less calls before the network, and counts each", async () => {
    const door = await fakeDoor();
    const port = new PisgahPort(profile(door.base), { bearers: { [OWNER]: "agent-token-1" } });
    expect(await port.request("POST", "ward/close", PROV, { body: {} })).toEqual({ kind: "refused", reason: "denied_path" });
    expect(await port.request("POST", "/ward/pay/", PROV, { body: {} })).toEqual({ kind: "refused", reason: "denied_path" });
    expect(await port.request("POST", "ward/entry/void", PROV, { body: {} })).toEqual({ kind: "refused", reason: "denied_path" });
    expect(await port.request("GET", "ward/census", PROV)).toEqual({ kind: "refused", reason: "not_allowlisted" });
    expect(await port.request("POST", `ward/${ADM}`, PROV, { body: {} })).toEqual({ kind: "refused", reason: "not_allowlisted" });
    expect(await port.request("GET", `ward/${ADM}/../close`, PROV)).toEqual({ kind: "refused", reason: "not_allowlisted" });
    expect(await port.request("GET", `ward/${ADM}`, { ...PROV, owner: "someone-else" })).toEqual({ kind: "refused", reason: "no_bearer_for_owner" });
    expect(await port.request("GET", `ward/${ADM}`, { ...PROV, evidence: "bad evidence!" })).toEqual({ kind: "refused", reason: "bad_header" });
    expect(port.refusedCount()).toBe(8);
    expect(door.seen).toHaveLength(0);
    expect(() => new PisgahPort({ ...profile(door.base), deny: ["ward/entry"] }, { bearers: {} })).toThrow(/allows a denied path/);
    await door.close();
  });

  it("maps door answers: 5xx and lost replies are retryable, 4xx are not, and the key replays", async () => {
    const door = await fakeDoor({ loseFirstReply: true });
    const port = new PisgahPort(profile(door.base), { bearers: { [OWNER]: "t" } });
    const args = { admission_id: ADM, pulse: 88, corrects_record_id: "55555555-6666-4777-8888-000000000009" };
    const first = await port.commit("record_observation", args, "key-1", PROV);
    expect(first).toMatchObject({ ok: false, retryable: true });
    const again = await port.commit("record_observation", args, "key-1", PROV);
    expect(again).toMatchObject({ ok: true, replayed: true, record_id: "55555555-6666-4777-8888-000000000001" });
    expect(door.stored.size).toBe(1);
    expect([...door.stored.values()][0]!.body.values).toEqual({ p: 88, note: "Corrects entry 55555555-6666-4777-8888-000000000009." });
    const other = new PisgahPort({ ...profile(door.base), targets: { admission_by_patient: {}, episode_by_admission: {} } }, { bearers: { [OWNER]: "t" } });
    expect(await other.commit("record_observation", { admission_id: ADM, pulse: 1 } as never, "key-2", PROV)).toMatchObject({ ok: false, reason: "invalid_arguments" });
    expect(await other.commit("record_observation", { admission_id: ADM, pulse: 60 }, "key-2", PROV)).toMatchObject({ ok: false, reason: "no_episode_for_admission" });
    await expect(other.resolve({ patient_id: PAT }, PROV)).rejects.toMatchObject({ code: "unknown_target" });
    const looked: string[] = [];
    const found = new PisgahPort({ ...profile(door.base), targets: { admission_by_patient: {}, episode_by_admission: {} } }, { bearers: { [OWNER]: "t" }, episodeFor: async (a) => { looked.push(a); return EPI; } });
    expect(await found.census(PROV)).toEqual([{ admission_id: ADM, label: "Test Patient" }]);
    expect(await found.commit("record_observation", { admission_id: ADM, pulse: 61 }, "key-4", PROV)).toMatchObject({ ok: true, replayed: false });
    expect(looked).toEqual([ADM]);
    await door.close();
    const gone = await port.commit("record_observation", { admission_id: ADM, pulse: 60 }, "key-3", PROV);
    expect(gone).toMatchObject({ ok: false, retryable: true, reason: "unreachable" });
  });
});

describe("profile helpers", () => {
  it("fills templates and paths and refuses a path value that is not an id", () => {
    expect(fillTemplate({ a: "$x", b: { c: "$y", d: "lit" }, e: ["$x", "$z"] }, { x: 1, y: undefined })).toEqual({ a: 1, b: { d: "lit" }, e: [1] });
    expect(fillPath("ward/{admission_id}", { admission_id: ADM })).toBe(`ward/${ADM}`);
    expect(() => fillPath("ward/{admission_id}", { admission_id: "../pay" })).toThrow(/not an id/);
    expect(pathPattern("ward/{admission_id}").test(`ward/${ADM}`)).toBe(true);
    expect(pathPattern("ward/{admission_id}").test("ward/x")).toBe(false);
  });
});
