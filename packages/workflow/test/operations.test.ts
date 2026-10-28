import { definitionHash, fencesHash, permissionsHash, structureHash, type Operation } from "@hey-pisgah/contracts";
import { describe, expect, it } from "vitest";
import { applyOperations, deriveDataIntegrityFences } from "../src/index.js";
import { fixtureDefinition } from "./fixture.js";

const base = fixtureDefinition();
const ok = (ops: Operation[]) => {
  const r = applyOperations(base, ops);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};
const err = (ops: unknown[], opts = {}) => {
  const r = applyOperations(base, ops, opts);
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.errors.map((e) => e.code);
};

const examples: Operation[] = [
  { op: "remove_soft_edge", edge_id: "e04" },
  { op: "add_soft_edge", from: { step: "st05" }, to: { step: "st07", stage: "final" }, gate: "start" },
  { op: "move_step_after", step: { step: "st06" }, after: { step: "st02" }, gate: "start" },
  { op: "set_prep_trigger", target: { step: "st06" }, when: { on: "step.completed", where: { step_id: "st02" } } },
  { op: "add_condition", target: { step: { step: "st06" } }, condition: { fact: "payer_type", eq: "self_pay" } },
  { op: "rebind_section", document_id: "discharge_summary", section_id: "medicines", source: { record_kind: "dispense_record", field_path: "items", version_policy: "current" } }
];

describe("applyOperations", () => {
  it.each(examples.map((o) => [o.op, o] as const))("%s leaves fences, permissions and structure unchanged", (_n, op) => {
    const r = ok([op]);
    expect(r.noop).toBe(false);
    expect(fencesHash(r.definition)).toBe(fencesHash(base));
    expect(permissionsHash(r.definition)).toBe(permissionsHash(base));
    expect(structureHash(r.definition)).toBe(structureHash(base));
    expect(r.definition.definition_hash).toBe(definitionHash(r.definition));
    expect(r.definition.definition_hash).not.toBe(base.definition_hash);
  });

  it("refuses to remove a fence and names an unknown edge", () => {
    expect(err([{ op: "remove_soft_edge", edge_id: "e01" }])).toEqual(["bad_target"]);
    expect(err([{ op: "remove_soft_edge", edge_id: "e77" }])).toEqual(["unknown_id"]);
  });

  it("refuses targets that are external or not preparable", () => {
    expect(err([{ op: "add_soft_edge", from: { step: "st06" }, to: { step: "st05" }, gate: "start" }])).toEqual(["bad_target"]);
    expect(err([{ op: "add_condition", target: { step: { step: "st13" } }, condition: { fact: "payer_type", eq: "hmo" } }])).toEqual(["bad_target"]);
    expect(err([{ op: "set_prep_trigger", target: { step: "st08" }, when: { after: { step: "st07" } } }])).toEqual(["bad_target"]);
  });

  it("refuses cycles through stored, derived and trigger-implied edges", () => {
    expect(err([{ op: "add_soft_edge", from: { step: "st07" }, to: { step: "st06" }, gate: "start" }])).toEqual(["cycle"]);
    expect(err([{ op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st14" } } }])).toEqual(["cycle"]);
    expect(err([{ op: "set_prep_trigger", target: { step: "st06" }, when: { on: "step.completed", where: { step_id: "st08" } } }])).toEqual(["cycle"]);
  });

  it("refuses unknown event kinds and unknown steps inside predicates", () => {
    expect(err([{ op: "set_prep_trigger", target: { step: "st06" }, when: { on: "discharge.anything" } }])).toEqual(["unknown_id"]);
    expect(err([{ op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st99" } } }])).toEqual(["unknown_id"]);
  });

  it("caps combined conditions and refuses a schema-invalid operation", () => {
    const three = { all: [{ fact: "payer_type", eq: "hmo" }, { fact: "ward_id", eq: "A" }, { fact: "signoff_recorded", eq: "true" }] };
    expect(err([{ op: "add_condition", target: { step: { step: "st06" } }, condition: three }])).toEqual(["grammar_cap"]);
    expect(err([{ op: "remove_soft_edge", edge_id: "x" }])).toEqual(["schema"]);
  });

  it("refuses more than three operations unless a transformer lifts the cap", () => {
    const four: Operation[] = [examples[0]!, examples[1]!, examples[3]!, examples[5]!];
    expect(err(four)).toEqual(["too_many_ops"]);
    expect(applyOperations(base, four, { maxOps: 10 }).ok).toBe(true);
  });

  it("refuses a condition that holds for exactly one case in the pool", () => {
    const pool = [{ payer_type: "hmo" }, { payer_type: "self_pay" }, { payer_type: "self_pay" }];
    const op = { op: "add_condition", target: "scope", condition: { fact: "payer_type", eq: "hmo" } };
    expect(err([op], { caseFacts: pool })).toEqual(["single_case_condition"]);
    expect(applyOperations(base, [op], { caseFacts: [...pool, { payer_type: "hmo" }] }).ok).toBe(true);
  });

  it("adds a condition to the triggers on a step and refuses a step with none", () => {
    const r = ok([{ op: "add_condition", target: { trigger: { step: "st06" } }, condition: { fact: "payer_type", eq: "self_pay" } }]);
    expect(r.definition.triggers.find((t) => t.target.step === "st06")?.condition).toEqual({ fact: "payer_type", eq: "self_pay" });
    expect(err([{ op: "add_condition", target: { trigger: { step: "st07" } }, condition: { fact: "payer_type", eq: "hmo" } }])).toEqual(["unknown_id"]);
  });

  it("move_step_after replaces the soft edges into the step with one learned edge", () => {
    const r = ok([examples[2]!]);
    const into = r.definition.edges.filter((e) => e.to.step === "st06" && e.kind === "soft");
    expect(into).toHaveLength(1);
    expect(into[0]).toMatchObject({ from: { step: "st02" }, origin: "learned", edge_id: "e24" });
  });

  it("rebind_section moves the derived fence while the stored fences hash stays put", () => {
    const before = deriveDataIntegrityFences(base).filter((d) => d.to.step === "st06").map((d) => d.from.step);
    const r = ok([examples[5]!]);
    const after = r.derived.filter((d) => d.to.step === "st06").map((d) => d.from.step);
    expect(before).toContain("st02");
    expect(after).toContain("st04");
    expect(after).not.toContain("st02");
    expect(r.definition.edges.some((e) => (e.origin as string) === "data_integrity")).toBe(false);
  });

  it("refuses a source no step produces and the base never bound", () => {
    const d = fixtureDefinition();
    d.steps.find((s) => s.step_id === "st11")!.produces = [];
    const r = applyOperations(d, [{ op: "rebind_section", document_id: "discharge_summary", section_id: "medicines", source: { record_kind: "insurer_response", field_path: "x", version_policy: "current" } }]);
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toEqual(["bad_target"]);
  });

  it("a no-op warns and returns the unchanged definition", () => {
    const r = applyOperations(base, [{ op: "add_soft_edge", from: { step: "st05" }, to: { step: "st06" }, gate: "start" }]);
    expect(r.ok && r.noop).toBe(true);
    if (!r.ok) return;
    expect(r.definition).toEqual(base);
    expect(r.warnings.map((w) => w.code)).toContain("no_op");
  });

  it("never mutates its input", () => {
    const copy = structuredClone(base);
    applyOperations(base, examples.slice(0, 3));
    expect(base).toEqual(copy);
  });
});
