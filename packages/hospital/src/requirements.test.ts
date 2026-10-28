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
