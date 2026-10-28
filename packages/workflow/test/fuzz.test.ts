import { WorkflowDefinition, fencesHash, permissionsHash } from "@hey-pisgah/contracts";
import { describe, expect, it } from "vitest";
import { allPrecedences, applyOperations, findCycle } from "../src/index.js";
import { fixtureDefinition, rng } from "./fixture.js";
import { randomOp } from "./random-op.js";

describe("operation fuzz", () => {
  it("200 random valid sequences never change fences or permissions and never produce a cycle", () => {
    const base = fixtureDefinition();
    const fh = fencesHash(base), ph = permissionsHash(base);
    const r = rng(20261028);
    let current = base, accepted = 0, refused = 0;
    for (let i = 0; accepted < 200 && i < 5000; i++) {
      const ops = Array.from({ length: 1 + Math.floor(r() * 3) }, () => randomOp(r, current));
      const res = applyOperations(current, ops);
      if (!res.ok) { refused += 1; continue; }
      accepted += 1;
      const d = res.definition;
      expect(fencesHash(d)).toBe(fh);
      expect(permissionsHash(d)).toBe(ph);
      expect(findCycle(allPrecedences(d))).toBeNull();
      expect(WorkflowDefinition.safeParse(d).success).toBe(true);
      current = r() < 0.3 ? base : d;
    }
    expect(accepted).toBe(200);
    expect(refused).toBeGreaterThan(20);
  });
});
