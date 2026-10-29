import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./synth.js";
import { MISSING, REAL, UNSURE, VALUES, scriptWords } from "./real.lines.js";

// Builds the real-recording manifest from the cut plan, the source and clip hashes and both transcribers' words; no audio leaves the private folder.
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const dir = arg("dir", ".hey-pisgah/r1-real");
const out = arg("out", "packages/voice/research/real-set.json");
const key = (name: string) => name.replace(/\.m4a$/, "").replace(/\s/g, "").replace(/&/g, "+").toUpperCase();
const sources = new Map(readFileSync(join(dir, "src.sha256"), "utf8").trim().split("\n").map((l) => { const [h, ...n] = l.split("  "); const name = n.join("  "); return [key(name), { name, sha256: h! }]; }));
const vt = JSON.parse(readFileSync(join(dir, "vt.clips.json"), "utf8")) as Record<string, { raw: string; error: string | null }>;
const pk = JSON.parse(readFileSync(join(dir, "parakeet.json"), "utf8")) as Record<string, { text: string }>;

const clips = REAL.map((c) => {
  const src = sources.get(c.source);
  if (!src) throw new Error(`no source file for ${c.id}`);
  return {
    id: c.id, line: /^[TH]/.test(c.id) ? c.id : null, set: c.set, file: `${c.id}.wav`, sha256: sha256Hex(new Uint8Array(readFileSync(join(dir, "clips", `${c.id}.wav`)))),
    source: src.name, source_sha256: src.sha256, start_s: c.start_s, end_s: c.end_s,
    who: c.who, addressee: c.addressee, kind: c.kind, kind_changed: c.kind_changed, addressee_doubt: c.addressee_doubt,
    script: scriptWords(c.id), said: c.said, said_unsure: UNSURE.has(c.id), values: VALUES[c.id] ?? [],
    heard: { voice_transcribe: vt[`${c.id}.wav`]?.raw ?? null, parakeet: pk[c.id]?.text ?? null }, note: c.note
  };
});

const joined = [...sources.keys()].filter((k) => k.includes("+"));
const scored = clips.filter((c) => c.line);
const counts = {
  source_files: sources.size, joined_files: joined.length, clips: clips.length, enrolment: clips.filter((c) => c.set === "enrolment").length, extra: clips.filter((c) => c.set === "extra").length,
  lines_found: scored.length, tuning: scored.filter((c) => c.set === "tuning").length, held_out: scored.filter((c) => c.set === "final").length,
  lines_from_joined_files: scored.filter((c) => c.source.includes("&")).length, missing: MISSING, unusable: [] as string[],
  kind_changed: clips.filter((c) => c.kind_changed).map((c) => c.id), addressee_doubt: clips.filter((c) => c.addressee_doubt).map((c) => c.id)
};
writeFileSync(out, `${JSON.stringify({ recorded: "2026-10-29", converted: "afconvert to 16 kHz mono 16-bit WAV", counts, clips }, null, 1)}\n`);
process.stderr.write(`${JSON.stringify(counts)}\n`);
