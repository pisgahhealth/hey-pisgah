import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// Shared by the v2 cutters: read afconvert WAVs, find speech, read words with token times offline, and align them to the script on the spoken ids.
export type Rec = { createStream(): { acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void }; decode(s: unknown): void; getResult(s: unknown): { text: string; tokens: string[]; timestamps: number[] } };
export function parakeet(sherpaDir: string, M: string): Rec {
  const sherpa = createRequire(join(sherpaDir, "package.json"))("sherpa-onnx-node") as { OfflineRecognizer: new (c: unknown) => Rec };
  return new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { transducer: { encoder: `${M}/encoder.int8.onnx`, decoder: `${M}/decoder.int8.onnx`, joiner: `${M}/joiner.int8.onnx` }, tokens: `${M}/tokens.txt`, numThreads: 4, provider: "cpu", debug: 0, modelType: "nemo_transducer" } });
}

// afconvert's 16 kHz mono output, read from its data chunk.
export function pcm(file: string): Float32Array {
  const b = readFileSync(file), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString("latin1", at, at + 4), size = v.getUint32(at + 4, true);
    if (id === "data") { const x = new Float32Array(size >> 1); for (let i = 0; i < x.length; i++) x[i] = v.getInt16(at + 8 + 2 * i, true) / 32768; return x; }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}
// Speech regions above the file's own noise floor, joined across pauses shorter than the gap.
export function regions(x: Float32Array, gap = 0.9): [number, number][] {
  const f = 320, n = Math.floor(x.length / f), e = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < f; j++) s += x[i * f + j]! ** 2; e[i] = Math.sqrt(s / f); }
  const thr = Math.max([...e].sort((a, b) => a - b)[Math.floor(n * 0.1)]! * 3.5, 0.004);
  const outs: [number, number][] = [];
  let st = -1, last = -1;
  for (let i = 0; i < n; i++) if (e[i]! > thr) { if (st < 0) st = i; else if ((i - last) * 0.02 > gap) { outs.push([st, last]); st = i; } last = i; }
  if (st >= 0) outs.push([st, last]);
  return outs.map(([a, b]): [number, number] => [Math.max(0, a * 0.02 - 0.15), Math.min(x.length / 16000, (b + 1) * 0.02 + 0.2)]).filter(([a, b]) => b - a > 0.25);
}
export type Word = { w: string; t: number; end: number };
export function words(rec: Rec, x: Float32Array): Word[] {
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

export const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
const DIGIT: Record<string, string> = { zero: "0", oh: "0", o: "0", one: "1", two: "2", to: "2", too: "2", three: "3", four: "4", for: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
// A spoken id read at word i: "001", "zero zero one", "0 to 2"; returns its value and how many words it took.
export function idAt(ws: Word[], i: number): { v: number; n: number } | null {
  const w = norm(ws[i]!.w);
  if (/^0\d{1,3}$/.test(w)) return { v: Number(w), n: 1 };
  let d = "", n = 0;
  while (n < 4 && i + n < ws.length) { const x = norm(ws[i + n]!.w); const dg = /^\d$/.test(x) ? x : DIGIT[x]; if (dg === undefined) break; d += dg; n++; }
  return d.length >= 2 && d.startsWith("0") ? { v: Number(d), n } : null;
}
const lev = (a: string, b: string) => { const d = Array.from({ length: b.length + 1 }, (_, j) => j); for (let i = 1; i <= a.length; i++) { let p = d[0]!; d[0] = i; for (let j = 1; j <= b.length; j++) { const q = d[j]!; d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = q; } } return d[b.length]!; };
export const close = (a: string, b: string) => a === b || (a.startsWith("mm") && b.startsWith("mm")) ? 1 : a.length > 3 && b.length > 3 && lev(a, b) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 3)) ? 0.6 : 0;

// Aligns the heard words to the script (an id token, then the line's words, for each line) and returns each line's span of heard words.
export function align(ws: Word[], lines: { id: number; words: string }[]) {
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

