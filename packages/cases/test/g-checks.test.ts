import { describe, expect, it } from "vitest";
import { g1, g2, g3, g4, g5 } from "../src/checks.js";
import { asChecked, committed } from "./helpers.js";

const pools = asChecked(committed());
const show = (label: string, v: unknown) => console.log(`${label} ${JSON.stringify(v)}`);

describe("generator assertions on the committed pools", () => {
  it("G1: late entry is normal by the occurred clock and above the p90 by the recorded clock", () => {
    const r = g1(pools);
    show("G1 pools", { p90: r.non_f3_p90, f3: r.f3.map((x) => [x.occurred, x.recorded]) });
    expect(r.f3.length).toBe(4);
    expect(r.pass).toBe(true);
  });
  it("G2: the learned pair cuts 60 or more in every late-document case and under 10 in queue, entry, sign-off and insurer cases", () => {
    const r = g2(pools);
    show("G2 pools", r.cut_by_family);
    show("G2 pools after-order trigger", r.cut_by_family_after_order);
    expect(r.pass).toBe(true);
  });
  it("G3: a naive comparison of early-drafting and late-document histories overstates the matched effect by 15 or more", () => {
    const r = g3(pools.filter((c) => c.manifest.pool === "discovery"));
    show("G3 discovery", r);
    expect(r.applicable && r.pass).toBe(true);
  });
  it("G4: no case string carries a family name, a denied term or generator vocabulary", () => {
    const r = g4(pools);
    expect(r.hits).toEqual([]);
  });
  it("G5: every two-clock event obeys the rule in v1, learned and historical runs", () => {
    const r = g5(pools);
    show("G5 pools", { events: r.events, violations: r.violations.length });
    expect(r.violations).toEqual([]);
  });
});
