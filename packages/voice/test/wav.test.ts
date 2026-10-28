import { describe, expect, it } from "vitest";
import { concat, encodeWav, parseWav, resample } from "../src/wav.js";

const ascii = (b: Uint8Array, at: number) => String.fromCharCode(...b.slice(at, at + 4));

describe("encodeWav", () => {
  it("writes a 16 kHz mono 16-bit PCM header and clamped samples", () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]), 16_000);
    const v = new DataView(wav.buffer);
    expect(ascii(wav, 0)).toBe("RIFF");
    expect(ascii(wav, 8)).toBe("WAVE");
    expect(ascii(wav, 12)).toBe("fmt ");
    expect(ascii(wav, 36)).toBe("data");
    expect(v.getUint32(4, true)).toBe(wav.length - 8);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(28, true)).toBe(32_000);
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(14);
    const s = Array.from({ length: 7 }, (_, i) => v.getInt16(44 + i * 2, true));
    expect(s).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768]);
  });

  it("round-trips through parseWav with the right duration", () => {
    const info = parseWav(encodeWav(new Float32Array(16_000 * 2), 16_000));
    expect(info).toEqual({ ok: true, sampleRate: 16_000, channels: 1, bits: 16, dataBytes: 64_000, durationMs: 2000 });
  });
});

describe("resample", () => {
  it("turns 48 kHz into 16 kHz by averaging each window of three", () => {
    const out = resample(new Float32Array([0.3, 0.3, 0.3, -0.6, 0, 0, 1, 1, 1]), 48_000, 16_000);
    expect(Array.from(out).map((x) => Number(x.toFixed(5)))).toEqual([0.3, -0.2, 1]);
  });

  it("keeps a 44.1 kHz second at one 16 kHz second", () => {
    expect(resample(new Float32Array(44_100), 44_100).length).toBe(16_000);
  });

  it("upsamples 8 kHz by linear interpolation", () => {
    expect(Array.from(resample(new Float32Array([0, 1]), 8_000, 16_000))).toEqual([0, 0.5, 1, 1]);
  });

  it("concat keeps the chunk order", () => {
    expect(Array.from(concat([new Float32Array([1]), new Float32Array([2, 3])]))).toEqual([1, 2, 3]);
  });
});

describe("parseWav", () => {
  const header = (o: { format?: number; channels?: number; rate?: number; bits?: number }) => {
    const w = encodeWav(new Float32Array(100), 16_000);
    const v = new DataView(w.buffer);
    if (o.format !== undefined) v.setUint16(20, o.format, true);
    if (o.channels !== undefined) v.setUint16(22, o.channels, true);
    if (o.rate !== undefined) v.setUint32(24, o.rate, true);
    if (o.bits !== undefined) v.setUint16(34, o.bits, true);
    return w;
  };

  it("accepts 24 kHz", () => { expect(parseWav(header({ rate: 24_000 })).ok).toBe(true); });
  it("rejects stereo", () => { expect(parseWav(header({ channels: 2 }))).toMatchObject({ ok: false, reason: expect.stringContaining("2 channels") }); });
  it("rejects 44.1 kHz", () => { expect(parseWav(header({ rate: 44_100 }))).toMatchObject({ ok: false }); });
  it("rejects float samples", () => { expect(parseWav(header({ format: 3, bits: 32 }))).toMatchObject({ ok: false }); });
  it("rejects 8-bit", () => { expect(parseWav(header({ bits: 8 }))).toMatchObject({ ok: false }); });
  it("rejects a non-WAV file", () => {
    const mp3 = new Uint8Array(64);
    mp3.set([0x49, 0x44, 0x33]);
    expect(parseWav(mp3)).toMatchObject({ ok: false, reason: "not a RIFF/WAVE file" });
  });
  it("rejects a header with no samples", () => { expect(parseWav(encodeWav(new Float32Array(0)))).toMatchObject({ ok: false }); });
  it("skips a LIST chunk before data", () => {
    const base = encodeWav(new Float32Array(10), 16_000);
    const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0]);
    const w = new Uint8Array(base.length + list.length);
    w.set(base.slice(0, 36)); w.set(list, 36); w.set(base.slice(36), 36 + list.length);
    expect(parseWav(w)).toMatchObject({ ok: true, dataBytes: 20 });
  });
});
