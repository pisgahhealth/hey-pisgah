import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startEmrServe } from "../src/emr/serve.js";
import { EmrRuntime } from "../src/emr/runtime.js";
import { STRIP_TOKEN_MAX_MS, bearerOf, serveConfigFromEnv, signStripToken, verifyStripToken } from "../src/emr/strip-token.js";
import { loopbackHost } from "../src/emr/serve.js";
import { ADM, FakeEmr, OWNER, emrRoot, mockClient, until } from "./emr-helpers.js";

const KEY = randomBytes(32).toString("base64url");
const OTHER_KEY = randomBytes(32).toString("base64url");
const HOSPITAL = "hospital-1";
const STRIP = "http://localhost:3311";
const NOW = Date.UTC(2026, 10, 1, 9, 0, 0);
const tokenFor = (owner: string, o: { key?: string; hospital?: string; iat?: number; exp?: number } = {}) => {
  const iat = o.iat ?? Date.now();
  return signStripToken(o.key ?? KEY, { owner, hospital: o.hospital ?? HOSPITAL, iat, exp: o.exp ?? iat + 5 * 60_000 });
};

async function boot() {
  const root = emrRoot();
  const port = new FakeEmr();
  let rt: EmrRuntime | null = null;
  const client = mockClient(root, () => ({ decision: "record", pulse: 88, summary: "Record" }), () => rt?.stateOf ?? null);
  const s = await startEmrServe({ storeRoot: root, port, client, listenPort: 0, runtime: { holdMs: 0, proofRetryMs: 1 }, strip: { mode: "token", key: KEY, hospital: HOSPITAL }, preferences: true, transcribe: async (_w, _k, sid) => ({ final: true, text: "", audio_ms: 0, session_id: sid, cost_usd: 0 }) });
  rt = s.runtime;
  const call = (path: string, o: { token?: string | null; body?: unknown; method?: string } = {}) => fetch(`${s.url}${path}`, {
    method: o.method ?? (o.body === undefined ? "GET" : "POST"),
    headers: { origin: STRIP, ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {})
  });
  return { s, port, call };
}

describe("the strip token (SEC H3): the serve takes calls only from its own strip", () => {
  it("verifies signature, audience, hospital, life and expiry, and reads nothing from an unsigned token", () => {
    const t = signStripToken(KEY, { owner: OWNER, hospital: HOSPITAL, iat: NOW, exp: NOW + 300_000 });
    expect(verifyStripToken(KEY, HOSPITAL, t, NOW + 1000)).toEqual({ ok: true, owner: OWNER, hospital: HOSPITAL, exp: NOW + 300_000 });
    expect(verifyStripToken(KEY, HOSPITAL, undefined, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(verifyStripToken(KEY, HOSPITAL, "v1.abc", NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyStripToken(OTHER_KEY, HOSPITAL, t, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    // A changed claim with the old signature is refused before the claim is read.
    const [v, body, mac] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), sub: "someone-else" })).toString("base64url");
    expect(verifyStripToken(KEY, HOSPITAL, `${v}.${forged}.${mac}`, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyStripToken(KEY, "hospital-2", t, NOW)).toEqual({ ok: false, reason: "wrong_hospital" });
    expect(verifyStripToken(KEY, HOSPITAL, t, NOW + 300_000)).toEqual({ ok: false, reason: "expired" });
    expect(verifyStripToken(KEY, HOSPITAL, signStripToken(KEY, { owner: OWNER, hospital: HOSPITAL, iat: NOW, exp: NOW + STRIP_TOKEN_MAX_MS + 1 }), NOW)).toEqual({ ok: false, reason: "too_long" });
    expect(verifyStripToken(KEY, HOSPITAL, signStripToken(KEY, { owner: OWNER, hospital: HOSPITAL, iat: NOW + 60_000, exp: NOW + 120_000 }), NOW)).toEqual({ ok: false, reason: "not_yet_valid" });
    expect(bearerOf("Bearer abc")).toBe("abc");
    expect(bearerOf("Basic abc")).toBeUndefined();
  });

  it("refuses every owner call without a token, with an expired one or with another owner's, and serves the owner's own", async () => {
    const { s, call } = await boot();
    try {
      const mine = tokenFor(OWNER), theirs = tokenFor("owner-2");
      const said = await call("/tasks/say", { token: mine, body: { owner: OWNER, admissionId: ADM, text: "Chart pulse 88" } });
      expect(said.status).toBe(202);
      const id = ((await said.json()) as { task_id: string }).task_id;
      await until(() => s.runtime.view(id)!.actions.length === 1);
      const owned = [
        `/tasks?owner=${OWNER}`, `/tasks/${id}`, `/tasks/tracking?owner=${OWNER}`, `/tasks/listen?owner=${OWNER}&session_id=s1`, `/preferences?owner=${OWNER}`, `/wake?owner=${OWNER}`
      ];
      for (const path of owned) {
        expect([path, (await call(path)).status]).toEqual([path, 401]);
        expect([path, (await call(path, { token: tokenFor(OWNER, { iat: Date.now() - 600_000, exp: Date.now() - 1 }) })).status]).toEqual([path, 401]);
        expect([path, (await call(path, { token: tokenFor(OWNER, { key: OTHER_KEY }) })).status]).toEqual([path, 401]);
        expect([path, (await call(path, { token: tokenFor(OWNER, { hospital: "hospital-2" }) })).status]).toEqual([path, 401]);
        expect([path, (await call(path, { token: theirs })).status]).toEqual([path, 401]);
        expect([path, (await call(path, { token: mine })).status]).toEqual([path, 200]);
      }
      const posts: [string, unknown][] = [
        ["/tasks/say", { owner: OWNER, admissionId: ADM, text: "Chart pulse 90" }], [`/tasks/${id}/say`, { text: "Chart pulse 91" }], [`/tasks/${id}/interrupt`, {}],
        ["/tasks/watch", { owner: OWNER, admissionId: ADM }], ["/tasks/presence/open", { owner: OWNER, session_id: "s1" }], ["/tasks/emergency", { owner: OWNER, spokenAt: new Date().toISOString() }],
        ["/preferences/external", { owner: OWNER, text: "Always chart the pulse", scope: "everyone" }]
      ];
      for (const [path, body] of posts) {
        expect([path, (await call(path, { body })).status]).toEqual([path, 401]);
        expect([path, (await call(path, { body, token: theirs })).status]).toEqual([path, 401]);
      }
      const audio = new FormData();
      audio.append("owner", OWNER);
      audio.append("session_id", "s1");
      audio.append("seq", "0");
      audio.append("end", "1");
      expect((await fetch(`${s.url}/tasks/listen`, { method: "POST", body: audio, headers: { origin: STRIP, authorization: `Bearer ${theirs}` } })).status).toBe(401);
      expect((await fetch(`${s.url}/tasks/listen/stream?owner=${OWNER}&session_id=s1&rate=16000&stream=0&part=0`, { method: "POST", body: new Uint8Array(4), headers: { origin: STRIP, "content-type": "audio/pcm" } })).status).toBe(401);
      // The other owner's token sees only that owner's own empty list, never this owner's task.
      expect(await (await call("/tasks?owner=owner-2", { token: theirs })).json()).toEqual([]);
      const pre = await fetch(`${s.url}/tasks?owner=${OWNER}`, { method: "OPTIONS", headers: { origin: STRIP, "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
      expect([pre.status, pre.headers.get("access-control-allow-headers")]).toEqual([204, "Content-Type, Authorization"]);
      const health = (await (await call("/health")).json()) as { strip: string };
      expect(health.strip).toBe("token");
    } finally { await s.close(); }
  });

  it("starts open only on the explicit development switch, says so in health, and never binds off loopback without the key", async () => {
    expect(() => serveConfigFromEnv({})).toThrow(/HEY_PISGAH_STRIP_OPEN=1/);
    expect(() => serveConfigFromEnv({ HEY_PISGAH_STRIP_KEY: KEY })).toThrow(/HEY_PISGAH_STRIP_HOSPITAL/);
    expect(() => serveConfigFromEnv({ HEY_PISGAH_STRIP_KEY: "short", HEY_PISGAH_STRIP_HOSPITAL: HOSPITAL })).toThrow(/32 bytes/);
    expect(() => serveConfigFromEnv({ HEY_PISGAH_STRIP_OPEN: "1", HEY_PISGAH_SERVE_HOSTS: "0.0.0.0" })).toThrow(/off loopback/);
    expect(serveConfigFromEnv({ HEY_PISGAH_STRIP_OPEN: "1" })).toEqual({ strip: { mode: "open" }, hosts: ["127.0.0.1", "::1"] });
    expect(serveConfigFromEnv({ HEY_PISGAH_STRIP_KEY: KEY, HEY_PISGAH_STRIP_HOSPITAL: HOSPITAL, HEY_PISGAH_SERVE_HOSTS: "10.0.0.5", HEY_PISGAH_STRIP_ORIGIN: "https://emr.example.org", HEY_PISGAH_SERVE_HOSTNAMES: "agent.example.org" }))
      .toEqual({ strip: { mode: "token", key: KEY, hospital: HOSPITAL }, hosts: ["10.0.0.5"], allowOrigin: "https://emr.example.org", hostNames: ["agent.example.org"] });
    expect(loopbackHost("agent.example.org:4100", ["agent.example.org"])).toBe(true);
    expect(loopbackHost("agent.example.org.evil.test", ["agent.example.org"])).toBe(false);
    expect(loopbackHost("agent.example.org", [])).toBe(false);
    const root = emrRoot();
    // A start that names no strip mode is refused, so no caller gets the open serve by leaving an option out.
    await expect(startEmrServe({ storeRoot: root, port: new FakeEmr(), client: mockClient(root, () => ({ decision: "aside", summary: "x" }), () => null), listenPort: 0 } as unknown as Parameters<typeof startEmrServe>[0])).rejects.toThrow(/strip/);
    await expect(startEmrServe({ storeRoot: root, port: new FakeEmr(), client: mockClient(root, () => ({ decision: "aside", summary: "x" }), () => null), listenPort: 0, strip: { mode: "token", key: "", hospital: HOSPITAL } })).rejects.toThrow(/32 bytes/);
    const s = await startEmrServe({ storeRoot: root, port: new FakeEmr(), client: mockClient(root, () => ({ decision: "aside", summary: "x" }), () => null), listenPort: 0, strip: { mode: "open" } });
    try {
      const health = (await (await fetch(`${s.url}/health`)).json()) as { strip: string };
      expect(health.strip).toMatch(/^open: development only/);
      expect((await fetch(`${s.url}/tasks?owner=${OWNER}`)).status).toBe(200);
    } finally { await s.close(); }
  });
});
