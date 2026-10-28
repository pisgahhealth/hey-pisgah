import { z } from "zod";
import { EmrId, OBSERVATION_KIND } from "./port.js";

// Every kind of work an EMR agent can hold; an owner holds only the kinds its profile grants.
export const WORK_KINDS = [
  OBSERVATION_KIND, "draft_consult_note", "request_admission", "record_triage_vitals", "add_care_plan_item",
  "record_note", "draft_handover", "page_staff", "schedule_follow_up", "prepare_bill", "send_pay_link"
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
// Kinds that only read the record and report back; they change nothing in it.
export const READ_ONLY_KINDS: ReadonlySet<string> = new Set(["draft_handover", "prepare_bill"]);

export const WARD_CLASSES = ["general", "private", "semi_private", "icu", "hdu", "paeds", "isolation", "maternity"] as const;
export const ADMISSION_TYPES = ["emergency", "planned", "day_case"] as const;
export const ITEM_KINDS = ["medication", "nursing", "observation", "diet"] as const;
export const NOTE_TYPES = ["progress", "ward_round", "nursing"] as const;
export const PRIORITIES = ["normal", "urgent", "emergency"] as const;
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
  spo2: z.number().int().min(50).max(100).optional()
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
  send_pay_link: z.strictObject({ admission_id: EmrId })
};

// What each kind means to the speech gate; the gate prompt lists only the kinds the owner holds.
export const WORK_TEXT: Record<Exclude<WorkKind, typeof OBSERVATION_KIND>, string> = {
  draft_consult_note: "draft_consult_note: save the clinician's dictated assessment as the unsigned consultation draft, before the patient is admitted; text is their words.",
  request_admission: "request_admission: request admission for the patient in context; ward_class (general, private, icu, hdu, paeds, isolation, maternity), admission_type (emergency, planned, day_case), and text as the reason, all as said.",
  record_triage_vitals: "record_triage_vitals: the triage observations at arrival: temp_c, pulse, resp_rate, bp, spo2 (oxygen saturation in percent), priority (normal, urgent, emergency) and text as the triage note, all as said.",
  add_care_plan_item: "add_care_plan_item: add one item to the care plan: title in the clinician's words, item_kind (medication, nursing, observation, diet) and cadence (OD, BD, TDS, QID, q2h, q4h, q6h, q8h, q12h, STAT, PRN). One clause per item.",
  record_note: "record_note: write a note in the record: note_type (progress, ward_round, nursing) and text, the words dictated. Saving a handover draft you made is record_note with text null.",
  draft_handover: "draft_handover: draft a shift handover from the record for the clinician to review; nothing is written until they say to save it.",
  page_staff: "page_staff: send a page to another department or person; to names who (one of the page targets listed below) and text is the message in the clinician's words.",
  schedule_follow_up: "schedule_follow_up: book a follow-up appointment; clinic names the clinic (one of the clinics listed below) and date is the day said, written as YYYY-MM-DD.",
  prepare_bill: "prepare_bill: read the patient's bill and report what is charged, paid and outstanding; nothing is changed.",
  send_pay_link: "send_pay_link: send the patient the link to pay their bill."
};

// The value fields the wider gate tool adds for these kinds; the observation-only tool stays as committed.
export const WORK_FIELDS = ["text", "title", "item_kind", "cadence", "ward_class", "admission_type", "note_type", "priority", "spo2", "to", "clinic", "date"] as const;
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
        a["bp"] !== undefined ? `blood pressure ${a["bp"]}` : null, a["spo2"] !== undefined ? `oxygen ${a["spo2"]}%` : null].filter(Boolean).join(", ");
      return `Record triage: ${v}${a["priority"] ? `, priority ${a["priority"]}` : ""}`;
    }
    case "add_care_plan_item": return `Add to the care plan: ${t(a["title"], 60)} (${a["cadence"]})`;
    case "record_note": return `${a["label"] === "handover" ? "Save the handover" : `Write a ${String(a["note_type"]).replace(/_/g, " ")} note`}: "${t(a["text"], 60)}"`;
    case "draft_handover": return "Draft the shift handover from the record";
    case "page_staff": return `Page ${t(a["to"], 30)}: "${t(a["text"], 60)}"`;
    case "schedule_follow_up": return `Book a follow-up in ${String(a["clinic"]).replace(/_/g, " ")} on ${a["date"]}`;
    case "prepare_bill": return "Prepare the bill view";
    case "send_pay_link": return "Send the patient the pay link";
    default: return kind;
  }
}
