import { describe, expect, it } from "vitest";
import { NO_ADMISSION_REASON, admissionReason } from "../src/emr/work.js";
import { identityFrom } from "../src/emr/entry.js";

// Samuel's first browser test, 1 Nov: the admission reason and diagnosis carried the instruction words, and a patient's own name raised "for whom?".
describe("the admission reason is clinical or left unstated", () => {
  it("never copies the instruction words", () => {
    expect(admissionReason("you have to admit her we have to admit her in the emergency ward")).toBe(NO_ADMISSION_REASON);
    expect(admissionReason("She has to come in. Admit her to A and E as an emergency, and let's get her on a bed.")).toBe(NO_ADMISSION_REASON);
  });
  it("keeps a stated clinical reason", () => {
    expect(admissionReason("Admit her to A and E for severe dehydration and malaria")).toBe("severe dehydration and malaria");
    expect(admissionReason("Admit him as an emergency because of a suspected tibial fracture, and let's get him on a bed")).toBe("a suspected tibial fracture");
  });
});

describe("a patient's own name on an unnamed arrival", () => {
  it("is read as an identity line, the rule that keeps it off the for-whom hold", () => {
    expect(identityFrom("My name is Blessing Adeyemi.")?.name).toBe("Blessing Adeyemi");
  });
});
