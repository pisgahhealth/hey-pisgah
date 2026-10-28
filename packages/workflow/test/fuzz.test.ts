import { RecordKind, WorkflowDefinition, fencesHash, permissionsHash, type Operation, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { describe, expect, it } from "vitest";
import { allPrecedences, applyOperations, findCycle } from "../src/index.js";
import { fixtureDefinition, rng } from "./fixture.js";

// Draws one operation over the current definition, valid by schema but not always by the rules.
export function randomOp(r: () => number, d: WD): Operation {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const steps = d.steps.map((s) => s.step_id);
  const prep = d.steps.filter((s) => s.action_kind === "prepare_document" && !s.external).map((s) => s.step_id);
  const facts = [{ fact: "payer_type", eq: pick(["hmo", "self_pay", "corporate"]) }, { fact: "ward_id", eq: pick(["A", "B", "C"]) }, { fact: "has_take_home_order", eq: pick(["true", "false"]) }] as const;
  switch (Math.floor(r() * 6)) {
    case 0: return { op: "remove_soft_edge", edge_id: pick(d.edges.map((e) => e.edge_id)) };
    case 1: return { op: "add_soft_edge", from: { step: pick(steps) }, to: { step: r() < 0.8 ? pick(prep) : pick(steps) }, gate: pick(["start", "complete"] as const) };
    case 2: return { op: "move_step_after", step: { step: pick(prep) }, after: { step: pick(steps) }, gate: pick(["start", "complete"] as const) };
    case 3: return {
      op: "set_prep_trigger", target: { step: pick(prep) },
      when: r() < 0.5 ? { after: { step: pick(steps) } } : { any_of: [{ on: "step.completed", where: { step_id: pick(steps) } }, { after: { step: pick(steps) } }] }
    };
    case 4: return { op: "add_condition", target: r() < 0.2 ? "scope" : r() < 0.5 ? { trigger: { step: pick(prep) } } : { step: { step: pick(prep) } }, condition: { ...pick(facts) } };
    default: {
      const doc = pick(d.documents.filter((x) => x.sections.length > 0));
      return { op: "rebind_section", document_id: doc.document_id, section_id: pick(doc.sections).section_id, source: { record_kind: pick(RecordKind.options), field_path: "value", version_policy: "current" } };
    }
  }
}

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
