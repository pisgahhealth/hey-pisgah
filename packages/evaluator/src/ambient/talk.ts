import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const CLASSES = ["instruction", "correction", "option", "conditional", "question_to_staff", "aside", "unclear"] as const;
const Values = z.strictObject({ temp_c: z.string().optional(), pulse: z.number().optional(), resp_rate: z.number().optional(), bp: z.string().optional() });
export const ExpectedAction = z.strictObject({ kind: z.string(), values: Values, corrects: z.string().nullable() });
export const TalkUtterance = z.strictObject({
  id: z.string().regex(/^u\d{2}$/), say: z.string().min(1).max(400),
  key: z.strictObject({ classes: z.array(z.enum(CLASSES)).min(1), actions: z.array(ExpectedAction), ambiguity: z.boolean(), refusal: z.boolean() })
});
export const Talk = z.strictObject({
  schema: z.literal("hey-pisgah/ambient-talk/1"), talk_id: z.string(), setting: z.string(), voice: z.string(), sample_rate: z.literal(16000),
  lead_ms: z.number().int().min(0), gap_ms: z.number().int().min(800), utterances: z.array(TalkUtterance).min(1)
});
export type Talk = z.infer<typeof Talk>;
export type TalkUtterance = z.infer<typeof TalkUtterance>;
export type ExpectedAction = z.infer<typeof ExpectedAction>;

export const TALK_FILE = fileURLToPath(new URL("../../fixtures/ambient/talk.json", import.meta.url));
export const MOCK_GATE_FILE = fileURLToPath(new URL("../../fixtures/ambient/mock-gate.json", import.meta.url));
export const loadTalk = (file = TALK_FILE): Talk => Talk.parse(JSON.parse(readFileSync(file, "utf8")));

// Where each utterance sits in the rendered recording.
export const Timeline = z.strictObject({ talk_id: z.string(), wav_sha256: z.string(), duration_ms: z.number(), utterances: z.array(z.strictObject({ id: z.string(), start_ms: z.number(), end_ms: z.number() })) });
export type Timeline = z.infer<typeof Timeline>;

// The talk must not lean on the learning layer: the design deny list plus any word about leaving hospital.
export const TALK_DENY: readonly RegExp[] = [
  /before[\s_-]*sign[\s_-]*off/i, /\bearlier\b/i, /\bin[\s_-]+advance\b/i, /\bparallel\b/i, /\bdraft/i, /early[\s_-]*summary/i,
  /pre[\s_-]*signoff/i, /prep[\s_-]*in[\s_-]*advance/i, /reasoning[\s_-]+strength/i, /\bbottleneck/i, /\bdelay/i, /\bcause\b/i,
  /\bfix(es|ed|ing)?\b/i, /\bimprov/i, /\bF(?:[1-9]|1[0-2]|V)\b/, /discharg/i, /\bhome\b/i, /summary/i, /sign[\s_-]*off/i, /pharmac/i, /take[\s_-]*home/i, /\bleav(e|ing)\b/i
];
export const talkDenyHits = (t: Talk): string[] => t.utterances.flatMap((u) => TALK_DENY.filter((r) => r.test(u.say)).map((r) => `${u.id} ${r.source}`));
