import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeWav, encodeWav } from "@hey-pisgah/voice";
import { isTalk, loadJourney } from "./script.js";

// Renders each talk line of the journey with macOS say at 16 kHz, one WAV per line, and a manifest of files and hashes.
export function renderJourney(outDir: string, file?: string): { id: string; owner: string; wav: string; ms: number; sha256: string }[] {
  const s = loadJourney(file);
  mkdirSync(outDir, { recursive: true });
  const out: { id: string; owner: string; wav: string; ms: number; sha256: string }[] = [];
  for (const t of s.steps.filter(isTalk)) {
    const raw = join(outDir, `${t.id}.raw.wav`);
    execFileSync("say", ["-v", s.voice, "-o", raw, "--file-format=WAVE", `--data-format=LEI16@${s.sample_rate}`, t.say]);
    const { samples } = decodeWav(readFileSync(raw));
    const quiet = new Float32Array(Math.round(0.7 * s.sample_rate));
    const all = new Float32Array(samples.length + quiet.length);
    all.set(samples);
    const wav = encodeWav(all, s.sample_rate);
    const f = join(outDir, `${t.id}.wav`);
    writeFileSync(f, wav);
    out.push({ id: t.id, owner: t.owner, wav: f, ms: Math.round((all.length / s.sample_rate) * 1000), sha256: createHash("sha256").update(wav).digest("hex") });
  }
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify({ journey_id: s.journey_id, lines: out }, null, 1)}\n`);
  return out;
}

if (process.argv[1]?.endsWith("render.ts")) {
  const dir = process.argv[2];
  if (!dir) { console.log("usage: render.ts <out dir>"); process.exit(1); }
  const r = renderJourney(dir);
  console.log(`${r.length} lines, ${(r.reduce((k, x) => k + x.ms, 0) / 1000).toFixed(1)} s`);
}
