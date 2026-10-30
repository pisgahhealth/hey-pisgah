import { describe, expect, it } from "vitest";
import { Session } from "../src/session.js";
import { SWEEP_LIMITS } from "../src/sweep.js";
import { loadVariant } from "../src/variants.js";
import { tempRoot } from "./helpers.js";

describe("the neutral sweep", () => {
  it("runs every single and every pair of the named kinds over the scope, alike, and flags which cells delivered", () => {
    const v = loadVariant("pair");
    const s = new Session({ storeRoot: tempRoot(), runId: "run-5eeb0002", arm: "adaptive", base: v.base, pool: v.pool });
    const cases = ["c-491dbab0", "c-8c9cd194", "c-ed324a69", "c-11060afa"];
    const r = s.runSweep({ op_kinds: ["remove_soft_edge", "set_prep_trigger"], case_ids: cases, top_k: 3 });
    expect(r.ok).toBe(true);
    expect(r.pairs).toBe(((r.singles as number) * ((r.singles as number) - 1)) / 2);
    const best = r.best_by_wait as { ops: { op: string }[]; delivered: boolean; sum_wait_delta: number }[];
    expect(best[0]!.ops.map((o) => o.op).sort()).toEqual(["remove_soft_edge", "set_prep_trigger"]);
    expect(best[0]!.delivered).toBe(true);
    expect(best[0]!.sum_wait_delta).toBeLessThan(-100);
    expect(best.filter((b) => b.ops.length === 1).every((b) => b.sum_wait_delta === 0)).toBe(true);
    expect(s.counters.simulations).toBeGreaterThan(cases.length);
    s.close();
  });

  it("refuses a scope too large to sweep with the counts per kind, and stops after three sweeps", () => {
    const v = loadVariant("pair");
    const s = new Session({ storeRoot: tempRoot(), runId: "run-5eeb0003", arm: "adaptive", base: v.base, pool: v.pool });
    const big = s.runSweep({ op_kinds: ["remove_soft_edge", "add_soft_edge", "move_step_after", "set_prep_trigger", "add_condition", "rebind_section"], case_ids: ["c-491dbab0"], top_k: 5 });
    expect(big.error).toBe("sweep_size");
    expect(Object.keys(big.singles_per_kind as object).length).toBe(6);
    expect(JSON.stringify(s.runSweep({ op_kinds: ["remove_soft_edge"], case_ids: ["c-zz99zz99"] }))).toContain("unknown_id");
    for (let i = 0; i < SWEEP_LIMITS.sweeps; i++) expect(s.runSweep({ op_kinds: ["remove_soft_edge"], case_ids: ["c-491dbab0"], top_k: 3, pairs: false }).ok).toBe(true);
    expect(s.runSweep({ op_kinds: ["remove_soft_edge"], case_ids: ["c-491dbab0"], top_k: 3 }).error).toBe("budget_exhausted");
    s.close();
  });
});
