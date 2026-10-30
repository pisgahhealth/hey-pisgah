import { z } from "zod";
import { digitsSpoken } from "./entry.js";
import { EmrId } from "./port.js";

// Handing work between clinicians' agents through a record the EMR keeps: assignment, acknowledgement and completion are separate states.
export const DELEGATE_KIND = "delegate_task" as const;
export const ACK_KIND = "acknowledge_task" as const;
export const NUDGE_KIND = "nudge_owner" as const;
export const COMPLETE_KIND = "complete_task" as const;
export const ESCALATE_KIND = "escalate_task" as const;
export const WARD_REVIEW_KIND = "request_ward_review" as const;
export const REGISTER_KIND = "complete_registration" as const;
export const PREPARE_KIND = "prepare_order" as const;
export const DISPENSE_KIND = "dispense_order" as const;
// Every delegation kind is taken by rule from the record or a spoken acceptance, never from the speech gate.
export const DELEGATION_RULE_KINDS: ReadonlySet<string> = new Set([DELEGATE_KIND, ACK_KIND, NUDGE_KIND, COMPLETE_KIND, ESCALATE_KIND, WARD_REVIEW_KIND, REGISTER_KIND, PREPARE_KIND, DISPENSE_KIND]);

export const TASK_KINDS = ["review", "dispense", "lab_order", "registration", "nursing", "accounts", "operational"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const NEEDS = ["phone", "consent"] as const;
export type Need = (typeof NEEDS)[number];
// What a patient's spoken consent can cover: being registered, and each use of the record the hospital's notice lists; the profile maps each to the hospital's own name.
export const CONSENT_PURPOSES = ["registration", "scribe", "tests", "results_sharing", "pharmacy", "messages", "identity_check"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

const Evidence = z.string().regex(/^[A-Za-z0-9_.:#/-]{1,200}$/);
const Title = z.string().trim().min(1).max(120);
// The arguments of each delegation kind; every id is the record's own.
export const DELEGATION_ARGS: Record<string, z.ZodType<Record<string, unknown>>> = {
  [DELEGATE_KIND]: z.strictObject({
    task_kind: z.enum(TASK_KINDS), team: z.string().regex(/^[a-z_]{1,30}$/), patient_id: EmrId, admission_id: EmrId.optional(), visit_id: EmrId.optional(),
    subject_table: z.string().regex(/^[a-z_]{1,40}$/).optional(), subject_id: EmrId.optional(), title: Title, instruction: z.string().trim().min(1).max(2000),
    due_at: z.iso.datetime().optional(), escalate_after_minutes: z.number().int().min(0).max(10_080).optional(), evidence: Evidence
  }),
  [ACK_KIND]: z.strictObject({ delegation_id: EmrId, title: Title, evidence: Evidence }),
  [NUDGE_KIND]: z.strictObject({ delegation_id: EmrId, title: Title, needs: z.array(z.enum(NEEDS)).max(2), nudge_key: z.string().regex(/^nudge:[a-z+]{1,20}$/) }),
  [COMPLETE_KIND]: z.strictObject({ delegation_id: EmrId, title: Title, found_record_id: EmrId, evidence: Evidence }),
  [ESCALATE_KIND]: z.strictObject({ delegation_id: EmrId, title: Title }),
  [WARD_REVIEW_KIND]: z.strictObject({ delegation_id: EmrId, admission_id: EmrId, team: z.string().regex(/^[a-z_]{1,30}$/), reason: z.string().trim().min(1).max(1000) }),
  [PREPARE_KIND]: z.strictObject({ delegation_id: EmrId, prescription_id: EmrId, title: Title, evidence: Evidence }),
  [DISPENSE_KIND]: z.strictObject({ delegation_id: EmrId, prescription_id: EmrId, title: Title, evidence: Evidence }),
  [REGISTER_KIND]: z.strictObject({
    delegation_id: EmrId, patient_id: EmrId, surname: z.string().min(1).max(200), other_names: z.string().min(1).max(200), phone: z.string().regex(/^0[789][01]\d{8}$/), evidence: Evidence,
    consent_purposes: z.array(z.enum(CONSENT_PURPOSES)).min(1).max(CONSENT_PURPOSES.length), consent_spoken_at: z.iso.datetime({ offset: true })
  })
};

// A team the owner's agent may hand work to: the words that name it, the kind of task, and the fixed title the record keeps, which never names a patient.
export type DelegationTeam = { words: readonly string[]; task_kind: TaskKind; title: string; label: string; escalate_after_minutes?: number };

// A kind whose verified write is handed straight on, such as a sent order to the team that performs it; the subject is the record the write made.
export type DelegationHandoff = { team: string; subject_table: string };

// One delegation as the EMR's read shows it to either side.
export type DelegationRead = {
  id: string; kind: string; title: string; patient_id: string; admission_id: string | null; visit_id: string | null; state: string;
  assignee: string | null; rule: string; acknowledged_at: string | null; completed_at: string | null; completion_record_id: string | null;
  due_at: string | null; overdue: boolean; escalated_at: string | null;
  record: { status: "verified" | "unsupported_or_incomplete" | "verifier_error"; record_id: string | null; reason: string | null };
  instruction: string | null; nudged: string[];
  // The record the task is about, and what a fresh read says of a prescription: past the pharmacist's review, its voice order received, the consultation finished.
  subject_id: string | null; subject_prepared: boolean | null; order_received: boolean | null; consult_finished: boolean | null;
  created_at?: string | null;
  // A reviewed prescription is ready at the counter, or waits for its payment.
  subject_ready?: boolean | null; awaiting_payment?: boolean | null;
};

// One delegation as a task holds it: which side this owner is on, and each state as the record showed it.
export type EmrDelegation = {
  key: string; delegation_id: string | null; side: "delegator" | "assignee"; task_kind: string; title: string; team: string | null;
  action_id: string | null; line_id: string; at: string;
  assigned_at: string | null; acknowledged_at: string | null; completed_at: string | null; escalated_at: string | null; record_id: string | null;
  ward_review: "none" | "held" | "requested"; due_at: string | null;
  registration: { name: string | null; phone: string | null; consent_line: string | null; phone_line?: string | null; consent_purposes?: ConsentPurpose[]; consent_at?: string | null } | null;
  // The spoken identity this task completes, closed on the delegating side when the record names the patient.
  obligation_id: string | null;
  // The record the task is about, what its holder asked the agent to do with it and on which line, and what it waits on.
  subject_id?: string | null; asked?: "prepare" | "dispense" | null; asked_line?: string | null; waiting?: string | null; prepared_seen?: boolean;
  // The verified write a hand-off came from, so each order said in one line is handed on once.
  source_action_id?: string | null;
};

export function delegationSummary(kind: string, a: Record<string, unknown>): string | null {
  const t = String(a["title"] ?? "the task");
  switch (kind) {
    case DELEGATE_KIND: return `Hand on to the ${String(a["team"]).replace(/_/g, " ")} team: ${t}`;
    case ACK_KIND: return `Accept the task: ${t}`;
    case NUDGE_KIND: return `Tell you on the bell: ${t}`;
    case COMPLETE_KIND: return `Close the task the record shows done: ${t}`;
    case ESCALATE_KIND: return `Ring the bell, overdue: ${t}`;
    case WARD_REVIEW_KIND: return `Ask the ${String(a["team"]).replace(/_/g, " ")} clinic for a ward review`;
    case REGISTER_KIND: return "Complete the registration at the front desk";
    case PREPARE_KIND: return `Prepare the order (pharmacist's review): ${t}`;
    case DISPENSE_KIND: return `Dispense the order: ${t}`;
    default: return null;
  }
}

const STOP = new Set(["the", "a", "an", "task", "for", "of", "to", "and", "please", "that", "this", "it", "in", "on", "now"]);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
// A word's first six letters, so "registration" and "register" read as one word.
const stem = (w: string) => (w.length > 6 ? w.slice(0, 6) : w);
export const ACCEPT_LINE = /^\s*(?:(?:ok(?:ay)?|yes|right)[,.\s]+)?(?:i\s+(?:have\s+)?)?accept(?:ed|ing)?\b\s*(?:the\s+)?(.{0,100}?)[.!\s]*$/i;

// Which one open task a spoken "accepted <task>" names: the single best word match, or every candidate when it is not one.
export function acceptedTask<T extends { title: string }>(line: string, open: readonly T[]): { hit: T } | { ambiguous: T[] } | { none: true } | null {
  const m = ACCEPT_LINE.exec(line);
  if (!m) return null;
  const said = new Set(words(m[1] ?? "").map(stem));
  if (!open.length) return { none: true };
  if (!said.size) return open.length === 1 ? { hit: open[0]! } : { ambiguous: [...open] };
  const scored = open.map((o) => ({ o, n: words(o.title).map(stem).filter((w) => said.has(w)).length })).filter((x) => x.n > 0);
  if (!scored.length) return { none: true };
  const best = Math.max(...scored.map((x) => x.n));
  const top = scored.filter((x) => x.n === best).map((x) => x.o);
  return top.length === 1 ? { hit: top[0]! } : { ambiguous: top };
}

const PHONE = /(?:\+?234|0)\s*[789]\s*[01](?:[\s-]*\d){8}/;
// A Nigerian mobile number in the words, spoken digits included, written as 0XXXXXXXXXX.
export function phoneSaid(line: string): string | null {
  const p = PHONE.exec(digitsSpoken(line));
  if (!p) return null;
  const d = p[0].replace(/\D/g, "");
  const phone = d.startsWith("234") ? `0${d.slice(3)}` : d;
  return /^0[789][01]\d{8}$/.test(phone) ? phone : null;
}

// True only when the front desk says the patient consented, and false for any refusal near the word.
export function consentSaid(line: string): boolean {
  const low = line.toLowerCase();
  if (/\b(?:no|not|never|doesn'?t|does not|won'?t|refuses?|refused|declined?|withdr[ae]w)\b[^.]{0,30}\bconsent/.test(low) || /\bconsent\w*\b[^.]{0,20}\b(?:refused|declined|withdrawn)\b/.test(low)) return false;
  return /\b(?:she|he|they|the patient|patient)\s+(?:has\s+)?(?:consents?|consented|agrees?|agreed)\b|\b(?:verbal\s+)?consent\s+(?:given|confirmed|obtained)\b|\bgave\s+(?:her|his|their)\s+consent\b/.test(low);
}

// The phrases that name each purpose, longest first, so a phrase of one purpose is never read as another's shorter word.
const PURPOSE_PHRASES: readonly [ConsentPurpose, RegExp][] = [
  ["results_sharing", /\b(?:shar\w*|send\w*)\s+(?:(?:her|his|their|the)\s+)?(?:(?:test|lab)\s+)?results?\b|\bresults?\s+(?:being\s+)?shared\b|\blab\s+sharing\b/g],
  ["scribe", /\b(?:scrib\w*|transcri\w*|(?:the\s+)?(?:consultation|conversation|visit)\s+(?:being\s+)?recorded|record(?:ing)?\s+(?:of\s+)?(?:the\s+|her\s+|his\s+|their\s+)?(?:consultation|conversation|visit)|(?:the\s+)?recording|ai\s+notes?)\b/g],
  ["identity_check", /\b(?:nin|identity\s+checks?|national\s+id\w*)\b/g],
  ["messages", /\b(?:sms|text\s+messages?|texts?|whats\s?app|messages?|notifications?|reminders?)\b/g],
  ["pharmacy", /\b(?:pharmac\w*|prescriptions?|medicines?|drugs?)\b/g],
  ["tests", /\b(?:tests?|investigations?|lab\s+work|vitals|treatment\s+records?)\b/g],
  ["registration", /\b(?:regist(?:er|ered|ering|ration)|her\s+details|his\s+details)\b/g],
];
const REFUSAL = /\b(?:no|not|never|don'?t|doesn'?t|does\s+not|won'?t|will\s+not|without|except|refus\w*|declin\w*|against)\b/;
const CLAUSE_END = /[.;!?,]|\bbut\b|\bhowever\b/g;

// Which purposes a consent line names, and which it refuses: a purpose is refused when a refusal word comes before it in its own clause.
export function consentScope(line: string): { said: ConsentPurpose[]; refused: ConsentPurpose[] } {
  let low = ` ${line.toLowerCase().replace(/\s+/g, " ")} `;
  const said = new Set<ConsentPurpose>(), refused = new Set<ConsentPurpose>();
  for (const [purpose, re] of PURPOSE_PHRASES) {
    for (const m of [...low.matchAll(re)]) {
      const before = low.slice(0, m.index);
      const ends = [...before.matchAll(CLAUSE_END)];
      const clause = before.slice(ends.length ? ends.at(-1)!.index! + ends.at(-1)![0].length : 0);
      (REFUSAL.test(clause) ? refused : said).add(purpose);
    }
    // A phrase once read is blanked, so "test results" shared is not also "tests".
    low = low.replace(re, (x) => " ".repeat(x.length));
  }
  for (const p of refused) said.delete(p);
  return { said: CONSENT_PURPOSES.filter((p) => said.has(p)), refused: CONSENT_PURPOSES.filter((p) => refused.has(p)) };
}

// What the pharmacist asks the agent to do with a sent order: prepare it (the review), or prepare and dispense it.
export function orderAsked(line: string): "prepare" | "dispense" | null {
  const low = line.toLowerCase();
  if (/\b(?:don'?t|do not|not yet|hold off|wait)\b[^.]{0,20}\b(?:prepare|dispense|give)/.test(low)) return null;
  if (/\b(?:dispense|dispensed|give it out|hand it over|issue it)\b/.test(low)) return "dispense";
  if (/\b(?:prepare|approve|review it|check it)\b/.test(low)) return "prepare";
  return null;
}

// The name and phone a registration task carries, from the instruction the delegating agent wrote.
export function registrationFrom(instruction: string | null): { name: string | null; phone: string | null } {
  const name = /Name said: ([^.;]{2,120})[.;]/.exec(instruction ?? "")?.[1]?.trim() ?? null;
  const phone = /Phone: (0[789][01]\d{8})\b/.exec(instruction ?? "")?.[1] ?? null;
  return { name, phone };
}

export function registrationInstruction(name: string, phone: string | null): string {
  return `Register the emergency arrival. Name said: ${name}. Phone: ${phone ?? "not said"}. Consent: ask the patient at the desk.`;
}

// What a registration still needs before the desk can complete it: a phone, and the patient's consent said at the desk.
export function registrationNeeds(r: { phone: string | null; consent_line: string | null }): Need[] {
  return [...(r.phone ? [] : (["phone"] as const)), ...(r.consent_line ? [] : (["consent"] as const))];
}

// A full name as the desk form takes it: the last word is the surname, the rest the other names.
export function nameParts(name: string): { surname: string; other_names: string } | null {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { surname: parts.at(-1)!, other_names: parts.slice(0, -1).join(" ") };
}

// The team a review's words name, when exactly one of the owner's teams matches.
export function teamSaid(text: string, teams: Record<string, DelegationTeam>, kind: TaskKind): string | null {
  const low = ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ")} `;
  const hits = Object.entries(teams).filter(([, t]) => t.task_kind === kind && t.words.some((w) => low.includes(` ${w.toLowerCase()} `))).map(([k]) => k);
  return hits.length === 1 ? hits[0]! : null;
}

// The single team of one kind, such as the front desk for registrations.
export function onlyTeam(teams: Record<string, DelegationTeam>, kind: TaskKind): string | null {
  const hits = Object.entries(teams).filter(([, t]) => t.task_kind === kind).map(([k]) => k);
  return hits.length === 1 ? hits[0]! : null;
}
