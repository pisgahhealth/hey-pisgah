import { EMERGENCY_KIND } from "./entry.js";

// What the strip can show for a kind of work: the page and section that hold it, where that page lives, and the values it displays before the commit.
export type ScreenPage = "triage" | "doctor_workspace" | "admissions" | "reception_identity" | "stay";
export type ScreenPlan = {
  page: ScreenPage; section: string; href: string;
  encounter: { patient_id: string | null; visit_id: string | null; admission_id: string | null };
  values: Record<string, string>;
};
type Subject = { patient_id: string | null; visit_id: string | null; admission_id: string };
type Spec = { page: ScreenPage; section: string; values: (a: Record<string, unknown>) => Record<string, string> };

const str = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : Array.isArray(v) ? v.join(", ") : String(v));
const pick = (a: Record<string, unknown>, keys: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(keys).map(([to, from]) => [to, str(a[from])]).filter((e): e is [string, string] => e[1] !== null));
const bp = (a: Record<string, unknown>): Record<string, string> => (typeof a["bp"] === "string" ? { bp_sys: a["bp"].split("/")[0]!, bp_dia: a["bp"].split("/")[1] ?? "" } : {});
const VITALS = { temp_c: "temp_c", pulse: "pulse", resp_rate: "resp_rate", spo2: "spo2", weight_kg: "weight_kg", note: "note" };

export const SCREEN_PAGES: readonly ScreenPage[] = ["triage", "doctor_workspace", "admissions", "reception_identity", "stay"];
// The ids a page route may name; the strip opens the page only once every one it names is known.
export const HREF_IDS = ["admission_id", "patient_id", "visit_id"] as const;

// The registry the serve and the strip share; a kind absent here is done in the background and only reported in the strip.
export const SCREENS: Record<string, Spec> = {
  [EMERGENCY_KIND]: { page: "triage", section: "arrival", values: (a) => pick(a, { reason: "reason" }) },
  record_triage_vitals: { page: "triage", section: "vitals", values: (a) => ({ ...pick(a, VITALS), ...bp(a) }) },
  complete_registration: { page: "reception_identity", section: "identity", values: (a) => pick(a, { surname: "surname", other_names: "other_names", phone: "phone", consent: "consent_purposes" }) },
  record_identity: { page: "reception_identity", section: "identity", values: (a) => pick(a, { full_name: "name", phone: "phone" }) },
  open_consult: { page: "doctor_workspace", section: "note", values: () => ({}) },
  draft_consult_note: { page: "doctor_workspace", section: "note", values: (a) => pick(a, { note: "text" }) },
  record_clerking: { page: "doctor_workspace", section: "note", values: (a) => pick(a, { note: "text", part: "section" }) },
  record_diagnosis: { page: "doctor_workspace", section: "note", values: (a) => pick(a, { diagnosis: "diagnosis" }) },
  record_allergy: { page: "doctor_workspace", section: "allergies", values: (a) => pick(a, { substance: "substance", reaction: "reaction", severity: "severity" }) },
  order_test: { page: "doctor_workspace", section: "orders", values: (a) => pick(a, { test: "test" }) },
  prescribe: { page: "doctor_workspace", section: "orders", values: (a) => pick(a, { drug: "drug", dose: "dose", route: "route", frequency: "frequency", duration_days: "duration_days", quantity: "quantity" }) },
  take_verbal_order: { page: "doctor_workspace", section: "orders", values: (a) => pick(a, { drug: "drug", dose: "dose", route: "route" }) },
  countersign: { page: "doctor_workspace", section: "orders", values: () => ({}) },
  admit_patient: { page: "doctor_workspace", section: "admission", values: (a) => pick(a, { admission_type: "admission_type", ward: "ward", reason: "reason" }) },
  delegate_task: { page: "doctor_workspace", section: "handed_on", values: (a) => pick(a, { team: "team", task: "title" }) },
  request_admission: { page: "admissions", section: "admission", values: (a) => pick(a, { reason: "reason", ward_class: "ward_class", admission_type: "admission_type" }) },
  assign_bed: { page: "stay", section: "bed", values: (a) => pick(a, { ward: "ward", bed: "bed" }) },
  record_observation: { page: "stay", section: "vitals", values: (a) => ({ ...pick(a, VITALS), ...bp(a) }) },
  add_care_plan_item: { page: "stay", section: "care_plan", values: (a) => pick(a, { item: "title", cadence: "cadence" }) },
  schedule_review: { page: "stay", section: "care_plan", values: (a) => pick(a, { item: "title", due: "due_at" }) },
  record_note: { page: "stay", section: "notes", values: (a) => pick(a, { note: "text" }) },
  request_ward_review: { page: "stay", section: "notes", values: (a) => pick(a, { review: "reason", team: "team" }) },
  release_home: { page: "stay", section: "discharge", values: () => ({}) },
  send_pay_link: { page: "stay", section: "bill", values: (a) => pick(a, { amount: "amount" }) },
  prepare_bill: { page: "stay", section: "bill", values: () => ({}) }
};

// Fills "{admission_id}" style ids in a page route; an id not yet known stays named, so the route is not opened until it is.
export function fillHref(tpl: string, e: ScreenPlan["encounter"]): string {
  return tpl.replace(/\{(admission_id|patient_id|visit_id)\}/g, (m, k: (typeof HREF_IDS)[number]) => e[k] ?? m);
}
// The route the strip may open now, or "" while it still names an id nobody knows.
export function openableHref(tpl: string, e: ScreenPlan["encounter"]): string {
  const href = fillHref(tpl, e);
  return href.includes("{") ? "" : href;
}

// The plan for one action, bound to its encounter; where each page lives comes from the hospital's private profile.
export function screenFor(kind: string, args: Record<string, unknown>, s: Subject, page?: ScreenPage, hrefOf?: (page: ScreenPage) => string | undefined): ScreenPlan | null {
  const base = SCREENS[kind];
  if (!base) return null;
  const spec = page && page !== base.page ? { ...base, page } : base;
  const patient = str(args["patient_id"]) ?? s.patient_id;
  const visit = str(args["visit_id"]) ?? s.visit_id;
  const admission = str(args["admission_id"]) ?? (s.admission_id || null);
  const encounter = { patient_id: patient, visit_id: visit, admission_id: admission };
  return { page: spec.page, section: spec.section, href: fillHref(hrefOf?.(spec.page) ?? "", encounter), encounter, values: spec.values(args) };
}
