import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeWav } from "../src/wav.js";
import { sha256Hex } from "./synth.js";

// Rebuilds the R1.b and v2 owner clips from Samuel's recordings as they were cut, and marks each clip whose bytes differ from its listed hash.
const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const realDir = arg("real"), v2Dir = arg("v2"), out = arg("out");
const conv = join(out, "src");
mkdirSync(conv, { recursive: true });

function pcm16(b: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12, rate = 0;
  while (at + 8 <= b.length) {
    const id = String.fromCharCode(...b.subarray(at, at + 4)), size = v.getUint32(at + 4, true);
    if (id === "fmt ") rate = v.getUint32(at + 12, true);
    if (id === "data") { const n = Math.floor(size / 2), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = v.getInt16(at + 8 + i * 2, true) / 32768; return { samples: x, sampleRate: rate }; }
    at += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}
const source = (dir: string, name: string) => {
  const src = join(conv, name.replace(/\.m4a$/, "") + ".wav");
  if (!existsSync(src)) execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", join(dir, name.endsWith(".m4a") ? name : `${name}.m4a`), src]);
  return pcm16(new Uint8Array(readFileSync(src)));
};
const cut = (s: { samples: Float32Array; sampleRate: number }, a: number | null, b: number | null) =>
  encodeWav(s.samples.slice(Math.floor((a ?? 0) * s.sampleRate), b === null ? s.samples.length : Math.min(s.samples.length, Math.floor(b * s.sampleRate))), s.sampleRate);

const manifest: Record<string, { set: string; sha256: string; ok: boolean }> = {};
type R1 = { id: string; set: string; source: string; start_s: number | null; end_s: number | null; sha256: string };
for (const c of (JSON.parse(readFileSync("packages/voice/research/real-set.json", "utf8")) as { clips: R1[] }).clips) {
  const w = cut(source(realDir, c.source), c.start_s, c.end_s);
  const ok = sha256Hex(w) === c.sha256;
  writeFileSync(join(out, `r1b-${c.id}.wav`), w);
  manifest[`r1b-${c.id}`] = { set: c.set, sha256: c.sha256, ok };
}
type V2 = { id: string; file: string; part: string; set: string; status: string; start_s: number | null; end_s: number | null; sha256: string };
for (const c of (JSON.parse(readFileSync("packages/voice/research/v2-real-set.json", "utf8")) as { cuts: V2[] }).cuts.filter((x) => x.status !== "missing" && x.part !== "replay")) {
  const w = cut(source(v2Dir, c.file), c.start_s, c.end_s);
  const ok = sha256Hex(w) === c.sha256;
  const id = `v2-${c.id}${c.part === "overlap_part" ? "-part" : ""}`;
  writeFileSync(join(out, `${id}.wav`), w);
  manifest[id] = { set: c.set, sha256: c.sha256, ok };
}
writeFileSync(join(out, "clips.json"), `${JSON.stringify(manifest, null, 1)}\n`);
const bad = Object.entries(manifest).filter(([, m]) => !m.ok).map(([k]) => k);
process.stderr.write(`${Object.keys(manifest).length} clips, ${bad.length} hash mismatches${bad.length ? `: ${bad.join(", ")}` : ""}\n`);
