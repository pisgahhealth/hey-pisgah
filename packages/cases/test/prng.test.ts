import { describe, expect, it } from "vitest";
import { drawer } from "../src/prng.js";
import { generateCase } from "../src/generate.js";
import { CASE_VALUES, baseValues } from "../src/values.js";

describe("keyed draws", () => {
  it("depend only on the seed and the job key", () => {
    const a = drawer("s1"), b = drawer("s1"), c = drawer("s2");
    expect(a.int("round_at", 480, 540)).toBe(b.int("round_at", 480, 540));
    expect([a.u("x"), a.u("y")]).not.toEqual([c.u("x"), c.u("y")]);
    for (let i = 0; i < 200; i++) { const v = a.int(`k${i}`, 3, 7); expect(v >= 3 && v <= 7).toBe(true); }
  });
  it("give two worlds built from one seed the same draws for every job they share", () => {
    const x = generateCase("F2", "crn", "A", "self_pay"), y = generateCase("F9", "crn", "A", "self_pay");
    expect(x.schedule.steps["st01"]!.due).toEqual(y.schedule.steps["st01"]!.due);
    expect(x.schedule.steps["st02"]).toEqual(y.schedule.steps["st02"]);
    expect(x.schedule.steps["st05"]).toEqual(y.schedule.steps["st05"]);
    expect(x.schedule.service_min).toEqual(y.schedule.service_min);
    expect(x.manifest.case_id).toBe(y.manifest.case_id);
  });
  it("take base values from the hospital parameters and tag every range of their own", () => {
    expect(baseValues()["signoff_at"]).toMatchObject({ min: 570, max: 690 });
    for (const v of [...Object.values(CASE_VALUES), ...Object.values(baseValues())]) {
      expect(v.min).toBeLessThanOrEqual(v.max);
      expect(["observed", "assumed"]).toContain(v.tag);
    }
  });
});
