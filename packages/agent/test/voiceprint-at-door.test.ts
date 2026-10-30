import { describe, expect, it } from "vitest";
import { encodeWav } from "@hey-pisgah/voice";
import type { Provenance } from "../src/emr/port.js";
import { DOOR_AUDIO_MAX_MS, pcm16kOf, voiceprintAt, withDoorAudio, type Embedder, type SpeakerInput, type SpeakerVerdict, type Voiceprint } from "../src/emr/speaker.js";
import { ADMIT, ClerkFake, DOC, clerkBoot } from "./clerking-helpers.js";

const TOKEN = (n: number) => `v2.${String(1_761_700_000_000 + n)}.${"A".repeat(22)}.${"B".repeat(43)}`;
const tone = (seconds: number, rate: number) => { const x = new Float32Array(Math.round(seconds * rate)); for (let i = 0; i < x.length; i++) x[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / rate); return encodeWav(x, rate); };

// A hospital that records what each match was sent: a vector or the line's audio.
class DoorFake extends ClerkFake {
  readonly sent: SpeakerInput[] = [];
  private n = 0;
  readonly speaker = async (_o: string, v: SpeakerInput, _p: Provenance): Promise<SpeakerVerdict> => {
    this.sent.push(v);
    this.n += 1;
    return { speaker: "owner", token: TOKEN(this.n) };
  };
}

describe("the hospital computes the voiceprint from the line's audio", () => {
  it("is off unless the switch says door", () => {
    expect(voiceprintAt(undefined)).toBe("agent");
    expect(voiceprintAt("1")).toBe("agent");
    expect(voiceprintAt("door")).toBe("door");
  });

  it("turns a window into 16 kHz mono 16-bit PCM, none under half a second and none over 15 s, never cut short", () => {
    const two = pcm16kOf(tone(2, 24_000))!;
    expect(two.byteLength).toBe(2 * 16_000 * 2);
    // The PCM carries the resampled tone at its own level, not silence.
    const v = new DataView(two.buffer);
    let peak = 0;
    for (let i = 0; i < two.byteLength / 2; i++) peak = Math.max(peak, Math.abs(v.getInt16(i * 2, true)));
    expect(peak).toBeGreaterThan(0.35 * 0x7fff);
    expect(peak).toBeLessThan(0.45 * 0x7fff);
    expect(pcm16kOf(tone(DOOR_AUDIO_MAX_MS / 1000, 16_000))!.byteLength).toBe((DOOR_AUDIO_MAX_MS / 1000) * 16_000 * 2);
    expect(pcm16kOf(tone(20, 16_000))).toBeNull();
    expect(pcm16kOf(tone(0.3, 24_000))).toBeNull();
  });

  it("adds the audio to the agent's own print, splits a recording past 15 s into windows that cover all of it, and gives nothing when the print fails", async () => {
    const inner: Embedder = async () => ({ vector: [1, 2], ms: 3, model: "nemo_en_titanet_small" });
    const p = await withDoorAudio(inner)(tone(1, 16_000));
    expect(p!.audio!.byteLength).toBe(32_000);
    expect(p!.vector).toEqual([1, 2]);
    const long = (await withDoorAudio(inner)(tone(20, 24_000)))!;
    expect(long.segments!.map((w) => w.audio!.byteLength)).toEqual([10 * 32_000, 10 * 32_000]);
    expect(await withDoorAudio(async () => null)(tone(1, 16_000))).toBeNull();
  });

  it("sends the hospital the audio and never the vector when the print carries audio, and lets the audio go once sent", async () => {
    const port = new DoorFake();
    const { rt } = clerkBoot(() => [], { port });
    const audio = new Uint8Array([1, 2, 3, 4]);
    const vp: Voiceprint = { vector: [5], ms: 20, model: "nemo_en_titanet_small", audio };
    await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Her chest is clear.", source: "audio", voiceprint: vp });
    await rt.settled();
    expect(port.sent).toEqual([{ pcm16k: [audio] }]);
    expect(vp.audio).toBeUndefined();
    // Negative control: a print with no audio is matched by its vector, exactly as before.
    await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Her abdomen is soft.", source: "audio", voiceprint: { vector: [5], ms: 20, model: "nemo_en_titanet_small" } });
    await rt.settled();
    expect(port.sent[1]).toEqual([5]);
    await rt.stop();
  });
});
