import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav } from "@hey-pisgah/voice";
import { ORDER_REFERENCE_KINDS } from "../src/emr/gate.js";
import { ListenSessions } from "../src/emr/listen.js";
import type { Orderables, Provenance } from "../src/emr/port.js";
import { DOOR_AUDIO_MAX_MS, lineVerdict, matchWindows, withDoorAudio, type Embedder, type SpeakerInput, type SpeakerVerdict } from "../src/emr/speaker.js";
import { ADMIT, ClerkFake, DOC, clerkBoot, ins } from "./clerking-helpers.js";
import { RATE, earOf } from "./mic-helpers.js";

const OWNER_AMP = 0.3, OTHER_AMP = 0.6;
const tone = (ms: number, amp: number, quietMs = 0) => { const a = new Float32Array(((ms + quietMs) * RATE) / 1000); for (let i = 0; i < (ms * RATE) / 1000; i++) a[i] = amp * Math.sin((2 * Math.PI * 200 * i) / RATE); return a; };
const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
// The stand-in speaker model reads a window's loudest sample: the owner talks at 0.3 and the colleague at 0.6.
const embed: Embedder = async (wav) => { const { samples } = decodeWav(wav); const p = peak(samples); return p < 0.01 ? null : { vector: [p > 0.45 ? 2 : 5], ms: 20, model: "nemo_en_titanet_small" }; };
const verdictOf = (v: readonly number[]): SpeakerVerdict => (v[0] === 5 ? { speaker: "owner", token: `v2.${String(1_761_700_000_000)}.${"A".repeat(22)}.${"B".repeat(43)}` } : { speaker: "other_clinician", label: "Dr B", role: "doctor" });

// A hospital that matches each window it is sent, by vector or from audio, and keeps what it was sent.
class WindowFake extends ClerkFake {
  readonly sent: SpeakerInput[] = [];
  override kindsFor(): readonly string[] { return [...ORDER_REFERENCE_KINDS]; }
  orderables(): Orderables { return { tests: { fbc: ["full blood count", "FBC"] }, drugs: {} }; }
  readonly speaker = async (_o: string, v: SpeakerInput, _p: Provenance): Promise<SpeakerVerdict> => {
    this.sent.push(v);
    if (!("pcm16k" in v)) return verdictOf(v);
    return lineVerdict(v.pcm16k.map((w) => { const d = new DataView(w.buffer, w.byteOffset, w.byteLength); let m = 0; for (let i = 0; i < w.byteLength / 2; i++) m = Math.max(m, Math.abs(d.getInt16(i * 2, true))); return verdictOf([m / 0x7fff > 0.45 ? 2 : 5]); }));
  };
}

function rig(door = false) {
  const port = new WindowFake();
  port.admitted = true;
  const { rt } = clerkBoot((s) => (s.includes("blood count") ? [ins("order_test", { test: "fbc" })] : []), { port });
  // A 6 s capped chunk then a 1.5 s chunk with a quiet tail make one 8.2 s line; a 20 s stream segment is one long line.
  const listen = new ListenSessions(rt, { transcribe: earOf({ 8200: "Okay, let's get a full blood count." }), embed: door ? withDoorAudio(embed) : embed });
  const orders = () => port.writes.filter((w) => w.kind === "order_test");
  return { rt, port, listen, orders };
}
const chunks = async (r: ReturnType<typeof rig>, first: number, second: number) => {
  let at = Date.now();
  for (const [seq, x] of [tone(6000, first), tone(1500, second, 700)].entries()) {
    at += Math.round((x.length / RATE) * 1000);
    await r.listen.chunk({ owner: DOC, target: { admission_id: ADMIT }, session_id: `s-${first}-${second}`, seq, wav: encodeWav(x, RATE), arrived_at: at }, true);
  }
  await r.listen.flush(`s-${first}-${second}`);
  await r.rt.settled();
};

describe("attribution covers every word that is acted on", () => {
  it("cuts a line into windows that cover every sample: short pieces joined to a neighbour, long ones split evenly, none dropped", () => {
    const sizes = (ws: Float32Array[]) => ws.map((w) => w.length / RATE);
    expect(sizes(matchWindows([tone(300, 1), tone(6000, 1)], RATE))).toEqual([6.3]);
    expect(sizes(matchWindows([tone(6000, 1), tone(6000, 1), tone(200, 1)], RATE))).toEqual([6, 6.2]);
    expect(sizes(matchWindows([tone(20_000, 1)], RATE))).toEqual([10, 10]);
    expect(sizes(matchWindows([tone(14_800, 1), tone(300, 1)], RATE))).toEqual([7.55, 7.55]);
    expect(matchWindows([tone(31_000, 1)], RATE).every((w) => w.length <= (RATE * DOOR_AUDIO_MAX_MS) / 1000)).toBe(true);
    // Ten 6 s pieces become at most eight windows, every sample kept.
    const ten = matchWindows(Array.from({ length: 10 }, () => tone(6000, 1)), RATE);
    expect(ten.length).toBeLessThanOrEqual(8);
    expect(ten.reduce((n, w) => n + w.length, 0)).toBe(10 * 6 * RATE);
  });

  it("gives a line the owner only when every window is the owner", () => {
    const own = verdictOf([5]), drb = verdictOf([2]);
    expect(lineVerdict([own, own])).toBe(own);
    expect(lineVerdict([own, drb])).toEqual({ speaker: "unverified", reason: "mixed_speakers" });
    expect(lineVerdict([drb, drb])).toBe(drb);
    expect(lineVerdict([own, { speaker: "unverified", reason: "no_match" }])).toEqual({ speaker: "unverified", reason: "mixed_speakers" });
  });

  for (const door of [false, true]) {
    const how = door ? "from audio at the hospital" : "by the agent's vectors";
    it(`holds an order whose closing words were said by another voice, ${how}`, async () => {
      const r = rig(door);
      await chunks(r, OWNER_AMP, OTHER_AMP);
      expect(r.orders()).toHaveLength(0);
      const v = r.rt.views()[0]!;
      expect(v.transcript.at(-1)!.speaker).toMatchObject({ speaker: "unverified", reason: "mixed_speakers" });
      expect(v.actions.find((a) => a.kind === "order_test")).toMatchObject({ awaiting: "owner_voice" });
      // Every window went to the match: two vectors, or one request carrying both windows' audio.
      expect(door ? (r.port.sent[0] as { pcm16k: Uint8Array[] }).pcm16k.length : r.port.sent.length).toBe(2);
      await r.rt.stop();
    });

    it(`sends the order when the owner said all of it, ${how}`, async () => {
      const r = rig(door);
      await chunks(r, OWNER_AMP, OWNER_AMP);
      expect(r.orders()).toHaveLength(1);
      await r.rt.stop();
    });

    it(`matches a 20 s owner line in full, never cut at 15 s, ${how}`, async () => {
      const r = rig(door);
      await r.listen.segment({ owner: DOC, target: { admission_id: ADMIT }, session_id: "long", samples: tone(20_000, OWNER_AMP), rate: RATE, raw: "Okay, let's get a full blood count.", trailing_ms: 700, arrived: Date.now() });
      await r.rt.settled();
      expect(r.orders()).toHaveLength(1);
      if (door) expect((r.port.sent[0] as { pcm16k: Uint8Array[] }).pcm16k.reduce((n, w) => n + w.byteLength, 0)).toBe(20 * RATE * 2);
      else expect(r.port.sent).toHaveLength(2);
      await r.rt.stop();
    });
  }

  it("gives a stream line joined across a cut the attribution of both its pieces, so another voice's continuation is unverified", async () => {
    for (const [second, want] of [[OTHER_AMP, { speaker: "unverified", reason: "mixed_speakers" }], [OWNER_AMP, { speaker: "owner" }]] as const) {
      const r = rig();
      const seg = (samples: Float32Array, raw: string) => r.listen.segment({ owner: DOC, target: { admission_id: ADMIT }, session_id: "join", samples, rate: RATE, raw, trailing_ms: 300, arrived: Date.now() });
      // The line ends where a value must follow, so the next piece is joined to it.
      await seg(tone(2500, OWNER_AMP), "Her pulse is");
      await seg(tone(1500, second), "ninety two.");
      await r.listen.flush("join");
      await r.rt.settled();
      const lines = r.rt.views()[0]!.transcript;
      expect(lines.map((l) => [l.text, l.speaker?.speaker]), JSON.stringify(lines.map((l) => [l.text, l.speaker]))).toHaveLength(1);
      expect(lines[0]!.speaker).toMatchObject(want);
      await r.rt.stop();
    }
  });
});
