import { describe, expect, it } from "vitest";
import { g1, g2, g3, g4, g5 } from "../src/checks.js";
import { sample } from "./helpers.js";

const wide = sample(6);
const show = (label: string, v: unknown) => console.log(`${label} ${JSON.stringify(v)}`);

describe("generator assertions on a wider sample of seeds", () => {
  it("G1, G2, G3, G4 and G5 hold on 132 generated cases", () => {
    const a = g1(wide), b = g2(wide), c = g3(wide), d = g4(wide), e = g5(wide);
    show("G1 sample", { p90: a.non_f3_p90, f3_min_recorded: Math.min(...a.f3.map((x) => x.recorded)), f3_max_occurred: Math.max(...a.f3.map((x) => x.occurred)) });
    show("G2 sample", b.cut_by_family);
    show("G3 sample", c);
    show("G5 sample", { events: e.events, violations: e.violations.length });
    expect([a.pass, b.pass, c.applicable && c.pass, d.pass, e.pass]).toEqual([true, true, true, true, true]);
  });
});
