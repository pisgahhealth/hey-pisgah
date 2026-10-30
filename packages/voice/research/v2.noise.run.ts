import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sherpaEmbedder, to16k } from "@hey-pisgah/agent";
import { decodeWav, encodeWav } from "../src/wav.js";
import { LINES } from "./lines.js";
import { rng, sha256Hex } from "./synth.js";
import type { V2Row } from "./v2.score.js";

// Measures which front ends bring the owner's noisy lines back to quiet-level identity without moving the 0.41 rule: voice-only windows, a denoiser, noisy enrolment, and joined lines.
const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const work = arg("work", ".hey-pisgah/g4");
const embed = sherpaEmbedder({ modelPath: arg("model"), sherpaDir: arg("sherpa") })!;
type Den = { run(o: { samples: Float32Array; sampleRate: number }): { samples: Float32Array; sampleRate: number } };
const sherpa = createRequire(join(arg("sherpa"), "package.json"))("sherpa-onnx-node") as { OfflineSpeechDenoiser: new (c: unknown) => Den };
const den = new sherpa.OfflineSpeechDenoiser({ model: { gtcrn: { model: arg("denoiser") }, numThreads: 1, debug: 0, provider: "cpu" } });

function pcm16(file: string): Float32Array {
  const b = readFileSync(file), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let at = 12; at + 8 <= b.length;) { const id = b.toString("latin1", at, at + 4), size = v.getUint32(at + 4, true); if (id === "data") { const x = new Float32Array(size >> 1); for (let i = 0; i < x.length; i++) x[i] = v.getInt16(at + 8 + 2 * i, true) / 32768; return x; } at += 8 + size + (size % 2); }
  throw new Error(file);
}
const at16 = (wav: Uint8Array) => { const { samples, sampleRate } = decodeWav(wav); return to16k(samples, sampleRate); };
const unit = (v: number[]) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const mean = (vs: number[][]) => unit(vs[0]!.map((_, i) => vs.reduce((s, v) => s + v[i]!, 0)));
const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

// (a) Voice-only windows: 20 ms frames within 12 dB of the clip's loud speech, widened by 40 ms, so pauses and the quieter radio under them are cut.
function vad(x: Float32Array): Float32Array {
  const f = 320, n = Math.floor(x.length / f), db = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < f; j++) s += x[i * f + j]! ** 2; db[i] = 10 * Math.log10(s / f + 1e-10); }
  const top = [...db].sort((a, b) => a - b)[Math.floor(n * 0.95)] ?? 0;
  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (db[i]! >= top - 12) for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) keep[k] = 1;
  const parts: Float32Array[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) parts.push(x.subarray(i * f, (i + 1) * f));
  const out = new Float32Array(parts.length * f);
  parts.forEach((p, i) => out.set(p, i * f));
  return out.length >= 8000 ? out : x;
}
// (b) The gtcrn denoiser from sherpa-onnx at 16 kHz.
const denoise = (x: Float32Array) => den.run({ samples: x, sampleRate: 16000 }).samples;

// (c) Synthetic radio: two macOS voices reading a news paragraph over each other, band-limited like a small speaker, with a little hiss.
function radio(seconds: number, seed: string): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), "g4-radio-"));
  try {
    const say = (voice: string, text: string) => { const f = join(dir, `${voice}.wav`); execFileSync("say", ["-v", voice, "-r", "190", "-o", f, "--file-format=WAVE", "--data-format=LEI16@16000", text]); return decodeWav(new Uint8Array(readFileSync(f))).samples; };
    const news = "Good evening. Here is the news. The state government has announced new road works in the city centre, and traders at the main market say prices have risen again this week. In sport, the home team won on Saturday. Now the weather: hot and dry, with some rain expected later in the week.";
    const a = say("Daniel", news), b = say("Samantha", news.split(". ").reverse().join(". "));
    const n = Math.round(seconds * 16000), out = new Float32Array(n), r = rng(seed);
    let l1 = 0, l2 = 0, h = 0, prev = 0;
    const hp = Math.exp((-2 * Math.PI * 200) / 16000), lp = 1 - Math.exp((-2 * Math.PI * 4000) / 16000);
    for (let i = 0; i < n; i++) {
      const x = (a[i % a.length] ?? 0) + 0.7 * (b[(i + 9000) % b.length] ?? 0) + (r() * 2 - 1) * 0.02;
      h = hp * (h + x - prev); prev = x; l1 += lp * (h - l1); l2 += lp * (l1 - l2); out[i] = l2;
    }
    return out;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const rmsOf = (x: Float32Array) => { let s = 0, n = 0; for (const v of x) if (Math.abs(v) > 0.003) { s += v * v; n++; } return Math.sqrt(n ? s / n : 1e-10); };
const mixAt = (x: Float32Array, noise: Float32Array, snrDb: number) => { const g = rmsOf(x) / (rmsOf(noise) || 1) / 10 ** (snrDb / 20); return x.map((v, i) => v + g * noise[i % noise.length]!); };

// The radio's level in the owner's noisy recording: loud speech frames against the quiet frames between lines, after "noise on".
function noisySnr(x: Float32Array = pcm16(join(work, "v2-src", "O-S.wav")).subarray(340 * 16000, 620 * 16000)): number {
  const f = 320, db: number[] = [];
  for (let i = 0; i + f <= x.length; i += f) { let s = 0; for (let j = 0; j < f; j++) s += x[i + j]! ** 2; db.push(10 * Math.log10(s / f + 1e-10)); }
  db.sort((a, b) => a - b);
  return Math.round((db[Math.floor(db.length * 0.9)]! - db[Math.floor(db.length * 0.3)]!) * 10) / 10;
}

// The clips: held-out owner lines and the impostors, each checked against its listed hash.
const fx = JSON.parse(readFileSync("packages/voice/research/fixtures/v2.readings.json", "utf8")) as { rows: V2Row[] };
const realSet = JSON.parse(readFileSync("packages/voice/research/real-set.json", "utf8")) as { clips: { id: string; source: string; start_s: number | null; end_s: number | null; set: string }[] };
const cutReal = (id: string) => { const c = realSet.clips.find((x) => x.id === id)!; const x = pcm16(join(work, "real-src", c.source.replace(/\.m4a$/, ".wav"))); return x.slice(Math.floor((c.start_s ?? 0) * 16000), c.end_s === null ? x.length : Math.floor(c.end_s * 16000)); };
type Clip = { id: string; group: string; owner: boolean; x: Float32Array; sha256: string };
const clips: Clip[] = [];
for (const r of fx.rows.filter((r) => r.source === "owner_v2" && r.set === "held_out" && r.replay === null && r.usable !== false)) {
  const id = r.id.replace(/^v2-/, ""), file = id.endsWith("-part") ? `${id.replace(/-part$/, "")}-S-part.wav` : `${id}.wav`;
  const wav = new Uint8Array(readFileSync(join(work, "v2-clips", file)));
  if (sha256Hex(wav) !== r.sha256) throw new Error(`${id} does not match its listed hash`);
  const n = /^O\d{3}$/.test(id) ? Number(id.slice(1)) : 0;
  clips.push({ id: r.id, group: n && n <= 42 ? "owner quiet" : n ? "owner radio" : "owner short or part", owner: true, x: at16(wav), sha256: r.sha256 });
}
for (const r of fx.rows.filter((r) => r.source === "real" && r.set === "held_out" && r.replay === null && r.category !== "overlap")) {
  const id = r.id.replace(/^real-/, "");
  clips.push({ id: r.id, group: r.role === "owner" ? "owner R1.b quiet" : "N (real other person)", owner: r.role === "owner", x: cutReal(id), sha256: r.sha256 });
}
for (const l of LINES.filter((l) => l.set === "final" && l.who !== "S" && !l.overlap)) {
  const wav = new Uint8Array(readFileSync(join(arg("synth"), `${l.id}.wav`)));
  clips.push({ id: `syn-${l.id}`, group: "synthetic other voices", owner: false, x: at16(wav), sha256: sha256Hex(wav) });
}
const enrol = ["E1", "E2", "E3"].map((id) => pcm16(join(work, "real-src", `${id}.wav`)));
const snr = noisySnr();
const noisyEnrol = enrol.map((x, i) => mixAt(x, radio(x.length / 16000 + 1, `enrol-${i}`), snr));

const vec = async (x: Float32Array) => (await embed(encodeWav(x, 16000)))?.vector ?? null;
type Variant = { vad: boolean; den: boolean; aug: boolean };
const front = (v: Variant) => (x: Float32Array) => { let y = x; if (v.den) y = denoise(y); if (v.vad) y = vad(y); return y; };
const results: Record<string, { variant: Variant; template_clips: number; ms_per_s: number; cos: Record<string, number | null> }> = {};
for (const den_ of [false, true]) for (const vad_ of [false, true]) for (const aug of [false, true]) {
  const v = { vad: vad_, den: den_, aug }, f = front(v);
  const tv = (await Promise.all([...enrol, ...(aug ? noisyEnrol : [])].map((x) => vec(f(x))))).filter((x): x is number[] => !!x).map(unit);
  const t = mean(tv);
  const c: Record<string, number | null> = {};
  let ms = 0, secs = 0;
  for (const k of clips) { const t0 = performance.now(); const e = await vec(f(k.x)); ms += performance.now() - t0; secs += k.x.length / 16000; c[k.id] = e ? r4(cos(unit(e), t)) : null; }
  // (d) Adjacent owner lines joined: each radio-part line with its next line, as a longer segment.
  const radioIds = clips.filter((k) => k.group === "owner radio").map((k) => k.id);
  for (let i = 0; i + 1 < radioIds.length; i++) {
    const a = clips.find((k) => k.id === radioIds[i])!, b = clips.find((k) => k.id === radioIds[i + 1])!;
    if (Number(b.id.slice(4)) !== Number(a.id.slice(4)) + 1) continue;
    const j = new Float32Array(a.x.length + b.x.length); j.set(a.x); j.set(b.x, a.x.length);
    const e = await vec(f(j)); c[`${a.id}+${b.id.slice(3)}`] = e ? r4(cos(unit(e), t)) : null;
  }
  results[`${den_ ? "denoise+" : ""}${vad_ ? "vad+" : ""}${aug ? "noisy-enrol+" : ""}`.replace(/\+$/, "") || "baseline"] = { variant: v, template_clips: tv.length, ms_per_s: Math.round((ms / secs) * 10) / 10, cos: c };
  process.stderr.write(`${Object.keys(results).at(-1)} done\n`);
}
writeFileSync("packages/voice/research/fixtures/v2.noise.json", `${JSON.stringify({ built_at: new Date().toISOString(), radio_snr_db: snr, denoiser: "gtcrn_simple.onnx (sherpa-onnx speech-enhancement-models release)", groups: Object.fromEntries(clips.map((k) => [k.id, { group: k.group, owner: k.owner, sha256: k.sha256, snr_db: noisySnr(k.x) }])), results }, null, 1)}\n`);
