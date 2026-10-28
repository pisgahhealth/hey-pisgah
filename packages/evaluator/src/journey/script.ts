import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const Owner = z.enum(["doctor", "nurse", "accounts"]);
const Clause = z.record(z.string(), z.unknown());
// An expected action from a line; state is completed unless the EMR is expected to refuse it.
const Expect = z.strictObject({ kind: z.string().min(1), args: z.record(z.string(), z.union([z.string(), z.number()])).optional(), state: z.enum(["completed", "refused"]).optional() });
// One talk line by an owner, with what it should produce and the keyed gate clauses for a mock run.
const TalkStep = z.strictObject({
  id: z.string().regex(/^[a-z]\d{2}$/), step: z.number().int().min(1).max(7), owner: Owner, at: z.enum(["patient", "admission"]), say: z.string().min(1).max(400),
  expect: z.array(Expect), refusals: z.number().int().min(0).optional(), asks: z.number().int().min(0).optional(),
  held: z.boolean().optional(), pause: z.boolean().optional(), while_paused: z.boolean().optional(), resume: z.boolean().optional(),
  key: z.array(Clause)
});
// One step a person does on the existing screens; the agent never does it.
const PersonStep = z.strictObject({ id: z.string().regex(/^p\d{2}$/), step: z.number().int().min(1).max(7), person: z.string().regex(/^[a-z_]+$/), by: z.enum(["reception", "doctor", "nurse", "accounts"]), what: z.string().min(1) });
export const JourneyStep = z.union([TalkStep, PersonStep]);
export type JourneyStep = z.infer<typeof JourneyStep>;
export type TalkStep = z.infer<typeof TalkStep>;
export type PersonStep = z.infer<typeof PersonStep>;
export const BEHAVIOURS = ["act", "ask", "refuse", "wait"] as const;
export type Behaviour = (typeof BEHAVIOURS)[number];
// A decision point of the journey: the line it hangs on, how it is measured, and the classes written down before the run.
export const JourneyPoint = z.strictObject({
  dp_id: z.string().regex(/^j\d{2}$/), line: z.string(), measure: z.enum(["line", "held_during_pause", "resumed_pending", "offer"]),
  acceptable: z.array(z.enum(BEHAVIOURS)).min(1), what: z.string().min(1)
});
export type JourneyPoint = z.infer<typeof JourneyPoint>;
export const JourneyScript = z.strictObject({
  schema: z.literal("hey-pisgah/journey/1"), journey_id: z.string(), voice: z.string(), sample_rate: z.number().int(),
  patient: z.string(), owners: z.record(Owner, z.string()), never: z.array(z.string()),
  // Open rulings that change what a step expects, with how to flip the step when each lands.
  rulings: z.record(z.string(), z.string()).default({}),
  steps: z.array(JourneyStep).min(1), decision_points: z.array(JourneyPoint).min(1)
});
export type JourneyScript = z.infer<typeof JourneyScript>;

export const JOURNEY_FILE = fileURLToPath(new URL("../../fixtures/journey/script.json", import.meta.url));
export const loadJourney = (file = JOURNEY_FILE): JourneyScript => JourneyScript.parse(JSON.parse(readFileSync(file, "utf8")));
export const isTalk = (s: JourneyStep): s is TalkStep => "say" in s;

// Words that would hint at what the learning layer changes about leaving hospital; no journey line may hold one.
export const JOURNEY_DENY: readonly RegExp[] = [
  /before[\s_-]*sign[\s_-]*off/i, /\bearlier\b/i, /\bin[\s_-]+advance\b/i, /\bparallel\b/i, /\bdraft[\s_-]+first\b/i, /early[\s_-]*summary/i,
  /\bahead of\b/i, /\bprepare\b.*\bsummary\b/i, /discharge summary/i, /\bbottleneck/i, /\bdelay/i, /\bimprovement/i, /\bfix(es|ed|ing)?\b/i, /\bwait(ing)? for (the )?sign/i
];
export const journeyDenyHits = (s: JourneyScript): { id: string; hits: string[] }[] =>
  s.steps.filter(isTalk).map((t) => ({ id: t.id, hits: JOURNEY_DENY.filter((r) => r.test(t.say)).map((r) => r.source) })).filter((x) => x.hits.length);
