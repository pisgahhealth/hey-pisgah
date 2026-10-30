import { describe, expect, it } from "vitest";
import { DIAGNOSIS_RULE, denyHits, gatePrompt, gateTool } from "../src/emr/gate.js";
import { ORDER_KINDS } from "../src/emr/speaker.js";
import { OWNER_CONFIRM_KINDS, WORK_ARGS, confirmAsk, summariseWork } from "../src/emr/work.js";

const VIS = "55555555-4444-4555-8666-777777777777";
const PAT = "33333333-4444-4555-8666-777777777777";
const names = { page_targets: {}, clinics: {}, wards: {}, tests: {}, drugs: {} };

describe("the diagnosis by voice", () => {
  it("is named to the gate only for an owner who holds it, with its rule, and no denied word", () => {
    const kinds = ["record_observation", "record_clerking", "order_test", "prescribe", "release_home", "record_diagnosis"];
    const p = gatePrompt(kinds, names);
    expect(p).toContain("- record_diagnosis:");
    expect(p).toContain(DIAGNOSIS_RULE);
    expect(denyHits(`${p}\n${JSON.stringify(gateTool(kinds))}`)).toEqual([]);
    const without = gatePrompt(kinds.filter((k) => k !== "record_diagnosis"), names);
    expect(without).not.toContain("record_diagnosis");
  });

  it("needs the owner's own matched voice and a confirm line, and carries the words only, never a code", () => {
    expect(ORDER_KINDS.has("record_diagnosis")).toBe(true);
    expect(OWNER_CONFIRM_KINDS.has("record_diagnosis")).toBe(true);
    const ok = WORK_ARGS.record_diagnosis.safeParse({ visit_id: VIS, patient_id: PAT, diagnosis: "Acute appendicitis" });
    expect(ok.success).toBe(true);
    expect(WORK_ARGS.record_diagnosis.safeParse({ visit_id: VIS, patient_id: PAT, diagnosis: "Acute appendicitis", icd10_code: "K35" }).success).toBe(false);
    expect(WORK_ARGS.record_diagnosis.safeParse({ visit_id: VIS, diagnosis: "Acute appendicitis" }).success).toBe(false);
    const summary = summariseWork("record_diagnosis", { diagnosis: "Acute appendicitis" });
    expect(summary).toBe('Record the diagnosis: "Acute appendicitis"');
    expect(confirmAsk("record_diagnosis", summary)).toBe('Record the diagnosis: "Acute appendicitis". Say confirm to record this diagnosis.');
    expect(confirmAsk("prescribe", "Prescribe morphine")).toContain("controlled drug");
  });
});
