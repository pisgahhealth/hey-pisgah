import { describe, expect, it } from "vitest";
import { ORDER_REFERENCE_KINDS } from "../src/emr/gate.js";
import { ListenError, ListenSessions, type ListenChunk } from "../src/emr/listen.js";
import type { Orderables, Provenance } from "../src/emr/port.js";
import { PRESENCE_RULE, ReplayGuard, presenceOf, type LivenessMarker, type SpeakerVerdict, type Voiceprint } from "../src/emr/speaker.js";
import { encodeWav } from "@hey-pisgah/voice";
import { ADMIT, ClerkFake, DOC, clerkBoot, ins } from "./clerking-helpers.js";
import { RATE, earOf } from "./mic-helpers.js";

// A hospital whose voice match says "owner" for every voiceprint, as it would for a good recording of the owner played back.
class ReplayFake extends ClerkFake {
  readonly matched: string[] = [];
  override kindsFor(): readonly string[] { return [...ORDER_REFERENCE_KINDS]; }
  orderables(): Orderables { return { tests: { fbc: ["full blood count", "FBC"] }, drugs: {} }; }
  readonly speaker = async (_owner: string, _v: readonly number[], prov: Provenance): Promise<SpeakerVerdict> => {
    this.matched.push(prov.evidence);
    return { speaker: "owner", token: `v1.${String(1_761_700_000_000 + this.matched.length)}.${"A".repeat(43)}` };
  };
}

const PRINT: Voiceprint = { vector: [5], ms: 20, model: "nemo_en_titanet_small" };
const AT_SCREEN: LivenessMarker = { visible: true, mic_live: true, input_age_ms: 4000 };
const AWAY: LivenessMarker = { visible: true, mic_live: true, input_age_ms: 20 * 60_000 };
// One spoken order in three strip chunks, two capped and a last one with a quiet tail; the amplitude stands for one recording.
const clip = (amp: number) => {
  const part = (talkMs: number, quietMs: number, hz: number) => {
    const a = new Float32Array(((talkMs + quietMs) * RATE) / 1000);
    for (let i = 0; i < (talkMs * RATE) / 1000; i++) a[i] = amp * Math.sin((2 * Math.PI * hz * i) / RATE);
    return encodeWav(a, RATE);
  };
  return [part(6000, 0, 180), part(6000, 0, 210), part(1500, 700, 240)];
};

function rig(o: { replay?: "refuse" | "off"; presence?: "required" | "observed" } = {}) {
  const port = new ReplayFake();
  port.admitted = true;
  const { rt } = clerkBoot((s) => (s.includes("blood count") ? [ins("order_test", { test: "fbc" })] : []), { port });
  const heard: number[] = [];
  let embeds = 0;
  const listen = new ListenSessions(rt, {
    transcribe: earOf({ 14200: "Okay, let's get a full blood count." }, heard), embed: async () => { embeds += 1; return PRINT; },
    replay: o.replay ?? "refuse", presence: o.presence ?? "required"
  });
  // Posts a chunk sequence at the pace a live microphone delivers it, or all at once.
  const send = async (session: string, wavs: Uint8Array[], start: number, o2: { marker?: LivenessMarker | null; burst?: boolean; captured?: (i: number) => number } = {}) => {
    let at = start;
    for (const [i, wav] of wavs.entries()) {
      at += o2.burst ? 10 : Math.round(((wav.length - 44) / 2 / RATE) * 1000);
      const c: ListenChunk = { owner: DOC, target: { admission_id: ADMIT }, session_id: session, seq: i, wav, arrived_at: at, ...(o2.marker !== undefined ? { presence: o2.marker } : {}), ...(o2.captured ? { captured_at: o2.captured(i) } : {}) };
      await listen.chunk(c, true);
    }
    await listen.flush(session);
    await rt.settled();
  };
  const orders = () => port.writes.filter((w) => w.kind === "order_test");
  return { rt, port, listen, send, orders, heard, embeds: () => embeds };
}

describe("replay defence: session and presence, never the voice", () => {
  it("passes a live chunk sequence from the person at the screen, and the owner's matched voice sends the order", async () => {
    const r = rig();
    await r.send("live-1", clip(0.3), 1_000_000, { marker: AT_SCREEN });
    expect(r.orders()).toHaveLength(1);
    // One line, matched on each of its three chunks.
    expect(new Set(r.port.matched).size).toBe(1);
    expect(r.listen.replayRefusals()).toEqual({});
  });

  it("refuses the same chunks replayed under a new session before the ear or the voice match hears them", async () => {
    const r = rig();
    const take = clip(0.3);
    await r.send("live-1", take, 1_000_000, { marker: AT_SCREEN });
    const [heard, embeds, matched] = [r.heard.length, r.embeds(), r.port.matched.length];
    const replay = r.send("replay-1", take, 1_100_000, { marker: AT_SCREEN });
    await expect(replay).rejects.toBeInstanceOf(ListenError);
    await expect(replay).rejects.toMatchObject({ status: 409, message: "replayed audio refused: replayed_chunk" });
    expect([r.heard.length, r.embeds(), r.port.matched.length]).toEqual([heard, embeds, matched]);
    expect(r.orders()).toHaveLength(1);
    expect(r.listen.replayRefusals()).toEqual({ replayed_chunk: 1 });
  });

  it("refuses a re-recorded copy pushed faster than a microphone could speak it", async () => {
    const r = rig();
    await expect(r.send("replay-2", clip(0.25), 1_000_000, { marker: AT_SCREEN, burst: true })).rejects.toMatchObject({ status: 409, message: "replayed audio refused: faster_than_live" });
    expect(r.heard).toEqual([]);
    expect(r.port.matched).toEqual([]);
    expect(r.orders()).toEqual([]);
  });

  it("refuses chunks whose capture times run backwards or sit in the future", async () => {
    const r = rig();
    await expect(r.send("replay-3", clip(0.22), 1_000_000, { marker: AT_SCREEN, captured: (i) => 1_000_000 - i * 5000 })).rejects.toMatchObject({ message: "replayed audio refused: capture_out_of_order" });
    await expect(r.send("replay-4", clip(0.21), 2_000_000, { marker: AT_SCREEN, captured: () => 2_100_000 })).rejects.toMatchObject({ message: "replayed audio refused: capture_in_future" });
    expect(r.orders()).toEqual([]);
  });

  it("keeps a live-paced copy said while nobody is at the screen as words only: no voice match, the order held for the owner", async () => {
    const r = rig();
    await r.send("replay-5", clip(0.2), 1_000_000, { marker: AWAY });
    expect(r.embeds()).toBe(0);
    expect(r.port.matched).toEqual([]);
    expect(r.orders()).toEqual([]);
    const v = r.rt.views(DOC)[0]!;
    expect(v.transcript[0]!.speaker).toMatchObject({ speaker: "unverified", reason: "not_present:no_recent_input" });
    expect(v.actions.find((a) => a.kind === "order_test")).toMatchObject({ state: "proposed", awaiting: "owner_voice" });
  });

  it("treats a chunk with no liveness marker as not present when presence is required, and as before when only observed", async () => {
    const req = rig();
    await req.send("nomark-1", clip(0.3), 1_000_000);
    expect(req.port.matched).toEqual([]);
    expect(req.rt.views(DOC)[0]!.transcript[0]!.speaker).toMatchObject({ speaker: "unverified", reason: "not_present:no_marker" });
    const obs = rig({ presence: "observed" });
    await obs.send("nomark-2", clip(0.3), 1_000_000);
    expect(new Set(obs.port.matched).size).toBe(1);
    expect(obs.orders()).toHaveLength(1);
  });

  it("lets the strip retry an upload of the same chunk in the same place without calling it a replay", () => {
    const g = new ReplayGuard("required");
    const wav = clip(0.3)[2]!;
    const c = { owner: DOC, session_id: "s", seq: 4, wav, audio_ms: 2200, speech: true, arrived_at: 1_000_000, marker: AT_SCREEN };
    expect(g.check(c).refused).toBeNull();
    expect(g.check({ ...c, arrived_at: 1_000_050 }).refused).toBeNull();
    expect(g.check({ ...c, seq: 9, arrived_at: 1_010_000 }).refused).toBe("replayed_chunk");
    expect(presenceOf({ marker: { ...AT_SCREEN, visible: false }, audio_ms: 1000, arrived_at: 0 }, "observed")).toEqual({ live: false, reason: "page_hidden" });
    expect(presenceOf({ marker: AT_SCREEN, captured_at: 0, audio_ms: 1000, arrived_at: PRESENCE_RULE.stale_capture_ms + 5000 }, "observed")).toEqual({ live: false, reason: "stale_capture" });
  });

  it("goes red without the defence: the same replay under a new session is matched as the owner and sends a second order (negative control)", async () => {
    const r = rig({ replay: "off", presence: "observed" });
    const take = clip(0.3);
    await r.send("live-1", take, 1_000_000, { marker: AT_SCREEN });
    await r.send("replay-1", take, 1_000_010, { marker: AT_SCREEN, burst: true });
    expect(new Set(r.port.matched).size).toBe(2);
    expect(r.orders()).toHaveLength(2);
  });
});
