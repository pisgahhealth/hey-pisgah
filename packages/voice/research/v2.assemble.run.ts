import { readFileSync, writeFileSync } from "node:fs";
import { thresholdsAt } from "./thresholds.js";
import { cleanTranscript } from "../src/numbers.js";
import { numbersIn, vitalsVocabulary } from "../src/vitals.js";
import { V2_LINES, v2Counts } from "./v2.lines.js";
import { scoreV2, type V2Row } from "./v2.score.js";

// Scores the kept v2 readings against the threshold revision frozen before they were built, per source, and writes the public result.
const fx = JSON.parse(readFileSync("packages/voice/research/fixtures/v2.readings.json", "utf8")) as { built_at: string; rows: V2Row[] };
const rev = thresholdsAt(fx.built_at);
if (!rev) throw new Error("no threshold revision was frozen before this set was built");
const of = (s: V2Row["source"]) => fx.rows.filter((r) => r.source === s);
// Values in the owner's v2 lines: the script's, Voice Transcribe's and the offline Parakeet reading's, after the shipped normaliser.
const cutHeard = Object.fromEntries((JSON.parse(readFileSync("packages/voice/research/v2-real-set.json", "utf8")) as { cuts: { id: string; part: string; heard: string }[] }).cuts.map((c) => [`${c.id}${c.part === "overlap_part" ? "-part" : ""}`, c.heard]));
const vals = (t: string) => numbersIn(vitalsVocabulary(cleanTranscript(t)).text);
function numbers(rows: V2Row[]) {
  // Lines Voice Transcribe never read (the re-recordings, scored with no model call) are left out of the number count.
  const per = rows.filter((r) => r.replay === null && r.usable !== false && !r.id.endsWith("-part") && !r.reading.transcript.error).map((r) => {
    const id = r.id.replace(/^v2-/, "").replace(/-redo$/, ""), line = V2_LINES.find((l) => l.id === id)!;
    const want = vals(line.words), vt = vals(r.reading.transcript.text), pk = vals(cutHeard[id] ?? "");
    return { id, want, vt, pk };
  }).filter((x) => x.want.length);
  const total = per.reduce((n, x) => n + x.want.length, 0);
  const hit = (k: "vt" | "pk") => per.reduce((n, x) => n + x.want.filter((v) => x[k].includes(v)).length, 0);
  // A value both ears heard the same way but the script did not have is most likely what was said.
  const saidOtherwise = per.flatMap((x) => x.want.filter((v) => !x.vt.includes(v) && !x.pk.includes(v)).length && x.vt.some((v) => x.pk.includes(v) && !x.want.includes(v)) ? [x.id] : []);
  return { lines: per.length, values: total, voice_transcribe_heard: hit("vt"), parakeet_heard: hit("pk"), both_ears_agree_off_script: saidOtherwise, misses: per.filter((x) => x.want.some((v) => !x.vt.includes(v))).map((x) => ({ id: x.id, script: x.want, voice_transcribe: x.vt, parakeet: x.pk })) };
}
const cost = fx.rows.reduce((n, r) => n + (r.reading.transcript.cost_usd ?? 0) + (r.reading.gate.cost_usd ?? 0), 0);
writeFileSync("evaluation/results/attribution-v2.json", `${JSON.stringify({
  thresholds: { revision: rev.revision, hash: rev.hash, frozen_at: rev.frozen_at }, built_at: fx.built_at,
  script: v2Counts(),
  synthetic: scoreV2(of("synthetic"), rev.body.speaker), real: scoreV2(of("real"), rev.body.speaker),
  owner_v2: { held_out: scoreV2(of("owner_v2"), rev.body.speaker), tuning: scoreV2(of("owner_v2"), rev.body.speaker, "tuning"), numbers: numbers(of("owner_v2")) },
  reading_cost_usd_kept_rows: Math.round(cost * 1e4) / 1e4
}, null, 1)}\n`);
console.log("written");
