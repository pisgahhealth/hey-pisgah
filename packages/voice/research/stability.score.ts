import { cleanTranscript } from "../src/numbers.js";
import { numbersIn, vitalsVocabulary } from "../src/vitals.js";
import { align, words } from "./real.score.js";

export type ProbeCall = { arm: string; clip: string; n: number; raw: string | null; audio_ms?: number; turns?: unknown[]; wav_sha256: string; request_sha256?: string; status: number | null; voided: boolean; at: string; latency_ms: number; cost_usd: number };

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
// The values a reading carries after the shipped normaliser, sorted so two readings compare as sets.
export const valuesOf = (raw: string): string[] => [...numbersIn(vitalsVocabulary(cleanTranscript(raw)).text)].sort();

// Word disagreement over every pair of readings: edits between the two word lists, over the first reading's words.
export function pairwise(raws: readonly string[]) {
  let errors = 0, total = 0, pairs = 0, differing = 0;
  for (let i = 0; i < raws.length; i++) for (let j = i + 1; j < raws.length; j++) {
    const a = align(words(raws[i]!), words(raws[j]!));
    errors += a.errors; total += a.ref_words; pairs += 1;
    if (a.errors) differing += 1;
  }
  return { pairs, pairs_with_word_change: differing, word_edits: errors, words: total, rate: total ? r4(errors / total) : 0 };
}

// One clip in one arm: exact string equality, word and value disagreement, and whether turns and audio length were the same in every reply.
export function armStats(calls: readonly ProbeCall[]) {
  const ok = calls.filter((c) => c.raw !== null && !c.voided);
  const raws = ok.map((c) => c.raw!);
  const vals = raws.map((r) => valuesOf(r).join(","));
  return {
    calls: ok.length, distinct_strings: new Set(raws).size, identical: new Set(raws).size <= 1, words: pairwise(raws),
    distinct_values: new Set(vals).size, values: [...new Set(vals)], turns_identical: new Set(ok.map((c) => JSON.stringify(c.turns ?? null))).size <= 1,
    audio_ms_identical: new Set(ok.map((c) => c.audio_ms)).size <= 1, bytes_identical: new Set(ok.map((c) => c.wav_sha256)).size <= 1, readings: [...new Set(raws)]
  };
}

// Words that changed between readings and whether each is one of the hints sent, for the no-hint arm.
export function changedWords(raws: readonly string[]): string[] {
  const out = new Set<string>();
  for (let i = 0; i < raws.length; i++) for (let j = i + 1; j < raws.length; j++) for (const o of align(words(raws[i]!), words(raws[j]!)).ops) { if (o.ref) out.add(o.ref); if (o.hyp) out.add(o.hyp); }
  return [...out].sort();
}

// Pools every clip's arm into one row: how many clips gave more than one string, the pooled pairwise word rate and the clips whose values moved.
export function armSummary(byClip: Record<string, ReturnType<typeof armStats>>) {
  const rows = Object.entries(byClip);
  const edits = rows.reduce((n, [, r]) => n + r.words.word_edits, 0), w = rows.reduce((n, [, r]) => n + r.words.words, 0);
  return {
    clips: rows.length, clips_not_identical: rows.filter(([, r]) => !r.identical).length, pooled_pairwise_word_rate: w ? r4(edits / w) : 0,
    clips_values_moved: rows.filter(([, r]) => r.distinct_values > 1).map(([id]) => id), clips_turns_moved: rows.filter(([, r]) => !r.turns_identical).map(([id]) => id), clips_audio_ms_moved: rows.filter(([, r]) => !r.audio_ms_identical).map(([id]) => id)
  };
}
