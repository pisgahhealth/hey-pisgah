import { describe, expect, it } from "vitest";
import { PACKAGE } from "./index.js";
describe("contracts", () => {
  it("exports its package name", () => {
    expect(PACKAGE).toBe("contracts");
  });
});
