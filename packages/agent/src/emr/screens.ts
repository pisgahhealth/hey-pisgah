import { EMERGENCY_KIND } from "./entry.js";

// What the strip can show for a kind of work: the page that holds its real controls, where that page lives, and the values that fill them.
export type ScreenPage = "triage" | "doctor_workspace" | "admissions" | "reception_identity";
export type ScreenPlan = {
  page: ScreenPage; href: string;
  encounter: { patient_id: string | null; visit_id: string | null; admission_id: string | null };
  values: Record<string, string>;
};
type Subject = { patient_id: string | null; visit_id: string | null; admission_id: string };
type Spec = { page: ScreenPage; values: (a: Record<string, unknown>) => Record<string, string> };

const str = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));
const pick = (a: Record<string, unknown>, keys: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(keys).map(([to, from]) => [to, str(a[from])]).filter((e): e is [string, string] => e[1] !== null));

export const SCREEN_PAGES: readonly ScreenPage[] = ["triage", "doctor_workspace", "admissions", "reception_identity"];

// The registry the serve and the strip share; a kind absent here is done in the background and only reported in the strip.
export const SCREENS: Record<string, Spec> = {
  [EMERGENCY_KIND]: { page: "triage", values: (a) => pick(a, { reason: "reason" }) },
  record_triage_vitals: {
    page: "triage",
    values: (a) => ({ ...pick(a, { temp_c: "temp_c", pulse: "pulse", resp_rate: "resp_rate", spo2: "spo2", weight_kg: "weight_kg", note: "note" }), ...(typeof a["bp"] === "string" ? { bp_sys: a["bp"].split("/")[0]!, bp_dia: a["bp"].split("/")[1] ?? "" } : {}) })
  },
  draft_consult_note: { page: "doctor_workspace", values: (a) => pick(a, { note: "text" }) },
  request_admission: { page: "admissions", values: (a) => pick(a, { reason: "reason", ward_class: "ward_class", admission_type: "admission_type" }) },
  record_identity: { page: "reception_identity", values: (a) => pick(a, { full_name: "name", phone: "phone" }) }
};

// The plan for one action, bound to its encounter; where each page lives comes from the hospital's private profile.
export function screenFor(kind: string, args: Record<string, unknown>, s: Subject, page?: ScreenPage, hrefOf?: (page: ScreenPage) => string | undefined): ScreenPlan | null {
  const base = SCREENS[kind];
  if (!base) return null;
  const spec = page && page !== base.page ? { ...base, page } : base;
  const patient = str(args["patient_id"]) ?? s.patient_id;
  const visit = str(args["visit_id"]) ?? s.visit_id;
  const admission = str(args["admission_id"]) ?? (s.admission_id || null);
  return { page: spec.page, href: hrefOf?.(spec.page) ?? "", encounter: { patient_id: patient, visit_id: visit, admission_id: admission }, values: spec.values(args) };
}
