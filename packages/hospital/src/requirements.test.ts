import { describe, expect, it } from "vitest";
import { loadWardRequirements, wardRequires } from "./requirements.js";

const set = loadWardRequirements();

describe("ward requirements r1", () => {
  it("covers Wards A, B and C with an approver and a start date", () => {
    expect(set.wards.map((w) => [w.ward_id, w.version, w.approver.role])).toEqual([["A", "r1", "ward_manager"], ["B", "r1", "ward_manager"], ["C", "r1", "ward_manager"]]);
  });
  it("requires the summary in A and B for a patient going home, never in C", () => {
    const home = { expected_disposition: "home" };
    expect(["A", "B", "C"].map((w) => wardRequires(set, w, "discharge_summary", home))).toEqual([true, true, false]);
  });
  it("never requires the summary for a transfer out", () => {
    const out = { expected_disposition: "transfer_out" };
    expect(["A", "B", "C"].some((w) => wardRequires(set, w, "discharge_summary", out))).toBe(false);
  });
  it("requires the claim cover only for an HMO payer", () => {
    expect(wardRequires(set, "A", "hmo_claim_cover", { payer_type: "hmo" })).toBe(true);
    expect(wardRequires(set, "A", "hmo_claim_cover", { payer_type: "self_pay" })).toBe(false);
  });
});

describe("ward requirements r2", () => {
  const r1 = loadWardRequirements("r1");
  const r2 = loadWardRequirements("r2");
  it("changes only Ward B: a new version, approver and start date, the same required documents", () => {
    expect(r2.requirement_version).toBe("r2");
    const b = r2.wards.find((w) => w.ward_id === "B")!;
    expect([b.version, b.effective_from, b.approver.role, b.approver.staff_id]).toEqual(["r2", "2026-10-31", "ward_manager", "wm_b"]);
    expect(b.required_documents).toEqual(r1.wards.find((w) => w.ward_id === "B")!.required_documents);
    expect(r2.wards.filter((w) => w.ward_id !== "B")).toEqual(r1.wards.filter((w) => w.ward_id !== "B"));
  });
  it("carries the new procedure text and says nothing about when to finalise", () => {
    const text = r2.wards.find((w) => w.ward_id === "B")!.procedure_text;
    expect(text).toBe("The discharge summary given to the patient lists the take-home medicines exactly as dispensed by pharmacy, including strength, quantity and any substitution.");
    expect(/final|after|before|wait/i.test(text)).toBe(false);
  });
});
