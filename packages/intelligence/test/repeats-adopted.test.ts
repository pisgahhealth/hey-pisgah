import { describe, expect, it } from "vitest";
import { repeatsAdopted } from "../src/claims-results.js";

const ADOPTED = [{ op: "remove_soft_edge", edge_id: "e04" }, { op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st01" } } }];

describe("the second cycle's comparison with the adopted change", () => {
  it("counts a proposal as the adopted change again only when every nested field matches, in any key order", () => {
    expect(repeatsAdopted([{ edge_id: "e04", op: "remove_soft_edge" }, { when: { after: { step: "st01" } }, target: { step: "st06" }, op: "set_prep_trigger" }], ADOPTED)).toBe(true);
  });

  it("does not count a trigger on another step, or after another event, as the adopted change", () => {
    expect(repeatsAdopted([ADOPTED[0], { op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st02" } } }], ADOPTED)).toBe(false);
    expect(repeatsAdopted([ADOPTED[0], { op: "set_prep_trigger", target: { step: "st07" }, when: { after: { step: "st01" } } }], ADOPTED)).toBe(false);
    expect(repeatsAdopted([ADOPTED[0], { op: "set_prep_trigger", target: { step: "st06" }, when: { any_of: [{ after: { step: "st01" } }, { after: { step: "st05" } }] } }], ADOPTED)).toBe(false);
  });
});
