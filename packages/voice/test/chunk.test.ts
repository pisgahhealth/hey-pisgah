import { describe, expect, it } from "vitest";
import { cleanTranscript, decodeWav, encodeWav, spokenDigits, stripChunks, trailingSilenceMs } from "../src/index.js";

const RATE = 16_000;
// Speech is a loud tone and a pause is digital silence, so the cuts are exact.
const audio = (parts: [("talk" | "quiet"), number][]) => {
  const n = parts.reduce((s, [, ms]) => s + (ms * RATE) / 1000, 0);
  const out = new Float32Array(n);
  let at = 0;
  for (const [kind, ms] of parts) {
    const len = (ms * RATE) / 1000;
    if (kind === "talk") for (let i = 0; i < len; i++) out[at + i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE);
    at += len;
  }
  return out;
};

describe("silence and chunks", () => {
  it("measures the quiet tail and survives a WAV round trip", () => {
    const a = audio([["talk", 1000], ["quiet", 700]]);
    expect(trailingSilenceMs(a, RATE)).toBeGreaterThanOrEqual(690);
    const back = decodeWav(encodeWav(a));
    expect(back.sampleRate).toBe(RATE);
    expect(trailingSilenceMs(back.samples, back.sampleRate)).toBeGreaterThanOrEqual(690);
    expect(trailingSilenceMs(audio([["talk", 500]]), RATE)).toBe(0);
  });

  it("cuts like the strip: 700 ms after speech, at the 6 s cap mid-word, and never sends a quiet-only chunk", () => {
    const a = audio([["quiet", 300], ["talk", 2000], ["quiet", 1500], ["talk", 8000], ["quiet", 900], ["quiet", 7000]]);
    const c = stripChunks(a, RATE);
    expect(c.map((x) => x.cut)).toEqual(["quiet_tail", "cap", "quiet_tail"]);
    expect(c.map((x) => x.seq)).toEqual([0, 1, 2]);
    expect(c[0]!.end_ms).toBe(3000);
    expect(c[1]!.end_ms - c[1]!.start_ms).toBe(6000);
    expect(c[2]!.end_ms).toBeLessThan(a.length / 16);
  });
});

describe("transcript cleaning", () => {
  it("writes spoken numbers as digits and leaves small words alone", () => {
    expect(spokenDigits("Temperature thirty seven point nine. Pulse ninety-six")).toBe("Temperature 37.9. Pulse 96");
    expect(spokenDigits("one hundred and four, not ninety six")).toBe("104, not 96");
    expect(spokenDigits("eighteen, or was it twenty two")).toBe("18, or was it 22");
    expect(spokenDigits("37 point 8 and no one came")).toBe("37.8 and no one came");
  });

  it("drops a word the recogniser repeated and the doubled full stop", () => {
    expect(cleanTranscript("Pulse Pulse ninety six. Respiratory rate twenty..")).toBe("Pulse 96. Respiratory rate 20.");
    expect(cleanTranscript("the pressure is 128 128 over 76")).toBe("the pressure is 128 over 76");
    expect(cleanTranscript("ninety, ninety")).toBe("90, 90");
  });
});
