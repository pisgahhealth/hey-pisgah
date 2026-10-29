import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REAL } from "./real.lines.js";
import { byVoice, numberAccuracy, onlyOwner, realLines, tuneOwnerMin, voiceGroups, wordError, words, type Voices } from "./real.score.js";
import { SV_RULE, scoreReader, verdict, type ClipReading } from "./score.js";

// Turns the private readings of the real recordings into the kept fixtures (no audio, no voice embeddings) and the published scores.
const dir = ".hey-pisgah/r1-real";
const research = "packages/voice/research";
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const manifest = json(join(research, "real-set.json")) as { clips: { id: string; set: string; sha256: string; said: string; said_unsure: boolean; script: string | null; values: string[]; heard: { voice_transcribe: string | null; parakeet: string | null } }[] };

const emb = json(join(dir, "emb-titanet.json")) as { clips: Record<string, { ms: number }> };
const ms = Object.values(emb.clips).map((c) => c.ms).sort((a, b) => a - b);
const svMs = { p50: ms[Math.ceil(ms.length / 2) - 1], p90: ms[Math.ceil(ms.length * 0.9) - 1], clips: ms.length };
const raw = json(join(dir, "voices.json")) as { model: string; clips: Record<string, { who: string; cos_owner: number; pitch_hz: number | null }>; two_clusters: string[][] };
const second = new Set(raw.two_clusters[0]);
const voices: Voices = { model: SV_RULE.model, clips: Object.fromEntries(Object.entries(raw.clips).map(([id, r]) => [id, { who: r.who, cos_owner: r.cos_owner, pitch_hz: r.pitch_hz, cluster: second.has(id) ? "second" : "main" }])) };
writeFileSync(join(research, "fixtures", "real.voices.json"), `${JSON.stringify({ model: voices.model, template: "mean of E1 to E3, the owner only", two_cluster_split: "average-linkage cosine on every clip, cut at two, labels unseen", clips: voices.clips }, null, 1)}\n`);

const readings = ["tuning", "final"].flatMap((s) => (json(join(dir, "readings", `${s}.json`)) as { clips: Omit<ClipReading, "sv">[] }).clips);
const clips: ClipReading[] = readings.map((c) => ({ ...c, spark: { ...c.spark, raw: "" }, sv: { model: SV_RULE.model, scores: onlyOwner(voices.clips[c.id]!.cos_owner), ms: 0 } }) as ClipReading).sort((a, b) => a.id.localeCompare(b.id));
for (const c of clips) if (manifest.clips.find((m) => m.id === c.id)?.sha256 !== c.sha256) throw new Error(`${c.id} reading does not match the manifest hash`);
writeFileSync(join(research, "fixtures", "real.readings.json"), `${JSON.stringify({ run_ids: ["run-r1brtun1", "run-r1brfin1"], readers: "Voice Transcribe then the shipped gate; Spark skipped", clips }, null, 1)}\n`);

const lines = realLines(REAL);
const tuned = { ...SV_RULE, ...tuneOwnerMin(voices), owner_margin: 0, other_min: 1 };
const ids = (set: string) => manifest.clips.filter((c) => c.set === set).map((c) => c.id);
const held = clips.filter((c) => c.id.startsWith("H")), tune = clips.filter((c) => c.id.startsWith("T"));

// Intent with the speaker set aside: the gate acts exactly on the lines that ask the agent to do something.
const intent = (cs: ClipReading[]) => {
  const rows = cs.map((c) => { const l = lines.find((x) => x.id === c.id)!; return { id: c.id, truth: l.kind === "instruction" && l.addressee === "agent", acts: verdict("transcript_gate", c).owner_instruction, kinded: c.gate.clauses.some((x) => (x.class === "instruction" || x.class === "correction") && x.kind && (x.confidence ?? 0) >= 0.7) }; });
  const pos = rows.filter((r) => r.truth), neg = rows.filter((r) => !r.truth);
  return { clips: rows.length, right: rows.filter((r) => r.acts === r.truth).length, instructions_acted: { n: pos.filter((r) => r.acts).length, of: pos.length, missed: pos.filter((r) => !r.acts).map((r) => r.id) }, acted_on_non_instructions: { n: neg.filter((r) => r.acts).length, of: neg.length, ids: neg.filter((r) => r.acts).map((r) => r.id), with_an_action_kind: neg.filter((r) => r.acts && r.kinded).map((r) => r.id) } };
};

const scripted = manifest.clips.filter((c) => c.set === "tuning" || c.set === "final");
const pairs = (pick: (c: (typeof scripted)[number]) => string | null, sure: boolean) => scripted.filter((c) => !sure || !c.said_unsure).map((c) => ({ id: c.id, ref: c.said, hyp: pick(c) ?? "" }));
const vtRaw = (c: { id: string }) => (clips.find((x) => x.id === c.id) as unknown as { transcript: { raw: string } }).transcript.raw;

const asr = {
  reference: "what was said, reconstructed from both transcribers and the script without listening; the unsure lines are left out of the sure count",
  voice_transcribe: { all: wordError(pairs(vtRaw, false)), sure: wordError(pairs(vtRaw, true)) },
  parakeet_offline: { all: wordError(pairs((c) => c.heard.parakeet, false)), sure: wordError(pairs((c) => c.heard.parakeet, true)) },
  said_vs_script: wordError(scripted.map((c) => ({ id: c.id, ref: c.script ?? "", hyp: c.said }))),
  numbers_voice_transcribe: numberAccuracy(scripted.map((c) => ({ id: c.id, values: c.values, heard: vtRaw(c) }))),
  numbers_parakeet: numberAccuracy(scripted.map((c) => ({ id: c.id, values: c.values, heard: c.heard.parakeet ?? "" }))),
  voice_transcribe_rerun: { clips: scripted.length, words_differ: scripted.filter((c) => words(c.heard.voice_transcribe ?? "").join(" ") !== words(vtRaw(c)).join(" ")).map((c) => c.id) }
};

const out = {
  set: "Samuel's recordings, 29 Oct 2026", model: SV_RULE.model,
  held_out: held.map((c) => ({ id: c.id, sha256: c.sha256 })),
  voices: { local_model_ms: svMs, groups: voiceGroups(voices), second_voice: [...second].sort(), tuned_rule: tuned, frozen_rule: SV_RULE,
    held_out_frozen: byVoice(voices, ids("final"), SV_RULE), held_out_tuned: byVoice(voices, ids("final"), tuned), tuning_tuned: byVoice(voices, ids("tuning"), tuned) },
  gate: { held_out: scoreReader("transcript_gate", held, lines), tuning: scoreReader("transcript_gate", tune, lines), intent_held_out: intent(held), intent_tuning: intent(tune) },
  asr
};
writeFileSync("evaluation/results/attribution-real.json", `${JSON.stringify(out, null, 1)}\n`);
process.stdout.write(`${JSON.stringify({ voices: out.voices, intent: [out.gate.intent_held_out, out.gate.intent_tuning], gate_h: { addr: out.gate.held_out.addressee_accuracy, agent: out.gate.held_out.agent_vs_not, lat: out.gate.held_out.latency_ms, cost: out.gate.held_out.cost_usd, fa: out.gate.held_out.false_authority }, wer: { vt: [asr.voice_transcribe.all.wer, asr.voice_transcribe.sure.wer, asr.voice_transcribe.sure.ref_words], pk: [asr.parakeet_offline.all.wer, asr.parakeet_offline.sure.wer], script: asr.said_vs_script.wer }, num: [asr.numbers_voice_transcribe, asr.numbers_parakeet.heard, asr.numbers_parakeet.right_after_normaliser], rerun: asr.voice_transcribe_rerun.words_differ.length }, null, 1)}\n`);
