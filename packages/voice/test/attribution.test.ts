import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { denyHits } from "@hey-pisgah/agent";
import { LINES, ownerInstruction } from "../research/lines.js";
import { READERS, SV_RULE, scoreReader, svSpeaker, type ClipReading } from "../research/score.js";
import { SPARK_PROMPTS } from "../research/spark.js";
import { MISSING, REAL } from "../research/real.lines.js";
import { byVoice, numberAccuracy, realLines, tuneOwnerMin, voiceGroups, wordError, type Voices } from "../research/real.score.js";

const root = join(import.meta.dirname, "..", "..", "..");
const research = join(import.meta.dirname, "..", "research");
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const final = json(join(research, "fixtures", "final.readings.json")) as { clips: ClipReading[] };
const tuning = json(join(research, "fixtures", "tuning.readings.json")) as { clips: ClipReading[] };
const manifest = json(join(research, "synthetic-set.json")) as { clips: { id: string; line: string | null; set: string; sha256: string }[] };
const published = json(join(root, "evaluation", "results", "attribution.json"));

describe("the labelled multi-speaker set", () => {
  it("holds 24 tuning lines and 60 held-out lines with unique ids and labels on each", () => {
    expect(LINES.filter((l) => l.set === "tuning")).toHaveLength(24);
    expect(LINES.filter((l) => l.set === "final")).toHaveLength(60);
    expect(LINES.filter((l) => l.set === "final" && !l.synthetic_only)).toHaveLength(48);
    expect(new Set(LINES.map((l) => l.id)).size).toBe(LINES.length);
    expect(new Set(LINES.map((l) => l.who))).toEqual(new Set(["S", "B", "N", "P", "R"]));
    expect(LINES.filter((l) => l.set === "final" && ownerInstruction(l))).toHaveLength(14);
  });

  it("keeps tuning and held-out audio apart by file hash", () => {
    const hashes = (set: string) => new Set(manifest.clips.filter((c) => c.set === set).map((c) => c.sha256));
    const held = hashes("final");
    expect(held.size).toBe(60);
    for (const h of [...hashes("tuning"), ...hashes("enrolment")]) expect(held.has(h)).toBe(false);
    expect(final.clips.map((c) => c.sha256).sort()).toEqual([...held].sort());
    expect(tuning.clips.every((c) => !held.has(c.sha256))).toBe(true);
    expect(published.held_out.map((x: { sha256: string }) => x.sha256).sort()).toEqual([...held].sort());
  });
});

describe("the three readers scored on the held-out set", () => {
  it("reproduces every published score from the kept readings", () => {
    expect(READERS.map((r) => scoreReader(r, final.clips))).toEqual(published.scores);
  });

  it("finds false authority only where the speaker is assumed or read from the audio by Spark", () => {
    const fa = Object.fromEntries(READERS.map((r) => [r, scoreReader(r, final.clips).false_authority.n]));
    expect(fa.transcript_gate).toBeGreaterThan(0);
    expect(fa.spark_audio).toBeGreaterThan(0);
    expect(fa.local_sv_plus_gate).toBe(0);
    expect(fa.local_sv_plus_spark).toBe(0);
  });

  it("goes red when the local model is made to call every voice the owner (negative control)", () => {
    const fooled = final.clips.map((c) => ({ ...c, sv: c.sv ? { ...c.sv, scores: { S: 0.99, B: 0, N: 0 } } : null }));
    expect(svSpeaker({ S: 0.99, B: 0, N: 0 })).toBe("owner");
    expect(scoreReader("local_sv_plus_gate", fooled).false_authority.n).toBe(scoreReader("transcript_gate", final.clips).false_authority.n);
  });

  it("records which model read each clip for each decision", () => {
    for (const c of published.per_clip) {
      expect(c.calls.voice_transcribe.model).toBe("muse-voice-transcribe-1.0");
      expect(c.calls.spark_audio.model).toMatch(/^(modal:meta-models\/Muse-Spark-Open-816B-A42B|meta:muse-spark-1\.3)$/);
      expect(c.calls.local_sv.model).toBe(`local:${SV_RULE.model}`);
      for (const r of READERS) expect(Object.keys(c.readers[r].models).sort()).toEqual(["intent", "speaker", "words"]);
    }
  });
});

describe("prompts and storage", () => {
  it("every prompt passes the deny-list scan", () => {
    for (const p of Object.values(SPARK_PROMPTS)) expect(denyHits(p)).toEqual([]);
    for (const l of LINES) expect(denyHits(`${l.words} ${l.overlap?.words ?? ""}`)).toEqual([]);
  });

  it("stores no audio: no WAV in the research folder and no audio data in any kept reading", () => {
    const files = readdirSync(research, { recursive: true }).map(String);
    expect(files.filter((f) => /\.(wav|m4a|mp3|flac)$/i.test(f))).toEqual([]);
    for (const f of files.filter((x) => x.endsWith(".json"))) expect(readFileSync(join(research, f), "utf8")).not.toMatch(/data:audio|UklGR/);
    expect(JSON.stringify(published)).not.toMatch(/data:audio|UklGR/);
  });
});

describe("Samuel's real recordings", () => {
  const real = json(join(research, "real-set.json")) as { counts: Record<string, unknown>; clips: { id: string; line: string | null; set: string; sha256: string; source_sha256: string; said: string; values: string[]; heard: { voice_transcribe: string | null; parakeet: string | null } }[] };
  const kept = json(join(research, "fixtures", "real.readings.json")) as { clips: ClipReading[] };
  const voices = json(join(research, "fixtures", "real.voices.json")) as Voices;
  const out = json(join(root, "evaluation", "results", "attribution-real.json"));
  const lines = realLines(REAL);
  const held = kept.clips.filter((c) => c.id.startsWith("H")), tune = kept.clips.filter((c) => c.id.startsWith("T"));
  const ids = (set: string) => real.clips.filter((c) => c.set === set).map((c) => c.id);

  it("accounts for every file: 60 sources, 12 joined, 70 scripted lines found, H39 and H44 missing, none unusable", () => {
    expect(real.counts).toMatchObject({ source_files: 60, joined_files: 12, clips: 74, lines_found: 70, tuning: 24, held_out: 46, lines_from_joined_files: 25, missing: ["H39", "H44"], unusable: [] });
    for (const c of real.clips.filter((x) => x.line)) expect(LINES.some((l) => l.id === c.line && !l.synthetic_only)).toBe(true);
    expect(MISSING).toEqual(["H39", "H44"]);
  });

  it("keeps held-out clips apart from tuning and enrolment by hash, and the readings match the manifest", () => {
    const h = new Set(real.clips.filter((c) => c.set === "final").map((c) => c.sha256));
    expect(h.size).toBe(46);
    for (const c of real.clips.filter((x) => x.set !== "final")) expect(h.has(c.sha256)).toBe(false);
    expect(out.held_out.map((x: { sha256: string }) => x.sha256).sort()).toEqual([...h].sort());
    for (const c of kept.clips) expect(real.clips.find((m) => m.id === c.id)!.sha256).toBe(c.sha256);
  });

  it("reproduces the voice check, the tuned rule and the gate scores from the kept readings", () => {
    expect(voiceGroups(voices)).toEqual(out.voices.groups);
    const tuned = { ...SV_RULE, ...tuneOwnerMin(voices), owner_margin: 0, other_min: 1 };
    expect(tuned).toEqual(out.voices.tuned_rule);
    expect(byVoice(voices, ids("final"), tuned)).toEqual(out.voices.held_out_tuned);
    expect(byVoice(voices, ids("final"), SV_RULE)).toEqual(out.voices.held_out_frozen);
    expect(scoreReader("transcript_gate", held, lines)).toEqual(out.gate.held_out);
    expect(scoreReader("transcript_gate", tune, lines)).toEqual(out.gate.tuning);
  });

  it("sets the owner rule from the tuning lines alone (negative control: moving held-out scores changes nothing)", () => {
    const moved = { ...voices, clips: Object.fromEntries(Object.entries(voices.clips).map(([id, r]) => [id, id.startsWith("H") ? { ...r, cos_owner: 0.01 } : r])) };
    expect(tuneOwnerMin(moved)).toEqual(tuneOwnerMin(voices));
    const t = { ...voices, clips: Object.fromEntries(Object.entries(voices.clips).map(([id, r]) => [id, id === "T15" ? { ...r, cos_owner: 0.5 } : r])) };
    expect(tuneOwnerMin(t).owner_min).not.toBe(tuneOwnerMin(voices).owner_min);
  });

  it("goes red when the second voice is scored as the owner's (negative control)", () => {
    const tuned = { ...SV_RULE, ...tuneOwnerMin(voices), owner_margin: 0, other_min: 1 };
    expect(byVoice(voices, ids("final"), tuned).second_voice_passed.n).toBe(0);
    const fooled = { ...voices, clips: Object.fromEntries(Object.entries(voices.clips).map(([id, r]) => [id, r.cluster === "second" ? { ...r, cos_owner: 0.6 } : r])) };
    expect(byVoice(fooled, ids("final"), tuned).second_voice_passed.n).toBe(4);
  });

  it("scores numbers and words from the kept transcripts, and tells a lost number from a misheard one", () => {
    const scripted = real.clips.filter((c) => c.line);
    const vt = (id: string) => (kept.clips.find((c) => c.id === id)!.transcript as unknown as { raw: string }).raw;
    expect(numberAccuracy(scripted.map((c) => ({ id: c.id, values: c.values, heard: vt(c.id) })))).toEqual(out.asr.numbers_voice_transcribe);
    expect(wordError(scripted.map((c) => ({ id: c.id, ref: c.said, hyp: vt(c.id) })))).toEqual(out.asr.voice_transcribe.all);
    expect(numberAccuracy([{ id: "x", values: ["130"], heard: "record 130 over 85" }]).right_after_normaliser).toBe(1);
    expect(numberAccuracy([{ id: "x", values: ["130"], heard: "record one thirty over eighty five" }]).lost_by_normaliser).toBe(1);
    expect(numberAccuracy([{ id: "x", values: ["130"], heard: "record one three over eighty five" }]).heard).toBe(0);
  });

  it("keeps no voice embedding and passes the deny-list scan on every word said or heard", () => {
    expect(readFileSync(join(research, "fixtures", "real.voices.json"), "utf8")).not.toMatch(/embedding|windows/);
    for (const c of real.clips) expect(denyHits(`${c.said} ${c.heard.voice_transcribe ?? ""} ${c.heard.parakeet ?? ""}`)).toEqual([]);
  });
});
