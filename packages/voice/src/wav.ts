export const TARGET_RATE = 16_000;
export const ACCEPTED_RATES = [16_000, 24_000] as const;

export type WavInfo = { ok: true; sampleRate: number; channels: 1; bits: 16; dataBytes: number; durationMs: number };
export type WavProblem = { ok: false; reason: string };

// Joins the recorder's chunks into one buffer.
export function concat(chunks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// Downsamples by averaging each output sample's input window, and upsamples by linear interpolation.
export function resample(input: Float32Array, fromRate: number, toRate: number = TARGET_RATE): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError("sample rates must be positive");
  if (fromRate === toRate) return input.slice();
  const ratio = fromRate / toRate;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (ratio > 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j]!;
      out[i] = sum / (end - start);
    } else {
      const x = i * ratio;
      const j = Math.floor(x);
      const a = input[j] ?? 0;
      const b = input[j + 1] ?? a;
      out[i] = a + (b - a) * (x - j);
    }
  }
  return out;
}

// Writes mono 16-bit little-endian PCM in a RIFF/WAVE container.
export function encodeWav(samples: Float32Array, sampleRate: number = TARGET_RATE): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError("sample rate must be a positive integer");
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const tag = (at: number, s: string) => { for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  tag(0, "RIFF"); v.setUint32(4, 36 + dataBytes, true); tag(8, "WAVE");
  tag(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, "data"); v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    v.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return new Uint8Array(buf);
}

// Reads a WAV header and accepts only what Voice Transcribe takes: mono 16-bit PCM at 16 or 24 kHz.
export function parseWav(bytes: Uint8Array): WavInfo | WavProblem {
  if (bytes.length < 44) return { ok: false, reason: "too short to be a WAV file" };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return { ok: false, reason: "not a RIFF/WAVE file" };
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = v.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.length) return { ok: false, reason: "the fmt chunk is cut short" };
      fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === "data") {
      if (!fmt) return { ok: false, reason: "the data chunk comes before the fmt chunk" };
      if (fmt.format !== 1) return { ok: false, reason: "the audio is not plain PCM" };
      if (fmt.channels !== 1) return { ok: false, reason: `the audio has ${fmt.channels} channels, not 1` };
      if (fmt.bits !== 16) return { ok: false, reason: `the audio is ${fmt.bits}-bit, not 16-bit` };
      if (!(ACCEPTED_RATES as readonly number[]).includes(fmt.rate)) return { ok: false, reason: `the audio is ${fmt.rate} Hz, not 16 or 24 kHz` };
      const dataBytes = Math.min(size, bytes.length - body);
      if (dataBytes < 2) return { ok: false, reason: "the audio has no samples" };
      return { ok: true, sampleRate: fmt.rate, channels: 1, bits: 16, dataBytes, durationMs: Math.round((dataBytes / 2 / fmt.rate) * 1000) };
    }
    at = body + size + (size % 2);
  }
  return { ok: false, reason: "no data chunk" };
}
