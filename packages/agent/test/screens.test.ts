import { describe, expect, it } from "vitest";
import { unidentifiedRef } from "../src/emr/entry.js";
import { SCREENS, SCREEN_PAGES, screenFor } from "../src/emr/screens.js";

const PATIENT = "aaaaaaaa-1111-4222-8333-444444444444";
const VISIT = "bbbbbbbb-1111-4222-8333-444444444444";
const HREF: Record<string, string> = { triage: "/triage-page", doctor_workspace: "/worklist-page" };

describe("the screens the strip can operate", () => {
  it("binds a screen plan to its encounter, with the page's place from the profile", () => {
    expect(screenFor("record_triage_vitals", { visit_id: VISIT, patient_id: PATIENT, pulse: 110, bp: "90/60" }, { patient_id: null, visit_id: null, admission_id: "" }, undefined, (p) => HREF[p]))
      .toEqual({ page: "triage", href: "/triage-page", encounter: { patient_id: PATIENT, visit_id: VISIT, admission_id: null }, values: { pulse: "110", bp_sys: "90", bp_dia: "60" } });
    expect(screenFor("prepare_bill", {}, { patient_id: null, visit_id: null, admission_id: "" })).toBeNull();
    expect(unidentifiedRef(new Date("2026-10-29T18:42:00Z"))).toBe("Unknown arrival 19:42");
  });

  it("uses only known pages and moves a kind to an owner's page", () => {
    for (const spec of Object.values(SCREENS)) expect(SCREEN_PAGES).toContain(spec.page);
    expect(screenFor("open_unnamed_encounter", { reason: "x" }, { patient_id: PATIENT, visit_id: VISIT, admission_id: "" }, "doctor_workspace", (p) => HREF[p])).toMatchObject({ page: "doctor_workspace", href: "/worklist-page" });
    expect(screenFor("open_unnamed_encounter", { reason: "x" }, { patient_id: PATIENT, visit_id: VISIT, admission_id: "" })).toMatchObject({ href: "" });
  });
});
