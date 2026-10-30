import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeWav } from "../src/wav.js";
import { sha256Hex } from "./synth.js";
import { V2_LINES, type V2Line } from "./v2.lines.js";
import { align, parakeet, pcm, words } from "./v2.cut.lib.js";

// Cuts the owner's v2 recordings on the spoken ids: an offline Parakeet reading with token times, aligned word by word to the script, then one clip per line without its id.
const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const src = arg("src"), out = arg("out"), M = arg("parakeet");
const rec = parakeet(arg("sherpa"), M);
mkdirSync(out, { recursive: true });

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
  const ws = words(rec, x);
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
