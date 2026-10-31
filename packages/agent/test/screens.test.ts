import { describe, expect, it } from "vitest";
import { unidentifiedRef } from "../src/emr/entry.js";
import { BACKGROUND_KINDS, SCREENS, SCREEN_PAGES, openableHref, screenFor } from "../src/emr/screens.js";

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
    for (const [kind, spec] of Object.entries(SCREENS)) expect(spec.page === null ? kind : SCREEN_PAGES.includes(spec.page) ? "known" : kind).toMatch(/^(known|acknowledge_task)$/);
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

  // Every kind the acceptance script writes or drafts, with the identity a clinician now writes on an emergency arrival.
  const SCRIPT_KINDS = [
    "open_unnamed_encounter", "acknowledge_task", "complete_registration", "record_identity", "record_clerking", "record_allergy", "order_test", "prescribe",
    "admit_patient", "assign_bed", "record_observation", "record_triage_vitals", "add_care_plan_item", "schedule_review", "page_staff", "prepare_order",
    "record_diagnosis", "record_note", "draft_stay_summary", "countersign", "dispense_order", "release_home", "prepare_bill", "send_pay_link"
  ];

  it("gives every script kind a page, or lists it as done in the background", () => {
    for (const kind of SCRIPT_KINDS) {
      const spec = SCREENS[kind];
      const background = BACKGROUND_KINDS.has(kind);
      expect(Boolean(spec) || background, `${kind} has a page or is background`).toBe(true);
      expect(Boolean(spec?.page) && background, `${kind} is not both`).toBe(false);
      if (spec?.page) expect(SCREEN_PAGES).toContain(spec.page);
    }
  });

  it("shows each recipient's work on that person's own page, with no raw ids among the values", () => {
    const s = { patient_id: PATIENT, visit_id: VISIT, admission_id: "" };
    const RX = "cccccccc-1111-4222-8333-444444444444";
    const TASK = "dddddddd-1111-4222-8333-444444444444";
    for (const kind of ["prepare_order", "dispense_order"]) {
      const plan = screenFor(kind, { delegation_id: TASK, prescription_id: RX, title: "Dispense the voice order", evidence: "transcript:L1" }, s, undefined, (p) => (p === "pharmacy_queue" ? "/rx-queue" : undefined));
      expect(plan).toMatchObject({ page: "pharmacy_queue", section: "queue", href: "/rx-queue", values: { task: "Dispense the voice order" } });
      expect(Object.values(plan!.values).join(" ")).not.toMatch(/[0-9a-f]{8}-/);
    }
    expect(screenFor("prepare_bill", { admission_id: VISIT }, s)).toMatchObject({ page: "accounts_desk", section: "bill" });
    expect(screenFor("send_pay_link", { admission_id: VISIT }, s)).toMatchObject({ page: "accounts_desk", section: "bill" });
    // A hand-off accepted is background unless the owner's profile names the page its work lands on.
    const ack = { delegation_id: TASK, title: "Receive the lab order", evidence: "transcript:L2" };
    expect(screenFor("acknowledge_task", ack, s)).toBeNull();
    expect(screenFor("acknowledge_task", ack, s, "lab_board")).toMatchObject({ page: "lab_board", section: "worklist", values: { task: "Receive the lab order" } });
    expect(screenFor("page_staff", { to: "lab", text: "cancel it" }, s)).toBeNull();
  });

  it("shows a name a clinician gives an emergency arrival on that clinician's encounter panel", () => {
    const plan = screenFor("record_identity", { patient_id: PATIENT, visit_id: VISIT, name: "Blessing Adeyemi" }, { patient_id: null, visit_id: null, admission_id: "" }, undefined, (p) => HREF[p]);
    expect(plan).toMatchObject({ page: "doctor_workspace", section: "arrival", href: "/worklist-page", encounter: { patient_id: PATIENT, visit_id: VISIT } });
  });
});
