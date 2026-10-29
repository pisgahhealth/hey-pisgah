import { cleanTranscript } from "../src/numbers.js";
import { numbersIn, vitalsVocabulary } from "../src/vitals.js";
import { LINES, SPEAKERS, SPEAKER_OF, ownerInstruction, type Addressee, type Line, type Speaker } from "./lines.js";

// Frozen on the tuning set (29 Oct): TitaNet-small, enrolment template = mean of three clips, whole-clip cosine.
export const SV_RULE = { model: "nemo_en_titanet_small", owner_min: 0.59, owner_margin: 0.25, other_min: 0.43 } as const;
export const CONFIDENCE_FLOOR = 0.7;

export type SvScores = { S: number; B: number; N: number };
export type Clause = { class: string; kind: string | null; confidence: number | null; words: string };
export type ClipReading = {
  id: string; line: string; sha256: string;
  transcript: { model: string; text: string; latency_ms: number; cost_usd: number; error: string | null };
  gate: { provider: string | null; model: string | null; clauses: Clause[]; latency_ms: number; cost_usd: number; fallback_reason: string | null; error: string | null };
  spark: { provider: string; model: string; reading: { words: string; speaker: Speaker; addressee: Addressee; kind: string; confidence: number } | null; latency_ms: number; cost_usd: number; fallback_reason: string | null; error: string | null };
  sv: { model: string; scores: SvScores; ms: number } | null;
};

export const READERS = ["transcript_gate", "spark_audio", "local_sv_plus_gate", "local_sv_plus_spark"] as const;
export type ReaderId = (typeof READERS)[number];
export type Verdict = { speaker: Speaker | null; addressee: Addressee | null; owner_instruction: boolean; latency_ms: number; cost_usd: number; models: Record<string, string>; error: string | null };

// Speaker from the local model: the owner only with a clear match and margin; another enrolled clinician on a weaker match; else an unenrolled voice.
export type SvRule = { model: string; owner_min: number; owner_margin: number; other_min: number };
export function svSpeaker(s: SvScores, rule: SvRule = SV_RULE): Speaker {
  const next = Math.max(s.B, s.N);
  if (s.S >= rule.owner_min && s.S - next >= rule.owner_margin) return "owner";
  return next >= rule.other_min ? "other_clinician" : "patient_or_relative";
}

// The shipped gate assumes every line is the clinician's; an instruction or correction above the floor is treated as the owner's.
export function gateVerdict(g: ClipReading["gate"]): { addressee: Addressee | null; instruction: boolean } {
  if (g.error) return { addressee: null, instruction: false };
  const cls = g.clauses.map((c) => c.class);
  const instruction = g.clauses.some((c) => (c.class === "instruction" || c.class === "correction") && (c.confidence ?? 0) >= CONFIDENCE_FLOOR);
  // The gate has no patient addressee: questions to staff and asides are both read as said to people, so they map to staff.
  const addressee: Addressee = cls.some((c) => c === "instruction" || c === "correction" || c === "unclear") ? "agent" : "staff";
  return { addressee, instruction };
}

const sparkInstr = (r: NonNullable<ClipReading["spark"]["reading"]>) => r.addressee === "agent" && r.kind === "instruction";

export function verdict(reader: ReaderId, c: ClipReading, rule: SvRule = SV_RULE): Verdict {
  const vt = c.transcript, g = c.gate, sp = c.spark;
  const gv = gateVerdict(g);
  const gateModels = { words: vt.model, intent: g.model ? `${g.provider}:${g.model}` : "none" };
  const sparkModel = `${sp.provider}:${sp.model}`;
  const sv = c.sv ? svSpeaker(c.sv.scores, rule) : null;
  switch (reader) {
    case "transcript_gate":
      return { speaker: "owner", addressee: gv.addressee, owner_instruction: gv.instruction, latency_ms: vt.latency_ms + g.latency_ms, cost_usd: vt.cost_usd + g.cost_usd, models: { ...gateModels, speaker: "assumed owner" }, error: vt.error ?? g.error };
    case "spark_audio": {
      const r = sp.reading;
      return { speaker: r?.speaker ?? null, addressee: r?.addressee ?? null, owner_instruction: !!r && r.speaker === "owner" && sparkInstr(r), latency_ms: sp.latency_ms, cost_usd: sp.cost_usd, models: { words: sparkModel, intent: sparkModel, speaker: sparkModel }, error: r ? null : sp.error ?? "unparsed" };
    }
    case "local_sv_plus_gate":
      // The local model runs alongside Voice Transcribe and finishes long before it, so the path is Voice Transcribe then the gate.
      return { speaker: sv, addressee: gv.addressee, owner_instruction: sv === "owner" && gv.instruction, latency_ms: vt.latency_ms + g.latency_ms, cost_usd: vt.cost_usd + g.cost_usd, models: { ...gateModels, speaker: `local:${c.sv?.model ?? "none"}` }, error: c.sv ? vt.error ?? g.error : "no_sv" };
    case "local_sv_plus_spark": {
      const r = sp.reading;
      return { speaker: sv, addressee: r?.addressee ?? null, owner_instruction: sv === "owner" && !!r && sparkInstr(r), latency_ms: sp.latency_ms, cost_usd: sp.cost_usd, models: { words: sparkModel, intent: sparkModel, speaker: `local:${c.sv?.model ?? "none"}` }, error: r && c.sv ? null : sp.error ?? "unparsed" };
    }
  }
}

const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!; };
const ratio = (n: number, d: number) => ({ n, of: d, rate: d ? Math.round((n / d) * 1e4) / 1e4 : null });

export type ReaderScore = ReturnType<typeof scoreReader>;
export function scoreReader(reader: ReaderId, clips: readonly ClipReading[], lines: readonly Line[] = LINES, rule: SvRule = SV_RULE) {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const rows = clips.map((c) => { const l = byId.get(c.line); if (!l) throw new Error(`no label for ${c.line}`); return { c, l, v: verdict(reader, c, rule), truth: SPEAKER_OF[l.who] }; });
  const per = Object.fromEntries(SPEAKERS.map((s) => { const xs = rows.filter((r) => r.truth === s); return [s, ratio(xs.filter((r) => r.v.speaker === s).length, xs.length)]; }));
  const non = rows.filter((r) => r.truth !== "owner");
  const probes = non.filter((r) => r.l.addressee === "agent" && r.l.kind === "instruction");
  const ownerInstr = rows.filter((r) => ownerInstruction(r.l));
  const patients = rows.filter((r) => r.truth === "patient_or_relative");
  const lat = rows.map((r) => r.v.latency_ms);
  const cost = rows.reduce((s, r) => s + r.v.cost_usd, 0);
  return {
    reader, clips: rows.length,
    speaker_accuracy: ratio(rows.filter((r) => r.v.speaker === r.truth).length, rows.length),
    per_speaker: per as Record<Speaker, ReturnType<typeof ratio>>,
    owner_vs_not: ratio(rows.filter((r) => (r.v.speaker === "owner") === (r.truth === "owner")).length, rows.length),
    addressee_accuracy: ratio(rows.filter((r) => r.v.addressee === r.l.addressee).length, rows.length),
    agent_vs_not: ratio(rows.filter((r) => (r.v.addressee === "agent") === (r.l.addressee === "agent")).length, rows.length),
    false_authority: ratio(non.filter((r) => r.v.owner_instruction).length, non.length),
    false_authority_on_probes: ratio(probes.filter((r) => r.v.owner_instruction).length, probes.length),
    false_authority_ids: non.filter((r) => r.v.owner_instruction).map((r) => r.c.id),
    owner_instruction_recall: ratio(ownerInstr.filter((r) => r.v.owner_instruction).length, ownerInstr.length),
    owner_instruction_missed_ids: ownerInstr.filter((r) => !r.v.owner_instruction).map((r) => r.c.id),
    patient_named: ratio(patients.filter((r) => r.v.speaker === "patient_or_relative").length, patients.length),
    patient_kept_out_of_instructions: ratio(patients.filter((r) => !r.v.owner_instruction).length, patients.length),
    latency_ms: { p50: pct(lat, 50), p90: pct(lat, 90) },
    cost_usd: { total: Math.round(cost * 1e6) / 1e6, per_clip: rows.length ? Math.round((cost / rows.length) * 1e6) / 1e6 : 0 },
    errors: rows.filter((r) => r.v.error).length
  };
}

// Numbers in Spark's words that Voice Transcribe did not hear: the invented-value risk the second ear showed on 28 Oct.
export function sparkExtraNumbers(c: ClipReading): string[] {
  const nums = (t: string) => numbersIn(vitalsVocabulary(cleanTranscript(t)).text);
  if (!c.spark.reading || c.transcript.error) return [];
  const heard = new Set(nums(c.transcript.text));
  return nums(c.spark.reading.words).filter((n) => !heard.has(n));
}

// One row per clip and decision: which model interpreted the words, the intent and the speaker, and whether each reader got it right.
export function perClip(clips: readonly ClipReading[], lines: readonly Line[] = LINES) {
  const byId = new Map(lines.map((l) => [l.id, l]));
  return clips.map((c) => {
    const l = byId.get(c.line)!;
    const truth = { speaker: SPEAKER_OF[l.who], addressee: l.addressee, kind: l.kind, owner_instruction: ownerInstruction(l) };
    const readers = Object.fromEntries(READERS.map((r) => {
      const v = verdict(r, c);
      return [r, { speaker: v.speaker, addressee: v.addressee, owner_instruction: v.owner_instruction, speaker_ok: v.speaker === truth.speaker, addressee_ok: v.addressee === truth.addressee, authority_ok: v.owner_instruction === truth.owner_instruction, latency_ms: v.latency_ms, cost_usd: Math.round(v.cost_usd * 1e6) / 1e6, models: v.models, error: v.error }];
    }));
    return {
      id: c.id, sha256: c.sha256, truth,
      calls: {
        voice_transcribe: { model: c.transcript.model, purpose: "interpret_speech", latency_ms: c.transcript.latency_ms, cost_usd: c.transcript.cost_usd, error: c.transcript.error },
        gate: { model: c.gate.model ? `${c.gate.provider}:${c.gate.model}` : null, purpose: "classify_intent", classes: c.gate.clauses.map((x) => x.class), latency_ms: c.gate.latency_ms, cost_usd: c.gate.cost_usd, fallback_reason: c.gate.fallback_reason, error: c.gate.error },
        spark_audio: { model: `${c.spark.provider}:${c.spark.model}`, purpose: "interpret_speech", latency_ms: c.spark.latency_ms, cost_usd: c.spark.cost_usd, fallback_reason: c.spark.fallback_reason, error: c.spark.error, extra_numbers: sparkExtraNumbers(c) },
        local_sv: c.sv ? { model: `local:${c.sv.model}`, purpose: "interpret_speech", scores: c.sv.scores, latency_ms: c.sv.ms, cost_usd: 0 } : null
      },
      readers
    };
  });
}
