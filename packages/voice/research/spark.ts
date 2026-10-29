import { z } from "zod";
import { ADDRESSEES, KINDS, SPEAKERS } from "./lines.js";

// The audio-native reader: Spark hears the enrolment references and the line itself, and names speaker, addressee and kind.
export const SPARK_ROUTE = { provider: "modal", model: "meta-models/Muse-Spark-Open-816B-A42B" } as const;
export const SPARK_FALLBACK = { provider: "meta", model: "muse-spark-1.3" } as const;
export const REFERENCE_NAMES = { S: "OWNER", B: "DOCTOR_B", N: "NURSE_N" } as const;

export const SparkReading = z.object({
  words: z.string().max(600),
  voices: z.unknown().optional(),
  speaker: z.enum(SPEAKERS),
  speaker_match: z.enum(["OWNER", "DOCTOR_B", "NURSE_N", "none"]),
  addressee: z.enum(ADDRESSEES),
  kind: z.enum(KINDS),
  confidence: z.number().min(0).max(1)
});
export type SparkReading = z.infer<typeof SparkReading>;

// Version 1, chosen on the tuning set only; the system line names every clip, which the 28 Oct probe showed the model needs to read audio at all.
export const SPARK_SYSTEM = [
  "The user message holds several short audio clips. Each clip is an audio part that comes right after a text line naming it.",
  "The clips named OWNER, DOCTOR_B and NURSE_N are enrolment recordings: each holds one known member of staff reading a passage. OWNER is the clinician you work for.",
  "The last clip, named LINE, is one thing said on a hospital ward and picked up by the owner's laptop. It may hold background noise, and sometimes two people talking at once.",
  "Listen to the LINE clip and reply with one JSON object and nothing else, with these fields:",
  "- words: what is said in LINE, word for word, numbers as digits. If two people talk at once, write only the words of the person who speaks first.",
  "- speaker_match: which enrolment voice the person who speaks first in LINE has: OWNER, DOCTOR_B, NURSE_N, or none when the voice matches no enrolment clip. Judge by the voice, not by the words.",
  "- speaker: owner when speaker_match is OWNER; other_clinician when it is DOCTOR_B or NURSE_N; patient_or_relative when it is none.",
  "- addressee: agent when the words ask the owner's agent to put something in the record or do a task, or dictate a finding for the notes; staff when they are said to a doctor, a nurse or a colleague; patient when they are said to the patient.",
  "- kind: instruction when the words ask for something to be done now; documentation when they state a finding or a measurement for the record; talk for anything else.",
  "- confidence: from 0 to 1, how sure you are of speaker_match.",
  "Write only words that are in the LINE clip."
].join("\n");

// Version 2, tried on the tuning set: the model first describes each voice, then matches; kept only if it names speakers better there.
export const SPARK_SYSTEM_V2 = SPARK_SYSTEM.replace(
  "Listen to the LINE clip and reply with one JSON object and nothing else, with these fields:",
  [
    "Two different people can both sound like doctors, and the words never tell you who is speaking. Compare the voices themselves: pitch, accent, speed and timbre.",
    "Listen to the LINE clip and reply with one JSON object and nothing else, with these fields:",
    "- voices: one short phrase for each enrolment voice and for the first voice in LINE, such as \"low male, Indian English, quick\"."
  ].join("\n")
);
export const SPARK_PROMPTS = { v1: SPARK_SYSTEM, v2: SPARK_SYSTEM_V2 } as const;

export type ClipRef = { name: string; b64: string };
type Provider = "modal" | "meta";

export function audioPart(provider: Provider, b64: string): unknown {
  return provider === "meta" ? { type: "input_audio", input_audio: { data: b64, format: "wav" } } : { type: "audio_url", audio_url: { url: `data:audio/wav;base64,${b64}` } };
}

// The user content: each reference named and then given, the line last, then the ask.
export function sparkContent(provider: Provider, refs: readonly ClipRef[], line: string): unknown[] {
  return [
    ...refs.flatMap((r) => [{ type: "text", text: `Clip ${r.name}:` }, audioPart(provider, r.b64)]),
    { type: "text", text: "Clip LINE:" }, audioPart(provider, line),
    { type: "text", text: "Reply with the JSON object for the LINE clip." }
  ];
}

// Reads the first JSON object in the reply; anything else is a reader error, scored as such.
export function parseSpark(text: string): SparkReading | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const r = SparkReading.safeParse(JSON.parse(m[0]));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
