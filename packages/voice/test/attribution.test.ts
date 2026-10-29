import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { denyHits } from "@hey-pisgah/agent";
import { LINES, ownerInstruction } from "../research/lines.js";
import { READERS, SV_RULE, scoreReader, svSpeaker, type ClipReading } from "../research/score.js";
import { SPARK_PROMPTS } from "../research/spark.js";

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
