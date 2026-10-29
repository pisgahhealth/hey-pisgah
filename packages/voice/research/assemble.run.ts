import { readFileSync, writeFileSync } from "node:fs";
import { READERS, SV_RULE, perClip, scoreReader, type ClipReading, type SvScores } from "./score.js";

// Joins one set's model readings with the local model's scores against the enrolment templates, then scores every reader.
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const set = arg("set", "tuning");
const readings = JSON.parse(readFileSync(arg("readings", `.hey-pisgah/r1/readings/${set}.json`), "utf8")) as { clips: Omit<ClipReading, "sv">[]; run_id: string; spark_system: string; concurrency: number };
const emb = JSON.parse(readFileSync(arg("embeddings", `.hey-pisgah/r1/emb/synth-${SV_RULE.model}.json`), "utf8")) as { model: string; clips: Record<string, { ms: number; embedding: number[] }> };

// A transport retry replaces only the transcript and gate readings of the clips it names, and each such clip is marked.
const retryFile = arg("retry", "");
const retry = retryFile ? (JSON.parse(readFileSync(retryFile, "utf8")) as { clips: Omit<ClipReading, "sv">[] }).clips : [];
const firstPass = readings.clips;
readings.clips = readings.clips.map((c) => { const r = retry.find((x) => x.id === c.id); return r ? { ...c, transcript: r.transcript, gate: r.gate, transport_retry: true } : c; });

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);
const unit = (a: number[]) => { const n = Math.sqrt(dot(a, a)) || 1; return a.map((v) => v / n); };
const template = (p: string) => unit([1, 2, 3].map((i) => emb.clips[`E${i}-${p}`]!.embedding).reduce((s, e) => s.map((v, k) => v + e[k]!)));
const T = { S: template("S"), B: template("B"), N: template("N") };
const round = (x: number) => Math.round(x * 1e4) / 1e4;

const withSv = (list: Omit<ClipReading, "sv">[]): ClipReading[] => list.map((c) => {
  const e = emb.clips[c.id];
  const scores: SvScores | null = e ? { S: round(dot(e.embedding, T.S)), B: round(dot(e.embedding, T.B)), N: round(dot(e.embedding, T.N)) } : null;
  return { ...c, sv: scores && e ? { model: SV_RULE.model, scores, ms: e.ms } : null } as ClipReading;
}).sort((a, b) => a.id.localeCompare(b.id));
const clips = withSv(readings.clips);
const scores = READERS.map((r) => scoreReader(r, clips));
const scoresFirstPass = retry.length ? READERS.map((r) => scoreReader(r, withSv(firstPass))) : null;
const outFile = arg("out", `.hey-pisgah/r1/readings/${set}.assembled.json`);
writeFileSync(outFile, `${JSON.stringify({ set, run_id: readings.run_id, sv_rule: SV_RULE, scores, clips }, null, 1)}\n`);
const results = arg("results", "");
if (results) {
  writeFileSync(results, `${JSON.stringify({
    study: "speaker and addressee from the clip (R1)", set, audio: "synthetic macOS say voices, five people, 24 kHz", run_id: readings.run_id,
    held_out: clips.map((c) => ({ id: c.id, sha256: c.sha256 })), sv_rule: SV_RULE, spark_concurrency: readings.concurrency,
    transport_retries: retry.map((c) => c.id), scores, scores_first_pass: scoresFirstPass, per_clip: perClip(clips)
  }, null, 1)}\n`);
}
for (const s of scores) {
  console.log(`${s.reader.padEnd(20)} spk ${s.speaker_accuracy.rate} [own ${s.per_speaker.owner.rate} oth ${s.per_speaker.other_clinician.rate} pat ${s.per_speaker.patient_or_relative.rate}] addr ${s.addressee_accuracy.rate} agent? ${s.agent_vs_not.rate} FA ${s.false_authority.n}/${s.false_authority.of} ${JSON.stringify(s.false_authority_ids)} recall ${s.owner_instruction_recall.n}/${s.owner_instruction_recall.of} pat-out ${s.patient_kept_out_of_instructions.rate} p50 ${s.latency_ms.p50} p90 ${s.latency_ms.p90} $/clip ${s.cost_usd.per_clip} err ${s.errors}`);
}
