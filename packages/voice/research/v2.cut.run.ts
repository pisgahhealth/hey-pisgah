import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeWav } from "../src/wav.js";
import { sha256Hex } from "./synth.js";
import { V2_LINES, type V2Line } from "./v2.lines.js";

// Cuts the owner's v2 recordings on the spoken ids: an offline Parakeet reading with token times, aligned word by word to the script, then one clip per line without its id.
const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const src = arg("src"), out = arg("out"), M = arg("parakeet");
type Rec = { createStream(): { acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void }; decode(s: unknown): void; getResult(s: unknown): { text: string; tokens: string[]; timestamps: number[] } };
const sherpa = createRequire(join(arg("sherpa"), "package.json"))("sherpa-onnx-node") as { OfflineRecognizer: new (c: unknown) => Rec };
const rec = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { transducer: { encoder: `${M}/encoder.int8.onnx`, decoder: `${M}/decoder.int8.onnx`, joiner: `${M}/joiner.int8.onnx` }, tokens: `${M}/tokens.txt`, numThreads: 4, provider: "cpu", debug: 0, modelType: "nemo_transducer" } });
mkdirSync(out, { recursive: true });

// afconvert's 16 kHz mono output, read from its data chunk.
function pcm(file: string): Float32Array {
  const b = readFileSync(file), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString("latin1", at, at + 4), size = v.getUint32(at + 4, true);
    if (id === "data") { const x = new Float32Array(size >> 1); for (let i = 0; i < x.length; i++) x[i] = v.getInt16(at + 8 + 2 * i, true) / 32768; return x; }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}
// Speech regions above the file's own noise floor, joined across pauses shorter than the gap.
function regions(x: Float32Array, gap = 0.9): [number, number][] {
  const f = 320, n = Math.floor(x.length / f), e = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < f; j++) s += x[i * f + j]! ** 2; e[i] = Math.sqrt(s / f); }
  const thr = Math.max([...e].sort((a, b) => a - b)[Math.floor(n * 0.1)]! * 3.5, 0.004);
  const outs: [number, number][] = [];
  let st = -1, last = -1;
  for (let i = 0; i < n; i++) if (e[i]! > thr) { if (st < 0) st = i; else if ((i - last) * 0.02 > gap) { outs.push([st, last]); st = i; } last = i; }
  if (st >= 0) outs.push([st, last]);
  return outs.map(([a, b]): [number, number] => [Math.max(0, a * 0.02 - 0.15), Math.min(x.length / 16000, (b + 1) * 0.02 + 0.2)]).filter(([a, b]) => b - a > 0.25);
}
type Word = { w: string; t: number; end: number };
function words(x: Float32Array): Word[] {
  const ws: Word[] = [];
  for (const [a, b] of regions(x)) {
    const st = rec.createStream();
    st.acceptWaveform({ sampleRate: 16000, samples: x.slice(Math.floor(a * 16000), Math.floor(b * 16000)) });
    rec.decode(st);
    const r = rec.getResult(st);
    r.tokens.forEach((tok, i) => {
      const t = a + (r.timestamps[i] ?? 0);
      if (tok.startsWith(" ") || !ws.length || ws.at(-1)!.end < a) ws.push({ w: tok.trim(), t, end: t + 0.3 });
      else { ws.at(-1)!.w += tok; ws.at(-1)!.end = t + 0.3; }
    });
    if (ws.length) ws.at(-1)!.end = Math.min(b, ws.at(-1)!.end + 0.2);
  }
  return ws.filter((w) => w.w.length);
}

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
const DIGIT: Record<string, string> = { zero: "0", oh: "0", o: "0", one: "1", two: "2", to: "2", too: "2", three: "3", four: "4", for: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
// A spoken id read at word i: "001", "zero zero one", "0 to 2"; returns its value and how many words it took.
function idAt(ws: Word[], i: number): { v: number; n: number } | null {
  const w = norm(ws[i]!.w);
  if (/^0\d{1,3}$/.test(w)) return { v: Number(w), n: 1 };
  let d = "", n = 0;
  while (n < 4 && i + n < ws.length) { const x = norm(ws[i + n]!.w); const dg = /^\d$/.test(x) ? x : DIGIT[x]; if (dg === undefined) break; d += dg; n++; }
  return d.length >= 2 && d.startsWith("0") ? { v: Number(d), n } : null;
}
const lev = (a: string, b: string) => { const d = Array.from({ length: b.length + 1 }, (_, j) => j); for (let i = 1; i <= a.length; i++) { let p = d[0]!; d[0] = i; for (let j = 1; j <= b.length; j++) { const q = d[j]!; d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = q; } } return d[b.length]!; };
const close = (a: string, b: string) => a === b || (a.startsWith("mm") && b.startsWith("mm")) ? 1 : a.length > 3 && b.length > 3 && lev(a, b) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 3)) ? 0.6 : 0;

// Aligns the heard words to the script (an id token, then the line's words, for each line) and returns each line's span of heard words.
function align(ws: Word[], lines: { id: number; words: string }[]) {
  type Tok = { line: number; id: boolean; w: string };
  const toks: Tok[] = lines.flatMap((l, k) => [{ line: k, id: true, w: String(l.id) }, ...l.words.split(/\s+/).map((w) => ({ line: k, id: false, w: norm(w) })).filter((t) => t.w)]);
  const ids = ws.map((_, i) => idAt(ws, i));
  const A = ws.length, B = toks.length, S = Array.from({ length: A + 1 }, () => new Float32Array(B + 1)), P = Array.from({ length: A + 1 }, () => new Uint8Array(B + 1));
  for (let j = 1; j <= B; j++) { S[0]![j] = S[0]![j - 1]! - 0.5; P[0]![j] = 2; }
  for (let i = 1; i <= A; i++) { S[i]![0] = S[i - 1]![0]! - 0.1; P[i]![0] = 1; }
  for (let i = 1; i <= A; i++) for (let j = 1; j <= B; j++) {
    const t = toks[j - 1]!, id = ids[i - 1];
    const m = t.id ? (id && id.v === Number(t.w) ? 4 : id && id.v % 10 === Number(t.w) % 10 ? 1.5 : -1) : close(norm(ws[i - 1]!.w), t.w) || -0.6;
    const opts = [S[i - 1]![j - 1]! + m, S[i - 1]![j]! - 0.1, S[i]![j - 1]! - 0.5];
    const k = opts.indexOf(Math.max(...opts));
    S[i]![j] = opts[k]!; P[i]![j] = k;
  }
  const hit: { word: number; tok: number }[] = [];
  for (let i = A, j = B; i > 0 || j > 0;) {
    const k = i === 0 ? 2 : j === 0 ? 1 : P[i]![j]!;
    if (k === 0) { const t = toks[j - 1]!; if (t.id ? !!ids[i - 1] : close(norm(ws[i - 1]!.w), t.w) > 0) hit.push({ word: i - 1, tok: j - 1 }); i--; j--; } else if (k === 1) i--; else j--;
  }
  hit.reverse();
  return lines.map((_, k) => {
    const mine = hit.filter((h) => toks[h.tok]!.line === k);
    const idHit = mine.find((h) => toks[h.tok]!.id);
    const wordsHit = mine.filter((h) => !toks[h.tok]!.id);
    return { id_word: idHit ? idHit.word : null, id_len: idHit ? ids[idHit.word]!.n : 0, first: wordsHit[0]?.word ?? null, last: wordsHit.at(-1)?.word ?? null, matched: wordsHit.length, of: toks.filter((t) => t.line === k && !t.id).length };
  });
}

type Plan = { file: string; block: string; lines: { line: V2Line; words: string; part: "line" | "overlap_part" }[] };
const S = V2_LINES.filter((l) => l.who === "S");
const plans: Plan[] = [
  ...["O", "Y", "K"].map((b) => ({ file: `${b}-S`, block: b, lines: S.filter((l) => l.block === b).map((line) => ({ line, words: line.words, part: "line" as const })) })),
  { file: "R-S", block: "R", lines: S.filter((l) => l.block === "R" && !l.replay_of).map((line) => ({ line, words: line.words, part: "line" as const })) },
  { file: "V-S", block: "V", lines: V2_LINES.filter((l) => l.block === "V" && (l.who === "S" || l.overlap?.who === "S")).map((line) => ({ line, words: line.who === "S" ? line.words : line.overlap!.words, part: line.who === "S" ? "line" as const : "overlap_part" as const })) }
];
type Cut = { id: string; file: string; part: string; set: string; start_s: number; end_s: number; sha256: string; heard: string; id_heard: boolean; matched: number; of: number; status: string };
const cuts: Cut[] = [];
const pcmOf: Record<string, Float32Array> = {};
for (const p of plans) {
  const x = (pcmOf[p.file] = pcm(join(src, `${p.file}.wav`)));
  const ws = words(x);
  const spans = align(ws, p.lines.map((l) => ({ id: Number(l.line.id.slice(1)), words: l.words })));
  const starts = spans.map((s) => (s.id_word !== null ? s.id_word : s.first));
  spans.forEach((s, k) => {
    const l = p.lines[k]!;
    const from = s.id_word !== null ? s.id_word + s.id_len : s.first;
    const nextStart = starts.slice(k + 1).find((v) => v !== null) ?? null;
    if (from === null || (s.matched === 0 && s.id_word === null) || (nextStart !== null && from >= nextStart) || from >= ws.length) { cuts.push({ id: l.line.id, file: p.file, part: l.part, set: l.line.set, start_s: 0, end_s: 0, sha256: "", heard: "", id_heard: s.id_word !== null, matched: s.matched, of: s.of, status: "missing" }); return; }
    // The line ends at the first pause over 1.5 s after its last matched word, so talk to someone else or the radio stays out.
    let to = (nextStart ?? ws.length) - 1;
    const lastMatched = s.last ?? from;
    for (let i = Math.max(from, lastMatched); i < to; i++) if (ws[i + 1]!.t - ws[i]!.end > 1.5) { to = i; break; }
    const a = Math.max(0, ws[from]!.t - 0.15), b = nextStart !== null ? Math.max(ws[to]!.end, ws[nextStart]!.t - 0.1) : Math.min(x.length / 16000, ws[to]!.end + 0.3);
    const end = Math.min(b, ws[to]!.end + 0.6);
    const wav = encodeWav(x.slice(Math.floor(a * 16000), Math.floor(end * 16000)), 16000);
    writeFileSync(join(out, `${l.line.id}${l.part === "overlap_part" ? "-S-part" : ""}.wav`), wav);
    const heard = ws.slice(from, to + 1).map((w) => w.w).join(" ");
    const extra = to + 1 - from - s.matched;
    const status = s.matched / s.of < 0.34 ? "words_changed" : extra > s.of * 1.5 + 4 ? "long_or_merged" : "ok";
    cuts.push({ id: l.line.id, file: p.file, part: l.part, set: l.line.set, start_s: Math.round(a * 100) / 100, end_s: Math.round(end * 100) / 100, sha256: sha256Hex(wav), heard, id_heard: s.id_word !== null, matched: s.matched, of: s.of, status });
  });
}

// The phone replays copy the whole R-S file, so each is cut at the original's times plus the lag found by cross-correlating the two energy envelopes.
const env = (x: Float32Array) => { const n = Math.floor(x.length / 160), e = new Float32Array(n); for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < 160; j++) s += Math.abs(x[i * 160 + j]!); e[i] = Math.log(1e-4 + s / 160); } const m = e.reduce((a, b) => a + b, 0) / n; return e.map((v) => v - m); };
// Pearson correlation of the envelopes over lags within 30 s, needing at least 20 s of overlap.
function lagOf(a: Float32Array, b: Float32Array, from = 0, len = a.length): { lag_s: number; score: number } {
  let best = -Infinity, lag = 0;
  for (let L = -3000; L <= 3000; L++) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
    for (let i = from; i < Math.min(a.length, from + len); i++) { const j = i + L; if (j < 0 || j >= b.length) continue; const x = a[i]!, y = b[j]!; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; n++; }
    if (n < 2000) continue;
    const r = (sab - (sa * sb) / n) / Math.sqrt((saa - (sa * sa) / n) * (sbb - (sb * sb) / n) || 1);
    if (r > best) { best = r; lag = L; }
  }
  return { lag_s: lag * 0.01, score: Math.round(best * 1000) / 1000 };
}
const replays: Record<string, unknown> = {};
const orig = env(pcmOf["R-S"]!);
for (const [file, at, base] of [["R-S-replay", "near", 10], ["R-S-replay-1.5", "far", 20]] as const) {
  const y = pcm(join(src, `${file}.wav`)), e = env(y);
  const whole = lagOf(orig, e), first = lagOf(orig, e, 0, Math.floor(orig.length / 2)), second = lagOf(orig, e, Math.floor(orig.length / 2), Math.floor(orig.length / 2));
  replays[file] = { at, whole, first_half: first, second_half: second };
  for (const c of cuts.filter((x) => x.file === "R-S" && x.status !== "missing")) {
    const n = Number(c.id.slice(1));
    const mid = whole.lag_s;
    const a = c.start_s + mid, b = c.end_s + mid;
    const id = `R${String(n + base).padStart(3, "0")}`;
    if (a < 0 || b * 16000 > y.length) { cuts.push({ id, file, part: "replay", set: "held_out", start_s: 0, end_s: 0, sha256: "", heard: "", id_heard: false, matched: 0, of: c.of, status: "missing" }); continue; }
    const wav = encodeWav(y.slice(Math.floor(a * 16000), Math.floor(b * 16000)), 16000);
    writeFileSync(join(out, `${id}.wav`), wav);
    cuts.push({ id, file, part: "replay", set: "held_out", start_s: Math.round(a * 100) / 100, end_s: Math.round(b * 100) / 100, sha256: sha256Hex(wav), heard: "", id_heard: false, matched: 0, of: c.of, status: "ok" });
  }
}
writeFileSync(arg("manifest"), `${JSON.stringify({ cut_at: new Date().toISOString(), converted: "afconvert to 16 kHz mono 16-bit WAV", reader: "Parakeet TDT 0.6B v2 int8, offline, to find the ids", replays, cuts }, null, 1)}\n`);
const count = (s: string) => cuts.filter((c) => c.status === s).length;
process.stderr.write(`${cuts.length} cuts: ok ${count("ok")}, words changed ${count("words_changed")}, long or merged ${count("long_or_merged")}, missing ${count("missing")}\n`);
