import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeWav, encodeWav } from "../src/wav.js";
import type { Person } from "./lines.js";

export const SYNTH_RATE = 24_000;
// One macOS voice per person; five distinct voices, two of them male doctors so the owner is not the only male voice.
export const VOICE_OF: Record<Person, string> = { S: "Rishi", B: "Daniel", N: "Tessa", P: "Samantha", R: "Karen" };

export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

// A small seeded generator, so the same id always yields the same rate, gain, noise and offset.
export function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Speaks one line with `say` and returns clean samples at 24 kHz (the say file carries an FLLR chunk Modal cannot read, so it is decoded and re-encoded).
export function speak(voice: string, words: string, rate: number): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), "r1-say-"));
  try {
    const f = join(dir, "s.wav");
    execFileSync("say", ["-v", voice, "-r", String(rate), "-o", f, "--file-format=WAVE", `--data-format=LEI16@${SYNTH_RATE}`, words]);
    return decodeWav(new Uint8Array(readFileSync(f))).samples;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rms = (x: Float32Array) => { let s = 0, n = 0; for (const v of x) if (Math.abs(v) > 1e-3) { s += v * v; n++; } return n ? Math.sqrt(s / n) : 0; };

// Distance: lower level, a one-pole low-pass and two weak echoes, the way a voice a metre or two from a laptop sounds.
export function far(x: Float32Array, gain: number, cutoffHz = 3500): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / SYNTH_RATE);
  const out = new Float32Array(x.length + Math.round(0.08 * SYNTH_RATE));
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += a * (x[i]! - y); out[i] = y * gain; }
  const d1 = Math.round(0.035 * SYNTH_RATE), d2 = Math.round(0.07 * SYNTH_RATE);
  for (let i = out.length - 1; i >= 0; i--) out[i] = out[i]! + 0.25 * (out[i - d1] ?? 0) + 0.12 * (out[i - d2] ?? 0);
  return out;
}

export type Mix = { voice: Person; at_ms: number; gain: number; far: boolean; rate: number; words: string };
export type Rendered = { wav: Uint8Array; sha256: string; duration_ms: number; snr_db: number };

// Lays the voices on one track with a lead and tail of room tone, then adds noise at the given speech-to-noise ratio.
export function render(parts: readonly Mix[], snrDb: number, seed: string): Rendered {
  const r = rng(`${seed}:noise`);
  const voiced = parts.map((p) => {
    const s = speak(VOICE_OF[p.voice], p.words, p.rate);
    return { at: Math.round((p.at_ms / 1000) * SYNTH_RATE), x: p.far ? far(s, p.gain) : s.map((v) => v * p.gain) };
  });
  const lead = Math.round(0.4 * SYNTH_RATE);
  const n = lead + Math.max(...voiced.map((v) => v.at + v.x.length)) + lead;
  const track = new Float32Array(n);
  for (const v of voiced) for (let i = 0; i < v.x.length; i++) track[lead + v.at + i]! += v.x[i]!;
  const speech = rms(track);
  const noise = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) { const w = r() * 2 - 1; lp += 0.08 * (w - lp); noise[i] = 0.6 * lp * 3 + 0.4 * w * 0.3; }
  const scale = speech / (rms(noise) || 1) / 10 ** (snrDb / 20);
  let peak = 0;
  for (let i = 0; i < n; i++) { track[i] = track[i]! + noise[i]! * scale; peak = Math.max(peak, Math.abs(track[i]!)); }
  if (peak > 0.95) for (let i = 0; i < n; i++) track[i] = (track[i]! / peak) * 0.95;
  const wav = encodeWav(track, SYNTH_RATE);
  return { wav, sha256: sha256Hex(wav), duration_ms: Math.round((n / SYNTH_RATE) * 1000), snr_db: snrDb };
}
