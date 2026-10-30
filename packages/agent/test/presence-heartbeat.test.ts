import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav, type FinalTranscript } from "@hey-pisgah/voice";
import { ListenError, ListenSessions } from "../src/emr/listen.js";
import { HEARTBEAT_RULE, Heartbeats, beatMac, type Beat } from "../src/emr/presence.js";
import { StreamListener, StreamRefused } from "../src/emr/stream-listen.js";
import type { StreamAsr } from "../src/emr/local-ears.js";
import { ADMIT, DOC, clerkBoot } from "./clerking-helpers.js";
import { RATE } from "./mic-helpers.js";

const tone = (ms: number, hz = 220) => { const a = new Float32Array((ms * RATE) / 1000); for (let i = 0; i < a.length; i++) a[i] = 0.3 * Math.sin((2 * Math.PI * hz * i) / RATE); return a; };
const quietEar: StreamAsr = { model: "local:quiet", transcribe: async (_w, _k, sid): Promise<FinalTranscript> => ({ final: true, text: "", audio_ms: 0, session_id: sid, cost_usd: 0 }), open: () => ({ accept: () => undefined, text: () => "", finish: () => "" }) };

function rig(o: { presence?: "heartbeat"; clock?: { now: number } } = {}) {
  const clock = o.clock ?? { now: Date.now() };
  const beats = new Heartbeats(HEARTBEAT_RULE, () => clock.now);
  const { rt } = clerkBoot(() => []);
  const listen = new ListenSessions(rt, { transcribe: async (_w, _k, sid) => ({ final: true, text: "", audio_ms: 0, session_id: sid, cost_usd: 0 }), replay: "refuse", now: () => clock.now, ...(o.presence ? { presence: o.presence, heartbeat: (owner, sid) => beats.present(owner, sid) } : {}) });
  const frames = new StreamListener(listen, quietEar, { now: () => clock.now });
  const chunk = (session: string, seq: number, x: Float32Array) => listen.chunk({ owner: DOC, target: { admission_id: ADMIT }, session_id: session, seq, wav: encodeWav(x, RATE), arrived_at: clock.now }, true);
  // Opens a frames stream, feeds its pieces at the clock's time, and answers the first refusal.
  const frame = (session: string, ...xs: Float32Array[]) => { frames.open({ owner: DOC, target: { admission_id: ADMIT }, session_id: session, rate: RATE }); try { for (const x of xs) frames.feed(session, x); return "accepted"; } catch (e) { return e instanceof StreamRefused ? e.reason : String(e); } finally { void frames.end(session); } };
  const beat = (session: string, key: string, seq: number, more: Partial<Beat> = {}) => { const b = { owner: DOC, session_id: session, seq, at: clock.now, visible: true, mic_live: true, ...more }; return beats.beat({ ...b, mac: more.mac ?? beatMac(key, b) }); };
  return { rt, listen, chunk, frame, beats, beat, clock };
}
const refusal = async (p: Promise<unknown>) => { try { await p; return "accepted"; } catch (e) { return e instanceof ListenError ? e.message.replace("replayed audio refused: ", "") : String(e); } };

describe("one live check for chunks and frames, and the hands-free heartbeat (D30)", () => {
  it("accepts a beat only with its session's key, a forward sequence and a near clock", () => {
    const r = rig();
    const { key } = r.beats.open(DOC, "s1")!;
    expect(r.beat("s1", key, 0)).toEqual({ ok: true, present: true });
    expect(r.beat("s1", key, 0)).toEqual({ ok: false, reason: "stale_seq" });
    expect(r.beat("s1", r.beats.open(DOC, "other")!.key, 1)).toEqual({ ok: false, reason: "bad_mac" });
    // A session still beating keeps its key: another opener cannot take it over.
    expect(r.beats.open(DOC, "s1")).toBeNull();
    expect(r.beat("s1", key, 2, { at: r.clock.now - 60_000 })).toEqual({ ok: false, reason: "clock_skew" });
    expect(r.beat("nobody", key, 0)).toEqual({ ok: false, reason: "unknown_session" });
    expect(r.beat("s1", key, 3, { visible: false })).toEqual({ ok: true, present: false, reason: "page_hidden" });
  });

  it("counts a session only while it beats and the owner's own voice was matched in it within N minutes", () => {
    const r = rig();
    const { key } = r.beats.open(DOC, "s1")!;
    r.beat("s1", key, 0);
    r.clock.now += HEARTBEAT_RULE.fresh_ms + 1;
    expect(r.beats.present(DOC, "s1")).toEqual({ live: false, reason: "no_heartbeat" });
    r.beat("s1", key, 1);
    expect(r.beats.present(DOC, "s1")).toEqual({ live: true });
    r.clock.now += HEARTBEAT_RULE.owner_voice_ms;
    r.beat("s1", key, 2);
    expect(r.beats.present(DOC, "s1")).toEqual({ live: false, reason: "no_recent_owner_voice" });
    // Reopening after the beat lapses does not reset the owner-voice clock.
    r.clock.now += HEARTBEAT_RULE.fresh_ms + 1;
    const again = r.beats.open(DOC, "s1")!;
    r.beat("s1", again.key, 0);
    expect(r.beats.present(DOC, "s1")).toEqual({ live: false, reason: "no_recent_owner_voice" });
    r.beats.ownerVoice(DOC, "s1");
    expect(r.beats.present(DOC, "s1")).toEqual({ live: true });
  });

  it("refuses on the frames path what it refuses on the chunk path: a copy, audio faster than one person speaks", async () => {
    const r = rig();
    const x = tone(2000);
    expect(await refusal(r.chunk("c1", 0, x))).toBe("accepted");
    // The same speech again, now as 16-bit frames in another session, is a copy.
    expect(r.frame("f1", decodeWav(encodeWav(x, RATE)).samples)).toBe("replayed_chunk");
    // Pieces of audio arriving together run ahead of the owner's one voice, on either path, and the chunks' clock counts against the frames.
    expect(r.frame("f2", ...Array.from({ length: 3 }, (_, i) => tone(2000, 300 + i)))).toBe("faster_than_live");
    r.clock.now += 120_000;
    expect(await refusal(r.chunk("c2", 0, tone(2000, 400)))).toBe("accepted");
    expect(r.frame("f3", tone(2000, 410), tone(2000, 420))).toBe("faster_than_live");
    r.clock.now += 120_000;
    expect(r.frame("f4", tone(2000, 430))).toBe("accepted");
    const rest = [];
    for (let i = 1; i < 4; i++) rest.push(await refusal(r.chunk("c3", i, tone(2000, 440 + i))));
    expect(rest).toContain("faster_than_live");
    await r.rt.stop();
  });

  it("with heartbeat presence, refuses chunks and frames from a session that does not beat, and takes both once it does", async () => {
    const r = rig({ presence: "heartbeat" });
    expect(await refusal(r.chunk("s1", 0, tone(1000, 200)))).toBe("no_presence");
    expect(r.frame("s1", tone(1000, 210))).toBe("no_presence");
    const { key } = r.beats.open(DOC, "s1")!;
    r.beat("s1", key, 0);
    expect(await refusal(r.chunk("s1", 1, tone(1000, 220)))).toBe("accepted");
    expect(r.frame("s1", tone(1000, 230))).toBe("accepted");
    // A remote feed under another session id has no key, so it never beats.
    expect(await refusal(r.chunk("remote", 0, tone(1000, 240)))).toBe("no_presence");
    await r.rt.stop();
  });
});

describe("the agent service's heartbeat routes and health", () => {
  it("names its presence mode in health, so the strip beats from listening start, and takes a signed beat over HTTP", async () => {
    const { ModelClient } = await import("@hey-pisgah/model");
    const { startEmrServe } = await import("../src/emr/serve.js");
    const { FakeEmr, emrRoot } = await import("./emr-helpers.js");
    const boot = async (presence?: "heartbeat") => {
      const root = emrRoot();
      const client = new ModelClient({ storeRoot: root, mode: "mock", mock: () => { throw new Error("no model call"); } });
      return startEmrServe({ storeRoot: root, port: new FakeEmr(), client, listenPort: 0, preferences: false, ears: "off", runtime: { holdMs: 0 }, ...(presence ? { listen: { presence } } : {}) });
    };
    const STRIP = "http://localhost:3311";
    const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: STRIP }, body: JSON.stringify(body) });
    const plain = await boot();
    const s = await boot("heartbeat");
    try {
      expect(((await (await fetch(`${plain.url}/health`)).json()) as { presence: string }).presence).toBe("observed");
      expect(((await (await fetch(`${s.url}/health`)).json()) as { presence: string }).presence).toBe("heartbeat");
      const opened = (await (await post(`${s.url}/tasks/presence/open`, { owner: DOC, session_id: "strip-1" })).json()) as { key: string; beat_ms: number };
      expect(opened.beat_ms).toBe(HEARTBEAT_RULE.beat_ms);
      const b = { session_id: "strip-1", seq: 0, at: Date.now(), visible: true, mic_live: true };
      const ok = await post(`${s.url}/tasks/presence/beat`, { owner: DOC, ...b, mac: beatMac(opened.key, b) });
      expect([ok.status, await ok.json()]).toEqual([200, { session_id: "strip-1", present: true }]);
      // Negative control: a beat signed with another key is refused and asks for nothing new.
      const bad = await post(`${s.url}/tasks/presence/beat`, { owner: DOC, ...b, seq: 1, mac: beatMac("A".repeat(43), { ...b, seq: 1 }) });
      expect([bad.status, ((await bad.json()) as { error: string }).error]).toEqual([409, "bad_mac"]);
    } finally {
      await s.close();
      await plain.close();
    }
  });
});

describe("the push-to-talk route runs the same live check", () => {
  it("refuses the same recording sent twice, and a recording in heartbeat mode with no beat", async () => {
    const { ModelClient } = await import("@hey-pisgah/model");
    const { startEmrServe } = await import("../src/emr/serve.js");
    const { ADM, FakeEmr, OWNER, emrRoot } = await import("./emr-helpers.js");
    const boot = async (presence?: "heartbeat") => {
      const root = emrRoot();
      const client = new ModelClient({ storeRoot: root, mode: "mock", mock: () => ({ content: [{ type: "text", text: "{}" }] } as never) });
      return startEmrServe({ storeRoot: root, port: new FakeEmr(), client, listenPort: 0, preferences: false, ears: "off", runtime: { holdMs: 0 }, listen: { replay: "refuse", ...(presence ? { presence } : {}) },
        transcribe: async (_w, _k, sid) => ({ final: true, text: "", audio_ms: 1000, session_id: sid, cost_usd: 0 }) });
    };
    const send = (url: string, wav: Uint8Array) => { const f = new FormData(); f.append("audio", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "say.wav"); f.append("owner", OWNER); f.append("admissionId", ADM); return fetch(`${url}/tasks/say-audio`, { method: "POST", body: f, headers: { origin: "http://localhost:3311" } }); };
    const wav = encodeWav(tone(1000, 250), RATE);
    const s = await boot();
    const h = await boot("heartbeat");
    try {
      expect((await send(s.url, wav)).status).toBe(200);
      const copy = await send(s.url, wav);
      expect([copy.status, ((await copy.json()) as { error: string }).error]).toEqual([409, "replayed audio refused: replayed_chunk"]);
      const absent = await send(h.url, encodeWav(tone(1000, 260), RATE));
      expect([absent.status, ((await absent.json()) as { error: string }).error]).toEqual([409, "replayed audio refused: no_presence"]);
    } finally {
      await s.close();
      await h.close();
    }
  });
});

