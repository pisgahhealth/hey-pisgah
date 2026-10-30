import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { wordError } from "./real.score.js";
import { armStats, armSummary, changedWords, type ProbeCall, valuesOf } from "./stability.score.js";

// Publishes evaluation/results/transcribe-stability.json: the R1.b run-to-run figure from the two kept readings (no spend), and the probe's arms.
const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const callsFile = arg("calls"), out = arg("out", "evaluation/results/transcribe-stability.json"), clipsFile = arg("clips-manifest");

type R1 = { id: string; line: string | null; sha256: string; heard: { voice_transcribe: string | null }; values: string[] };
const set = (JSON.parse(readFileSync("packages/voice/research/real-set.json", "utf8")) as { clips: R1[] }).clips.filter((c) => c.line);
const second = (JSON.parse(readFileSync("packages/voice/research/fixtures/real.readings.json", "utf8")) as { clips: { id: string; sha256: string; transcript: { raw: string } }[] }).clips;
const pairs = set.map((c) => ({ id: c.id, ref: c.heard.voice_transcribe ?? "", hyp: second.find((x) => x.id === c.id)?.transcript.raw ?? "" })).filter((p) => p.ref || p.hyp);
const w = wordError(pairs);
const valuesMoved = pairs.filter((p) => valuesOf(p.ref).join(",") !== valuesOf(p.hyp).join(",")).map((p) => p.id);
const r1b = {
  source: "run 1 = packages/voice/research/real-set.json heard.voice_transcribe (R1.b first pass, three at a time, hashes not checked by that pass); run 2 = fixtures/real.readings.json transcript.raw (hash-checked); both with the vitals hints, PUSH_TO_TALK, fresh session ids",
  clips: pairs.length, clips_with_any_word_change: pairs.filter((p) => wordError([p]).errors > 0).length, clips_raw_string_differs: pairs.filter((p) => p.ref !== p.hyp).length,
  ref_words: w.ref_words, word_edits: w.errors, run_to_run_word_rate: w.wer, clips_values_moved: valuesMoved, top_changes: w.misheard.slice(0, 12)
};

let probe: Record<string, unknown> | null = null;
if (callsFile && existsSync(callsFile)) {
  const calls = readFileSync(callsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ProbeCall);
  const clips = [...new Set(calls.map((c) => c.clip))];
  const arms = [...new Set(calls.map((c) => c.arm))];
  const byArm: Record<string, Record<string, ReturnType<typeof armStats>>> = {};
  for (const a of arms) byArm[a] = Object.fromEntries(clips.map((id) => [id, armStats(calls.filter((c) => c.arm === a && c.clip === id))]).filter(([, s]) => (s as { calls: number }).calls));
  // A1 and E together: the same request across about two hours.
  const across = (a: string, b: string) => Object.fromEntries(clips.map((id) => {
    const x = calls.filter((c) => (c.arm === a || c.arm === b) && c.clip === id && c.raw !== null && !c.voided);
    const onlyB = x.filter((c) => c.arm === b).map((c) => c.raw!), onlyA = x.filter((c) => c.arm === a).map((c) => c.raw!);
    return [id, { strings_in_b_not_seen_in_a: onlyB.filter((r) => !onlyA.includes(r)).length, of: onlyB.length, together: armStats(x) }];
  }));
  const hintWords = (id: string) => ({ hinted: changedWords(calls.filter((c) => c.arm === "A1" && c.clip === id && c.raw).map((c) => c.raw!)), unhinted: changedWords(calls.filter((c) => c.arm === "B" && c.clip === id && c.raw).map((c) => c.raw!)) });
  const billed = calls.filter((c) => !c.voided).reduce((n, c) => n + c.cost_usd, 0);
  probe = {
    clips_manifest: clipsFile ? JSON.parse(readFileSync(clipsFile, "utf8")) : null,
    calls: calls.length, voided_429: calls.filter((c) => c.voided).map((c) => ({ arm: c.arm, clip: c.clip, n: c.n, at: c.at })), failed: calls.filter((c) => c.raw === null && !c.voided).map((c) => ({ arm: c.arm, clip: c.clip, n: c.n, status: c.status })),
    cost_usd: Math.round(billed * 1e6) / 1e6, summary: Object.fromEntries(arms.map((a) => [a, armSummary(byArm[a]!)])), per_clip: byArm,
    a1_against_a2: across("A1", "A2"), a1_against_e: arms.includes("E") ? across("A1", "E") : null, b_changed_words: Object.fromEntries(clips.map((id) => [id, hintWords(id)]))
  };
}
writeFileSync(out, `${JSON.stringify({ generated_by: "packages/voice/research/stability.publish.run.ts", model: "muse-voice-transcribe-1.0", r1b_run_to_run: r1b, probe }, null, 1)}\n`);
process.stderr.write(`R1.b: ${r1b.clips_with_any_word_change} of ${r1b.clips} clips changed, word rate ${r1b.run_to_run_word_rate}\n`);
