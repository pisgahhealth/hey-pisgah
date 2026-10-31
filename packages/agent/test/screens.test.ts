import { describe, expect, it } from "vitest";
import { unidentifiedRef } from "../src/emr/entry.js";
import { SCREENS, SCREEN_PAGES, openableHref, screenFor } from "../src/emr/screens.js";

const PATIENT = "aaaaaaaa-1111-4222-8333-444444444444";
const VISIT = "bbbbbbbb-1111-4222-8333-444444444444";
const HREF: Record<string, string> = { triage: "/triage-page", doctor_workspace: "/worklist-page" };

describe("the screens the strip can operate", () => {
  it("binds a screen plan to its encounter, with the page's place from the profile", () => {
    expect(screenFor("record_triage_vitals", { visit_id: VISIT, patient_id: PATIENT, pulse: 110, bp: "90/60" }, { patient_id: null, visit_id: null, admission_id: "" }, undefined, (p) => HREF[p]))
      .toEqual({ page: "triage", section: "vitals", href: "/triage-page", encounter: { patient_id: PATIENT, visit_id: VISIT, admission_id: null }, values: { pulse: "110", bp_sys: "90", bp_dia: "60" } });
    expect(screenFor("nudge_owner", {}, { patient_id: null, visit_id: null, admission_id: "" })).toBeNull();
    expect(unidentifiedRef(new Date("2026-10-29T18:42:00Z"))).toBe("Unknown arrival 19:42");
  });

  it("uses only known pages and moves a kind to an owner's page", () => {
    for (const spec of Object.values(SCREENS)) expect(SCREEN_PAGES).toContain(spec.page);
    expect(screenFor("open_unnamed_encounter", { reason: "x" }, { patient_id: PATIENT, visit_id: VISIT, admission_id: "" }, "doctor_workspace", (p) => HREF[p])).toMatchObject({ page: "doctor_workspace", href: "/worklist-page" });
    expect(screenFor("open_unnamed_encounter", { reason: "x" }, { patient_id: PATIENT, visit_id: VISIT, admission_id: "" })).toMatchObject({ href: "" });
  });

  // Review 4, item 1: the screen follows the agent for every kind of work the acceptance journey does.
  it("names a page and section for every kind the journey does", () => {
    const journey: Record<string, string> = {
      open_unnamed_encounter: "registration", complete_registration: "registration", record_clerking: "clerking note", record_observation: "vitals",
      order_test: "lab order", prescribe: "prescription", admit_patient: "admission", assign_bed: "bed", delegate_task: "delegation",
      countersign: "countersign", send_pay_link: "payment request", release_home: "discharge", prepare_bill: "bill",
      record_allergy: "allergy", record_diagnosis: "diagnosis", add_care_plan_item: "care plan"
    };
    for (const kind of Object.keys(journey)) {
      const spec = SCREENS[kind];
      expect(spec, `${kind} (${journey[kind]}) has a page`).toBeDefined();
      expect(SCREEN_PAGES).toContain(spec!.page);
      expect(spec!.section.length).toBeGreaterThan(0);
    }
    const plan = screenFor("prescribe", { visit_id: VISIT, patient_id: PATIENT, drug: "paracetamol_iv", dose: "1 g", frequency: 3, duration_days: 1, quantity: 3 }, { patient_id: null, visit_id: null, admission_id: "" }, undefined, () => "/doctor");
    expect(plan).toMatchObject({ page: "doctor_workspace", section: "orders", href: "/doctor", values: { drug: "paracetamol_iv", dose: "1 g", frequency: "3", duration_days: "1", quantity: "3" } });
  });

  it("opens a stay page only once the stay it names is known", () => {
    const STAY = "eeeeeeee-1111-4222-8333-444444444444";
    const tpl = (p: string) => (p === "stay" ? "/ward/{admission_id}" : undefined);
    expect(screenFor("assign_bed", { admission_id: STAY, ward: "a_and_e" }, { patient_id: PATIENT, visit_id: VISIT, admission_id: "" }, undefined, tpl)).toMatchObject({ page: "stay", section: "bed", href: `/ward/${STAY}` });
    const unknown = screenFor("release_home", {}, { patient_id: PATIENT, visit_id: VISIT, admission_id: "" }, undefined, tpl)!;
    expect(unknown.href).toBe("/ward/{admission_id}");
    expect(openableHref(unknown.href, unknown.encounter)).toBe("");
    expect(openableHref(unknown.href, { ...unknown.encounter, admission_id: STAY })).toBe(`/ward/${STAY}`);
  });
});
