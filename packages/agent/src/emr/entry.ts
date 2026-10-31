import { z } from "zod";
import { EmrId, type EmrTarget } from "./port.js";

// The hands-free entry: the wake phrase, the emergency entry that needs no patient, the spoken identity, and the patient the clinician is with.
export const EMERGENCY_KIND = "open_unnamed_encounter" as const;
// The name said for an unnamed emergency arrival, written by the owner's own agent; the record stays unidentified until the desk completes it (D39).
export const IDENTITY_KIND = "record_identity" as const;
// Kinds the agent takes only by rule, never from the speech gate, so the gate prompt does not list them.
export const RULE_ONLY_KINDS: ReadonlySet<string> = new Set([EMERGENCY_KIND, IDENTITY_KIND]);

export const EmergencyArgs = z.strictObject({
  unidentified_ref: z.string().min(1).max(200),
  reason: z.string().min(1).max(500),
  clinic_id: EmrId.optional()
});
export type EmergencyArgs = z.infer<typeof EmergencyArgs>;
export const IdentityArgs = z.strictObject({ visit_id: EmrId, patient_id: EmrId, name: z.string().trim().min(1).max(200), phone: z.string().regex(/^0[789][01]\d{8}$/).optional() });

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
  // The local streaming ear writes "hey Pisgah" as "Heape is the", so an h-word then a p and an s or z close behind also counts.
  const joined = before.replace(/\W+/g, "").toLowerCase();
  return /h[aeiy]{0,2}\W*p[iy]\W*[sz]?\W*[gk]|pisg|pizg|pisk|pesk/i.test(before.replace(/\s+/g, "")) || /^h[aeiy]{1,3}p\w{0,3}[sz]/.test(joined) || /^(?:hey|hi|hay|okay|ok)\W*$/i.test(before);
}

// The line an Emergency press leaves as its evidence: what happened, not words nobody said.
export const EMERGENCY_PRESS = "Emergency button pressed";

// What the clinician said after the phrase, kept as the arrival reason when it is more than the phrase.
export function emergencyReason(line: string): string {
  if (line === EMERGENCY_PRESS) return "Emergency arrival, opened by a press; reason not yet stated";
  const rest = line.replace(EMERGENCY_LINE, "").replace(/^[\s,.:;-]+/, "").trim();
  return rest.length >= 3 ? `Emergency arrival: ${rest}`.slice(0, 500) : "Emergency arrival, opened by voice; reason not yet stated";
}

// A short reference for an unnamed arrival from its spoken time, such as "Unknown arrival 19:42".
export function unidentifiedRef(at: Date, timeZone = "Africa/Lagos"): string {
  const hm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(at);
  return `Unknown arrival ${hm}`;
}

export type SpokenIdentity = { name: string; phone: string | null; words: string };
// The words that introduce a name, as people say them, Nigerian English included ("her name na").
// "now" and "no" are how the local streaming ear hears the Nigerian "na" after "her name".
const NAMING = /\b(?:(?:her|his|my|their|the patient'?s|patient'?s)\s+name\s+(?:is|na|now|no)|(?:she|he)\s+(?:is called|is named|says (?:she|he) is|says (?:her|his) name is)|(?:she|he)'s called|(?:they|people) call (?:her|him)|the patient is(?:\s+called)?)\b/i;
const NAME_RUN = /[A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+){1,3}/g;
const NOT_NAME = /^(?:And|Phone|Her|His|She|He|The|Number|Em|Eh|Er|Um|Uh|Mr|Mrs|Ms|Miss|Dr|Doctor|Madam|Sir)$/;
const PHONE = /(?:\+?234|0)\s*[789]\s*[01](?:[\s-]*\d){8}/;

// The name, and the phone when said, from a line that names the patient: the longest run of two to four capitalised words after the naming words, so "Grace, Grace Okafor" reads as Grace Okafor.
export function identityFrom(line: string): SpokenIdentity | null {
  const m = NAMING.exec(line);
  if (!m) return null;
  // The name is in the first sentence after the naming words, or the next one when an ear broke the sentence after a lone first name.
  const parts = line.slice(m.index + m[0].length).replace(/\.{2,}|…/g, ",").split(/\bnumber\b|\bphone\b/i)[0]!.split(/[.!?;]\s/);
  const runsIn = (t: string) => [...t.matchAll(NAME_RUN)].map((r) => r[0].split(/\s+/).filter((w) => !NOT_NAME.test(w)).join(" ")).filter((n) => n.split(" ").length >= 2);
  const runs = runsIn(parts[0] ?? "").length ? runsIn(parts[0] ?? "") : runsIn(parts[1] ?? "");
  // "Amika, Emikonvosu" is a first name and a surname with a pause between, when no longer run was heard.
  const paused = /([A-Z][a-z'-]+),\s+([A-Z][a-z'-]+)\b/.exec(parts[0] ?? "");
  if (!runs.length && paused && paused[1] !== paused[2] && !NOT_NAME.test(paused[1]!) && !NOT_NAME.test(paused[2]!)) runs.push(`${paused[1]} ${paused[2]}`);
  const name = runs.sort((x, y) => y.length - x.length)[0];
  if (!name) return null;
  const p = PHONE.exec(digitsSpoken(line));
  const digits = p ? p[0].replace(/\D/g, "") : null;
  const phone = digits ? (digits.startsWith("234") ? `0${digits.slice(3)}` : digits) : null;
  return { name, phone: phone && /^0[789][01]\d{8}$/.test(phone) ? phone : null, words: `${m[0]} ${name}` };
}

// True when the patient named themselves ("my name is"), which counts unless the voice is the owner's own (D40).
export const selfNamed = (line: string): boolean => /\bmy\s+name\s+(?:is|na|now|no)\b/i.test(line);

// A name spelled letter by letter ("A-D-E-Y-E-M-I"), read as the word, put in place of the one held part it is closest to; when no part or several parts are as close, it is asked.
export function spelledName(line: string, held: string): { name: string } | { ask: string[]; word: string } | null {
  const runs = [...line.matchAll(/(?<![A-Za-z])(?:[A-Za-z](?:[\s,.-]+|$)){3,}/g)].map((m) => m[0].replace(/[^A-Za-z]/g, "")).filter((w) => w.length >= 3);
  if (!runs.length || !(/\bspel(?:l(?:ed|ing|s)?|t)\b/i.test(line) || runs[0]!.length >= 4)) return null;
  const word = runs[0]![0]!.toUpperCase() + runs[0]!.slice(1).toLowerCase();
  const parts = held.split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const near = parts.map((p, i) => ({ i, d: editDistance(p.toLowerCase(), word.toLowerCase()) })).filter((x) => parts[x.i]![0]!.toLowerCase() === word[0]!.toLowerCase() && x.d <= Math.max(2, Math.floor(word.length / 3)));
  const best = Math.min(...near.map((x) => x.d));
  const top = near.filter((x) => x.d === best);
  if (top.length !== 1) return { ask: top.length ? top.map((x) => parts[x.i]!) : parts, word };
  if (parts[top[0]!.i] === word) return null;
  parts[top[0]!.i] = word;
  return { name: parts.join(" ") };
}
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

// "over" is how the local streaming ear hears a spoken "oh" inside a phone number; it counts only inside a run of four or more digit words.
const DIGIT_WORDS: Record<string, string> = { zero: "0", oh: "0", o: "0", over: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
// Spoken digits as digits, so "zero eight zero three" reads as 0803; "double" repeats the next digit.
export function digitsSpoken(line: string): string {
  return line.replace(/\b(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|double|triple|oh|o|over)\b[\s,-]*){4,}/gi, (run) => {
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
  name: string; phone: string | null; said_by: string; line_id: string; at: string; completes_by: "receptionist" | "owner_agent";
  // Each earlier name this one replaced, with the line that corrected it.
  amended?: { from: string; line_id: string }[];
  // When the owner's agent wrote this name to the record, so the strip says it is recorded.
  recorded_at?: string | null;
};

// Words in a label that never tell two patients apart.
const NOT_DISTINCT = new Set(["unknown", "unnamed", "arrival", "zz-test", "test", "patient", "baby", "master", "miss", "mrs", "the", "and"]);
const tokensOf = (s: string) => norm(s).split(" ").map((w) => w.replace(/'s$/, ""));
const distinct = (labels: readonly string[], not: ReadonlySet<string> = new Set()) => labels.flatMap(tokensOf).filter((p) => p.length >= 3 && !/\d/.test(p) && !NOT_DISTINCT.has(p) && !not.has(p));
// The other open patients a line names by a word only their name has, when it uses no switch phrase; the patient in context is never among them.
export function otherPatientsNamed<T extends { labels: readonly string[] }>(line: string, others: readonly T[], current: readonly string[]): T[] {
  const said = new Set(tokensOf(line));
  const mine = new Set(current.flatMap(tokensOf));
  return others.filter((o) => distinct(o.labels, mine).some((p) => said.has(p)));
}
// True when the line names the patient in context by a word of their own name.
export const currentPatientNamed = (line: string, current: readonly string[]): boolean => { const said = new Set(tokensOf(line)); return distinct(current).some((p) => said.has(p)); };
