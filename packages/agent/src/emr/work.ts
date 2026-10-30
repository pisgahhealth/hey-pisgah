import { z } from "zod";
import { DELEGATION_RULE_KINDS, delegationSummary } from "./delegate.js";
import { EmrId, OBSERVATION_KIND } from "./port.js";

// Every kind of work an EMR agent can hold; an owner holds only the kinds its profile grants.
export const WORK_KINDS = [
  OBSERVATION_KIND, "draft_consult_note", "request_admission", "record_triage_vitals", "add_care_plan_item",
  "record_note", "draft_handover", "page_staff", "schedule_follow_up", "prepare_bill", "send_pay_link",
  "open_consult", "record_clerking", "record_allergy", "admit_patient", "assign_bed", "schedule_review",
  "order_test", "prescribe", "countersign", "release_home", "record_diagnosis"
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
// The delegation kinds an owner may also hold; each is taken by rule, so the gate never lists them.
export const DELEGATION_KINDS: readonly string[] = [...DELEGATION_RULE_KINDS];
// Kinds that only read the record and report back; they change nothing in it.
export const READ_ONLY_KINDS: ReadonlySet<string> = new Set(["draft_handover", "prepare_bill"]);
// Kinds the owner's own matched voice asks for and a later matched confirm line releases; any other voice never writes them.
export const OWNER_CONFIRM_KINDS: ReadonlySet<string> = new Set(["record_diagnosis"]);

export const WARD_CLASSES = ["general", "private", "semi_private", "icu", "hdu", "paeds", "isolation", "maternity"] as const;
export const ADMISSION_TYPES = ["emergency", "planned", "day_case"] as const;
export const ITEM_KINDS = ["medication", "nursing", "observation", "diet"] as const;
export const NOTE_TYPES = ["progress", "ward_round", "nursing"] as const;
export const PRIORITIES = ["normal", "urgent", "emergency"] as const;
// The clerking note's sections the clinician fills by speaking, and the separate section for what the patient or a relative said.
export const CLERKING_SECTIONS = ["presenting_complaint", "history", "examination", "assessment", "plan"] as const;
export type ClerkingSection = (typeof CLERKING_SECTIONS)[number];
export const REPORTED_SECTION = "patient_reported" as const;
export const ALLERGY_SEVERITIES = ["mild", "moderate", "severe", "unknown"] as const;
export const ORDER_PRIORITIES = ["routine", "urgent", "stat"] as const;
export const DRUG_ROUTES = ["oral", "iv", "im", "sc", "inhaled", "topical", "sublingual", "rectal"] as const;
// What a held instruction waits for besides a time: the admission to exist, or a result to arrive.
export const OBLIGATION_AFTER = ["admission", "result"] as const;
// Each cadence code with the spoken phrases that name it; a cadence is kept only when one of its phrases was said.
export const CADENCE_WORDS: Record<string, readonly string[]> = {
  OD: ["once daily", "once a day", "every day", "daily"], BD: ["twice daily", "twice a day"], TDS: ["three times a day", "three times daily"],
  QID: ["four times a day", "four times daily"], q2h: ["two hourly", "2 hourly", "every two hours", "every 2 hours"],
  q4h: ["four hourly", "4 hourly", "every four hours", "every 4 hours"], q6h: ["six hourly", "6 hourly", "every six hours", "every 6 hours"],
  q8h: ["eight hourly", "8 hourly", "every eight hours", "every 8 hours"], q12h: ["twelve hourly", "12 hourly", "every twelve hours", "every 12 hours"],
  STAT: ["stat", "right now", "straight away"], PRN: ["as needed", "when needed", "as required"]
};

const Text = z.string().trim().min(1).max(4000);
const vitals = {
  temp_c: z.string().regex(/^\d{2}(\.\d)?$/).refine((v) => Number(v) >= 30 && Number(v) <= 45, "temperature must be 30 to 45 C").optional(),
  pulse: z.number().int().min(20).max(250).optional(),
  resp_rate: z.number().int().min(4).max(80).optional(),
  bp: z.string().regex(/^\d{2,3}\/\d{2,3}$/).optional(),
  spo2: z.number().int().min(50).max(100).optional(),
  weight_kg: z.number().min(2).max(300).refine((v) => Number.isInteger(v * 10), "weight takes one decimal at most").optional()
};
const anyVital = (a: Record<string, unknown>) => ["temp_c", "pulse", "resp_rate", "bp", "spo2"].some((k) => a[k] !== undefined);

// The arguments each kind is written with; every id is the record's own, and every value was said by the owner.
export const WORK_ARGS: Record<Exclude<WorkKind, typeof OBSERVATION_KIND>, z.ZodType<Record<string, unknown>>> = {
  draft_consult_note: z.strictObject({ visit_id: EmrId, patient_id: EmrId.optional(), text: Text }),
  request_admission: z.strictObject({ visit_id: EmrId, patient_id: EmrId.optional(), ward_class: z.enum(WARD_CLASSES), admission_type: z.enum(ADMISSION_TYPES), reason: Text.max(2000) }),
  record_triage_vitals: z.strictObject({ visit_id: EmrId, patient_id: EmrId.optional(), ...vitals, priority: z.enum(PRIORITIES).optional(), note: Text.max(500).optional() }).refine(anyVital, "triage needs at least one measurement"),
  add_care_plan_item: z.strictObject({ admission_id: EmrId, title: Text.max(200), item_kind: z.enum(ITEM_KINDS), cadence: z.string().min(1).max(8) }),
  record_note: z.strictObject({ admission_id: EmrId, note_type: z.enum(NOTE_TYPES), text: Text, label: z.enum(["handover"]).optional() }),
  draft_handover: z.strictObject({ admission_id: EmrId }),
  page_staff: z.strictObject({ to: z.string().regex(/^[a-z_]{1,30}$/), text: Text.max(1500), patient_id: EmrId.optional(), visit_id: EmrId.optional(), admission_id: EmrId.optional() }),
  schedule_follow_up: z.strictObject({ visit_id: EmrId, patient_id: EmrId.optional(), clinic: z.string().regex(/^[a-z_]{1,30}$/), date: z.iso.date(), note: Text.max(500).optional() }),
  prepare_bill: z.strictObject({ admission_id: EmrId }),
  send_pay_link: z.strictObject({ admission_id: EmrId }),
  open_consult: z.strictObject({ visit_id: EmrId, patient_id: EmrId }),
  // The whole note as it stands goes with every write, so a later section never drops an earlier one.
  record_clerking: z.strictObject({ visit_id: EmrId, patient_id: EmrId.optional(), section: z.enum([...CLERKING_SECTIONS, "vitals", REPORTED_SECTION]), text: Text.max(2000), note: z.record(z.string(), z.string().max(12_000)).optional() }),
  record_allergy: z.strictObject({ patient_id: EmrId, visit_id: EmrId.optional(), substance: z.string().trim().min(1).max(120), severity: z.enum(ALLERGY_SEVERITIES), reaction: z.string().trim().min(1).max(500).optional(), source: z.enum(["patient", "relative"]) }),
  admit_patient: z.strictObject({ visit_id: EmrId, patient_id: EmrId.optional(), ward: z.string().regex(/^[a-z_]{1,30}$/), admission_type: z.enum(ADMISSION_TYPES), reason: Text.max(2000) }),
  assign_bed: z.strictObject({ admission_id: EmrId, ward: z.string().regex(/^[a-z_]{1,30}$/) }),
  schedule_review: z.strictObject({ admission_id: EmrId, title: Text.max(200), due_at: z.iso.datetime() }),
  // A voice order names the hospital's own test or medicine key; the door resolves the price and the catalogue row.
  order_test: z.strictObject({ visit_id: EmrId, patient_id: EmrId, test: z.string().regex(/^[a-z0-9_]{1,40}$/), priority: z.enum(ORDER_PRIORITIES).optional() }),
  prescribe: z.strictObject({
    visit_id: EmrId, patient_id: EmrId, drug: z.string().regex(/^[a-z0-9_]{1,40}$/), dose: z.string().trim().min(1).max(60).optional(),
    frequency: z.number().int().min(1).max(4).optional(), duration_days: z.number().int().min(1).max(365).optional(), quantity: z.number().int().min(1).max(1000), route: z.enum(DRUG_ROUTES).optional()
  }),
  // Countersigns exactly the batch the owner was shown: its item ids, digest and the moment it was read back.
  countersign: z.strictObject({ visit_id: EmrId, item_ids: z.array(EmrId).min(1).max(100), items_digest: z.string().regex(/^[0-9a-f]{64}$/), read_back_at: z.iso.datetime({ offset: true }), read_back_seal: z.string().regex(/^[A-Za-z0-9_-]{43}$/), labels: z.array(z.string().max(120)).max(100) }),
  // The clinical close of a stay; the diagnosis and medicines come from the record's paperwork, never from the words.
  release_home: z.strictObject({ admission_id: EmrId, instructions: Text.max(2000).optional(), follow_up_date: z.iso.date().optional() }),
  // The diagnosis in the clinician's own words, never a code; the person who signs the consultation carries it into the record.
  record_diagnosis: z.strictObject({ visit_id: EmrId, patient_id: EmrId, diagnosis: z.string().trim().min(2).max(500) })
};

// What each kind means to the speech gate; the gate prompt lists only the kinds the owner holds.
export const WORK_TEXT: Record<Exclude<WorkKind, typeof OBSERVATION_KIND>, string> = {
  draft_consult_note: "draft_consult_note: save the clinician's dictated assessment as the unsigned consultation draft, before the patient is admitted; text is their words.",
  request_admission: "request_admission: request admission for the patient in context; ward_class (general, private, icu, hdu, paeds, isolation, maternity), admission_type (emergency, planned, day_case), and text as the reason, all as said.",
  record_triage_vitals: "record_triage_vitals: the triage observations at arrival: temp_c, pulse, resp_rate, bp, spo2 (oxygen saturation in percent), weight_kg, priority (normal, urgent, emergency) and text as the triage note, all as said.",
  add_care_plan_item: "add_care_plan_item: add one item to the care plan: title in the clinician's words, item_kind (medication, nursing, observation, diet) and cadence (OD, BD, TDS, QID, q2h, q4h, q6h, q8h, q12h, STAT, PRN). One clause per item.",
  record_note: "record_note: write a note in the record: note_type (progress, ward_round, nursing) and text, the words dictated. Saving a handover draft you made is record_note with text null.",
  draft_handover: "draft_handover: draft a shift handover from the record for the clinician to review; nothing is written until they say to save it.",
  page_staff: "page_staff: send a page to another department or person; to names who (one of the page targets listed below) and text is the message in the clinician's words.",
  schedule_follow_up: "schedule_follow_up: book a follow-up appointment; clinic names the clinic (one of the clinics listed below) and date is the day said, written as YYYY-MM-DD.",
  prepare_bill: "prepare_bill: read the patient's bill and report what is charged, paid and outstanding; nothing is changed.",
  send_pay_link: "send_pay_link: send the patient the link to pay their bill.",
  open_consult: "open_consult: open the consultation for your clinician; you never name it, it is done when the note needs it.",
  record_clerking: "record_clerking: the clerking note; you never name it, findings and what the patient reported are written into it.",
  record_allergy: "record_allergy: add an allergy to the patient's allergy list when the clinician states one: substance, reaction and severity (mild, moderate, severe), all as said.",
  admit_patient: "admit_patient: admit the patient on your clinician's own authority: ward (one of the wards listed below), admission_type (emergency, planned, day_case) and text as the reason, all as said.",
  assign_bed: "assign_bed: put the admitted patient on a free bed in the ward said (one of the wards listed below).",
  schedule_review: "schedule_review: a review of the patient at a later time; title in the clinician's words and in_minutes as said.",
  order_test: "order_test: send a test for the patient in context: test (one of the tests listed below) and priority (routine, urgent, stat) only when said.",
  prescribe: "prescribe: prescribe a medicine for the patient in context: drug (one of the medicines listed below), dose as said (such as 1 g or 500 mg), frequency (doses per day, 1 to 4), duration_days, quantity and route (oral, iv, im, sc), all as said.",
  countersign: "countersign: you never name it; the clinician says sign everything.",
  release_home: "release_home: the clinician says the admitted patient may go home now, closing the stay; instructions are the advice said for the patient, follow_up_date only when a date is said, as YYYY-MM-DD. The diagnosis and medicines are read from the record, never from the words.",
  record_diagnosis: "record_diagnosis: the clinician settles the patient's diagnosis now, such as \"the diagnosis is malaria\" or \"put the diagnosis as malaria\"; text is the diagnosis in their own words only, never a code. It is read back and recorded only when the clinician then says confirm.",
};

// The value fields the wider gate tool adds for these kinds; the observation-only tool stays as committed.
export const WORK_FIELDS = ["text", "title", "item_kind", "cadence", "ward_class", "admission_type", "note_type", "priority", "spo2", "weight_kg", "to", "clinic", "date"] as const;
// The fields only a clerking owner's gate carries: the section of a finding, an allergy's parts, the ward, and when held work is due.
export const CLERKING_FIELDS = ["section", "substance", "reaction", "severity", "ward", "in_minutes", "after"] as const;
export type WorkField = (typeof WORK_FIELDS)[number];

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const ORD = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth"];
// True when the line names this calendar day: the month by name and the day by number or ordinal word.
export function dateSaid(date: string, line: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const low = line.toLowerCase();
  const day = Number(m[3]);
  const month = MONTHS[Number(m[2]) - 1]!;
  const dayHit = new RegExp(`\\b${day}(st|nd|rd|th)?\\b`).test(low) || (ORD[day] !== undefined && ORD[day] !== "" && new RegExp(`\\b${ORD[day]}\\b`).test(low));
  return low.includes(month) && dayHit;
}

// The cadence code a line names, when exactly one is said.
export function cadenceSaid(code: string, line: string): boolean {
  const low = ` ${line.toLowerCase().replace(/[-,.]/g, " ").replace(/\s+/g, " ")} `;
  return (CADENCE_WORDS[code] ?? []).some((p) => low.includes(` ${p} `)) || low.includes(` ${code.toLowerCase()} `);
}

// True when an enum value was said in the line, with underscores read as spaces.
export const wordSaid = (value: string, line: string): boolean => ` ${line.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `.includes(` ${value.toLowerCase().replace(/_/g, " ")} `);

// A plain line for the strip, built from the arguments rather than from model text.
export function summariseWork(kind: string, a: Record<string, unknown>): string {
  const t = (v: unknown, n = 80) => { const s = String(v ?? ""); return s.length > n ? `${s.slice(0, n - 3)}...` : s; };
  switch (kind) {
    case "draft_consult_note": return `Save the assessment to the consultation draft: "${t(a["text"])}"`;
    case "request_admission": return `Request ${t(a["admission_type"])} admission, ${String(a["ward_class"]).replace(/_/g, " ")} ward: ${t(a["reason"], 60)}`;
    case "record_triage_vitals": {
      const v = [a["temp_c"] !== undefined ? `temperature ${a["temp_c"]} C` : null, a["pulse"] !== undefined ? `pulse ${a["pulse"]}` : null, a["resp_rate"] !== undefined ? `respiratory rate ${a["resp_rate"]}` : null,
        a["bp"] !== undefined ? `blood pressure ${a["bp"]}` : null, a["spo2"] !== undefined ? `oxygen ${a["spo2"]}%` : null, a["weight_kg"] !== undefined ? `weight ${a["weight_kg"]} kg` : null].filter(Boolean).join(", ");
      return `Record triage: ${v}${a["priority"] ? `, priority ${a["priority"]}` : ""}`;
    }
    case "add_care_plan_item": return `Add to the care plan: ${t(a["title"], 60)} (${a["cadence"]})`;
    case "record_note": return `${a["label"] === "handover" ? "Save the handover" : `Write a ${String(a["note_type"]).replace(/_/g, " ")} note`}: "${t(a["text"], 60)}"`;
    case "draft_handover": return "Draft the shift handover from the record";
    case "page_staff": return `Page ${t(a["to"], 30)}: "${t(a["text"], 60)}"`;
    case "schedule_follow_up": return `Book a follow-up in ${String(a["clinic"]).replace(/_/g, " ")} on ${a["date"]}`;
    case "prepare_bill": return "Prepare the bill view";
    case "send_pay_link": return "Send the patient the pay link";
    case "open_consult": return "Open the consultation for you";
    case "record_clerking": return `Write to the clerking note, ${String(a["section"]).replace(/_/g, " ")}: "${t(a["text"], 60)}"`;
    case "record_allergy": return `Add allergy: ${t(a["substance"], 40)}${a["reaction"] ? ` (${t(a["reaction"], 40)})` : ""}, ${a["severity"]}, reported by the ${a["source"]}`;
    case "admit_patient": return `Admit, ${t(a["admission_type"])}, to the ${String(a["ward"]).replace(/_/g, " ")} ward on your authority: ${t(a["reason"], 60)}`;
    case "assign_bed": return `Put the patient on a free bed in the ${String(a["ward"]).replace(/_/g, " ")} ward`;
    case "schedule_review": return `Review due ${String(a["due_at"]).slice(11, 16)} UTC on the ward board: ${t(a["title"], 60)}`;
    case "order_test": return `Send the test: ${String(a["test"]).replace(/_/g, " ")}${a["priority"] && a["priority"] !== "routine" ? `, ${a["priority"]}` : ""}, as a voice order awaiting your countersign`;
    case "prescribe": return `Prescribe ${String(a["drug"]).replace(/_/g, " ")}${a["dose"] ? ` ${t(a["dose"], 30)}` : ""}${a["route"] ? ` ${String(a["route"]).toUpperCase()}` : ""}${a["frequency"] ? `, ${a["frequency"]} times a day` : ""}${a["duration_days"] ? ` for ${a["duration_days"]} days` : ""}, quantity ${a["quantity"]}, as a voice order awaiting your countersign`;
    case "record_diagnosis": return `Record the diagnosis: "${t(a["diagnosis"], 120)}"`;
    case "release_home": return `Discharge the patient home${a["follow_up_date"] ? `, follow-up ${a["follow_up_date"]}` : ""}${a["instructions"] ? `, advice: "${t(a["instructions"], 60)}"` : ""}`;
    case "countersign": return `Countersign ${(a["item_ids"] as unknown[]).length} voice order${(a["item_ids"] as unknown[]).length === 1 ? "" : "s"}: ${((a["labels"] as string[] | undefined) ?? []).join(", ").slice(0, 120)}`;
    default: return delegationSummary(kind, a) ?? kind;
  }
}

// The question that waits for the owner's own confirm line before such work is written.
export function confirmAsk(kind: string, summary: string): string {
  return kind === "record_diagnosis" ? `${summary}. Say confirm to record this diagnosis.` : `${summary}. This is a controlled drug: say confirm to send it.`;
}

const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, sixty: 60, ninety: 90 };
// The minutes a line says for a later time ("in one hour", "in 30 minutes", "half an hour"), or null when it says none.
export function minutesSaid(line: string): number | null {
  const low = ` ${line.toLowerCase().replace(/[,.!?]/g, " ").replace(/\s+/g, " ")} `;
  if (/ half an hour /.test(low)) return 30;
  const m = / (\d+|an?|one|two|three|four|five|six|ten|twelve|fifteen|twenty|thirty|forty|forty-five|sixty|ninety) (hours?|minutes?|mins?) /.exec(low);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : NUM_WORDS[m[1]!] ?? null;
  if (n === null) return null;
  return m[2]!.startsWith("hour") ? n * 60 : n;
}

// True when the line names what held work waits for: the admission, or a result coming back.
export function afterSaid(after: string, line: string): boolean {
  const low = line.toLowerCase();
  return after === "admission" ? /\badmit(ted|s)?\b|\badmission\b|\bon the ward\b/.test(low) : after === "result" ? /\bresults?\b|\bcomes? back\b|\bare back\b|\bis back\b/.test(low) : false;
}

const FREQUENCY_WORDS: readonly [RegExp, number][] = [
  [/\b(once (a|per) day|once daily|daily|every 24 hours|od)\b/, 1], [/\b(twice (a|per) day|twice daily|every 12 hours|bd)\b/, 2],
  [/\b(three times (a|per) day|three times daily|every 8 hours|tds)\b/, 3], [/\b(four times (a|per) day|four times daily|every 6 hours|qds|qid)\b/, 4]
];
const ROUTE_WORDS: readonly [RegExp, (typeof DRUG_ROUTES)[number]][] = [
  [/\b(iv|i v|intravenous(ly)?|into the vein)\b/, "iv"], [/\b(im|i m|intramuscular(ly)?)\b/, "im"], [/\b(oral(ly)?|by mouth|po|tablets?)\b/, "oral"],
  [/\b(sc|subcutaneous(ly)?|sub ?cut)\b/, "sc"], [/\b(rectal(ly)?|suppositor(y|ies))\b/, "rectal"], [/\b(inhaled|nebulised|nebulized|inhaler)\b/, "inhaled"]
];
const COUNT_WORDS: Record<string, number> = { one: 1, a: 1, an: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30 };
const countOf = (w: string) => (/^\d+$/.test(w) ? Number(w) : COUNT_WORDS[w] ?? null);

// The parts of a prescription the line itself says; nothing is worked out from anything else, except that stat or a single dose means one.
export function prescriptionSaid(line: string, c: { dose?: string | null | undefined }): { dose: string | null; frequency: number | null; duration_days: number | null; quantity: number | null; route: (typeof DRUG_ROUTES)[number] | null } {
  const low = ` ${line.toLowerCase().replace(/[,.!?]/g, " ").replace(/\s+/g, " ")} `;
  const nums = new Set((doseDigits(line).match(/\d+(?:\.\d+)?/g) ?? []).map((x) => String(Number(x))));
  const dose = c.dose && (c.dose.match(/\d+(?:\.\d+)?/g) ?? []).every((n) => nums.has(String(Number(n)))) && /\d/.test(c.dose) ? c.dose.trim() : null;
  const frequency = FREQUENCY_WORDS.find(([re]) => re.test(low))?.[1] ?? null;
  // A course is "for N days" or "N days"; "a day" belongs to the frequency, not the course.
  const dm = / for (\d+|[a-z]+) days? /.exec(low) ?? / (\d+|two|three|four|five|six|seven|ten|fourteen) days /.exec(low);
  const duration_days = dm ? countOf(dm[1]!) : null;
  const qm = / (?:quantity|dispense|supply) (\d+|[a-z]+) /.exec(low) ?? / (\d+|[a-z]+) (?:tablets?|vials?|ampoules?|doses?|bottles?|packs?) /.exec(low);
  const quantity = (qm ? countOf(qm[1]!) : null) ?? (/ (stat|a single dose|one dose|once only) /.test(low) ? 1 : null);
  const route = ROUTE_WORDS.find(([re]) => re.test(low))?.[1] ?? null;
  return { dose, frequency: frequency ?? null, duration_days: duration_days && duration_days >= 1 ? duration_days : null, quantity: quantity && quantity >= 1 ? quantity : null, route };
}

const UNIT_WORDS: readonly [RegExp, string][] = [
  [/^(mg|milligrams?|milligrammes?)$/, "mg"], [/^(g|grams?|grammes?|gm)$/, "g"], [/^(mcg|micrograms?|ug)$/, "mcg"],
  [/^(ml|millilit(er|re)s?|mils?)$/, "ml"], [/^(units?|iu)$/, "unit"], [/^(l|lit(er|re)s?)$/, "l"]
];
const unitOf = (w: string) => UNIT_WORDS.find(([re]) => re.test(w))?.[1] ?? null;

const SMALL: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
// A small number said as a word straight before a dose unit is that dose ("five milligrams" is 5 mg); the normaliser keeps single small words as words.
export function doseDigits(text: string): string {
  return text.replace(/\b(one|two|three|four|five|six|seven|eight|nine)(\s+)(mg|milligrams?|milligrammes?|g|grams?|grammes?|mcg|micrograms?|ml|millilit(?:er|re)s?|units?)\b/gi, (_m, w: string, sp: string, u: string) => `${SMALL[w.toLowerCase()]}${sp}${u}`);
}

// Every dose in a text as a number with its unit, from digits or the cleaned spoken form ("5 mg", "500 milligrams", "five milligrams").
export function dosesIn(text: string): { n: string; unit: string | null }[] {
  const toks = doseDigits(text).toLowerCase().replace(/(\d)([a-z])/g, "$1 $2").replace(/[^a-z0-9. ]+/g, " ").split(/\s+/).filter(Boolean);
  const out: { n: string; unit: string | null }[] = [];
  toks.forEach((t, i) => { if (/^\d+(\.\d+)?$/.test(t)) out.push({ n: String(Number(t)), unit: unitOf(toks[i + 1] ?? "") }); });
  return out;
}

// True when a line says a dose, so its second reading can start beside the gate.
export const saysDose = (text: string): boolean => dosesIn(text).some((d) => d.unit !== null && d.unit !== "unit");

// True when a second reading heard the same dose: the same number with the same unit, so milligrams heard as millilitres holds the order.
export function doseAgrees(dose: string, second: string): boolean {
  const first = dosesIn(dose)[0];
  if (!first) return true;
  return dosesIn(second).some((d) => d.n === first.n && (first.unit === null || d.unit === first.unit));
}
