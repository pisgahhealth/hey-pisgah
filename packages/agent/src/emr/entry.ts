import { z } from "zod";
import { EmrId, type EmrTarget } from "./port.js";

// The hands-free entry: the wake phrase, the emergency entry that needs no patient, the spoken identity, and the patient the clinician is with.
export const EMERGENCY_KIND = "open_unnamed_encounter" as const;
// Kinds the agent takes only by rule, never from the speech gate, so the gate prompt does not list them.
export const RULE_ONLY_KINDS: ReadonlySet<string> = new Set([EMERGENCY_KIND]);

export const EmergencyArgs = z.strictObject({
  unidentified_ref: z.string().min(1).max(200),
  reason: z.string().min(1).max(500),
  clinic_id: EmrId.optional()
});
export type EmergencyArgs = z.infer<typeof EmergencyArgs>;

// "hey Pisgah, emergency" as a transcript reads it; the wake word alone is spotted on the device.
export const EMERGENCY_LINE = /^\s*(?:(?:ok(?:ay)?|hey|hi|hay|a)[,\s]+)?(?:pisgah|pizgah|pisga|pisgar|pisca)[,.!\s]+(?:this is an?\s+|we have an?\s+)?emergency\b/i;
export const WAKE_LINE = /^\s*(?:(?:ok(?:ay)?|hey|hi|hay|a)[,\s]+)(?:pisgah|pizgah|pisga|pisgar|pisca)\b[,.!\s]*/i;

// Audio carried across the wake starts with the phrase itself, so the phrase is dropped unless it is the emergency phrase, which is kept whole.
export function afterWake(line: string): string {
  if (EMERGENCY_LINE.test(line) || !CARRIED_WAKE.test(line)) return line;
  const rest = line.replace(CARRIED_WAKE, "").trim();
  return rest || line;
}
// The carried audio may begin partway through the phrase, so the greeting before the name is optional here.
const CARRIED_WAKE = /^\s*(?:(?:ok(?:ay)?|hey|hi|hay|a)[,\s]+)?(?:pisgah|pizgah|pisga|pisgar|pisca)\b[,.!\s]*/i;

// A transcript of audio the device already heard as "emergency": the word early, after something like the wake word or a bare greeting, as "Hypiska, hey, emergency".
export function emergencyHeardLoosely(line: string): boolean {
  const m = /^\W*((?:\S+\W+){0,4}?)emergency\b/i.exec(line);
  if (!m) return false;
  const before = m[1]!.trim();
  return /h[aeiy]{0,2}\W*p[iy]\W*[sz]?\W*[gk]|pisg|pizg|pisk|pesk/i.test(before.replace(/\s+/g, "")) || /^(?:hey|hi|hay|okay|ok)\W*$/i.test(before);
}

// What the clinician said after the phrase, kept as the arrival reason when it is more than the phrase.
export function emergencyReason(line: string): string {
  const rest = line.replace(EMERGENCY_LINE, "").replace(/^[\s,.:;-]+/, "").trim();
  return rest.length >= 3 ? `Emergency arrival: ${rest}`.slice(0, 500) : "Emergency arrival, opened by voice; reason not yet stated";
}

// A short reference for an unnamed arrival from its spoken time, such as "Unknown arrival 19:42".
export function unidentifiedRef(at: Date, timeZone = "Africa/Lagos"): string {
  const hm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(at);
  return `Unknown arrival ${hm}`;
}

export type SpokenIdentity = { name: string; phone: string | null; words: string };
const NAME = "([A-Z][a-z'-]+(?:\\s+[A-Z][a-z'-]+){1,3})";
const IDENTITY = [
  new RegExp(`\\b(?:[Hh]er|[Hh]is|[Tt]heir|[Tt]he patient'?s|[Pp]atient'?s)\\s+name\\s+is\\s+${NAME}`),
  new RegExp(`\\b(?:[Ss]he|[Hh]e)\\s+(?:is called|says (?:she|he) is|says (?:her|his) name is|is named)\\s+${NAME}`),
  new RegExp(`\\b[Tt]he patient is\\s+(?:called\\s+)?${NAME}`)
];
const PHONE = /(?:\+?234|0)\s*[789]\s*[01](?:[\s-]*\d){8}/;

// The name, and the phone when said, from a line that names the patient; the name must be two to four capitalised words as transcribed.
export function identityFrom(line: string): SpokenIdentity | null {
  for (const re of IDENTITY) {
    const m = re.exec(line);
    if (!m) continue;
    const name = m[1]!.replace(/\s+(?:And|Phone|Her|His|She|He|The)$/, "").trim();
    if (name.split(/\s+/).length < 2) continue;
    const p = PHONE.exec(digitsSpoken(line));
    const digits = p ? p[0].replace(/\D/g, "") : null;
    const phone = digits ? (digits.startsWith("234") ? `0${digits.slice(3)}` : digits) : null;
    return { name, phone: phone && /^0[789][01]\d{8}$/.test(phone) ? phone : null, words: m[0] };
  }
  return null;
}

const DIGIT_WORDS: Record<string, string> = { zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
// Spoken digits as digits, so "zero eight zero three" reads as 0803; "double" repeats the next digit.
export function digitsSpoken(line: string): string {
  return line.replace(/\b(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|double|triple|oh|o)\b[\s,-]*){4,}/gi, (run) => {
    const out: string[] = [];
    let times = 1;
    for (const w of run.toLowerCase().split(/[\s,-]+/).filter(Boolean)) {
      if (w === "double") { times = 2; continue; }
      if (w === "triple") { times = 3; continue; }
      const d = DIGIT_WORDS[w];
      if (d) { out.push(d.repeat(times)); times = 1; }
    }
    return `${out.join("")} `;
  });
}

export type KnownPatient = { label: string; target: EmrTarget };
const SWITCH = /\b(?:now|next|switching to|moving to|over to|back to|let'?s see|this is|seeing)\s+(?:to\s+)?(?:mr|mrs|ms|miss|master|baby)?\.?\s*([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+){0,2})/i;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s'-]/g, " ").replace(/\s+/g, " ").trim();

// The patient a line moves to by name, when exactly one known patient's name or surname matches the words after a switch phrase.
export function spokenPatient(line: string, known: readonly KnownPatient[]): KnownPatient | null {
  const m = SWITCH.exec(line);
  if (!m) return null;
  const said = norm(m[1]!);
  const hits = known.filter((k) => {
    const parts = norm(k.label).split(" ").filter((p) => p.length >= 3);
    return parts.length > 0 && (said.startsWith(norm(k.label)) || parts.some((p) => said.split(" ").includes(p)));
  });
  const unique = [...new Map(hits.map((h) => [JSON.stringify(h.target), h])).values()];
  return unique.length === 1 ? unique[0]! : null;
}

// A spoken identity held open on an encounter until the front desk completes the registration.
export type EmrIdentityHold = {
  obligation_id: string; kind: "identity_pending"; state: "open" | "done" | "cancelled";
  encounter: { patient_id: string | null; visit_id: string | null };
  name: string; phone: string | null; said_by: string; line_id: string; at: string; completes_by: "receptionist";
};
