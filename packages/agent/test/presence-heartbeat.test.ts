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
    const { key } = r.beats.open(DOC, "s1");
    expect(r.beat("s1", key, 0)).toEqual({ ok: true, present: true });
    expect(r.beat("s1", key, 0)).toEqual({ ok: false, reason: "stale_seq" });
    expect(r.beat("s1", r.beats.open(DOC, "other").key, 1)).toEqual({ ok: false, reason: "bad_mac" });
    expect(r.beat("s1", key, 2, { at: r.clock.now - 60_000 })).toEqual({ ok: false, reason: "clock_skew" });
    expect(r.beat("nobody", key, 0)).toEqual({ ok: false, reason: "unknown_session" });
    expect(r.beat("s1", key, 3, { visible: false })).toEqual({ ok: true, present: false, reason: "page_hidden" });
  });

  it("counts a session only while it beats and the owner's own voice was matched in it within N minutes", () => {
    const r = rig();
    const { key } = r.beats.open(DOC, "s1");
    r.beat("s1", key, 0);
    r.clock.now += HEARTBEAT_RULE.fresh_ms + 1;
    expect(r.beats.present(DOC, "s1")).toEqual({ live: false, reason: "no_heartbeat" });
    r.beat("s1", key, 1);
    expect(r.beats.present(DOC, "s1")).toEqual({ live: true });
    r.clock.now += HEARTBEAT_RULE.owner_voice_ms;
    r.beat("s1", key, 2);
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
    const { key } = r.beats.open(DOC, "s1");
    r.beat("s1", key, 0);
    expect(await refusal(r.chunk("s1", 1, tone(1000, 220)))).toBe("accepted");
    expect(r.frame("s1", tone(1000, 230))).toBe("accepted");
    // A remote feed under another session id has no key, so it never beats.
    expect(await refusal(r.chunk("remote", 0, tone(1000, 240)))).toBe("no_presence");
    await r.rt.stop();
  });
});
