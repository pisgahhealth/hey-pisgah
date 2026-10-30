import { describe, expect, it } from "vitest";
import type { PaperworkReadBack } from "../src/emr/port.js";
import { paperworkAsk } from "../src/emr/runtime.js";

const PAPER: PaperworkReadBack = { digest: "d".repeat(64), diagnosis: "Malaria", dispensed: ["Artemether 6"], exceptions: [], tests: { resulted: 1, total: 2 }, unsigned: 0 };

describe("the discharge question names what is still pending", () => {
  it("reads back each result the hospital says is pending before asking for the confirm", () => {
    const ask = paperworkAsk("Discharge home", { ...PAPER, pending: ["Full blood count: result pending at discharge"] });
    expect(ask).toContain("Pending at discharge: Full blood count: result pending at discharge.");
    expect(ask.indexOf("Pending at discharge")).toBeLessThan(ask.indexOf("Say confirm"));
  });

  it("says nothing of pending results when there are none", () => {
    expect(paperworkAsk("Discharge home", PAPER)).not.toContain("Pending");
    expect(paperworkAsk("Discharge home", { ...PAPER, pending: [] })).not.toContain("Pending");
  });
});
