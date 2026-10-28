import { describe, expect, it } from "vitest";
import { hashJson } from "./canonical.js";
import { ConditionExpr, Edge, SOFT_EDGE_NOTE, Trigger, WorkflowDefinition, countAtoms, definitionHash, fencesHash, permissionsHash, structureHash, type WorkflowDefinition as WD } from "./workflow.js";

const zero = "0".repeat(64);
const minimal = (): WD => ({
  workflow_id: "inpatient_discharge", version: 1, parent_version: null, definition_hash: zero, status: "adopted",
  scope: { wards: "all", condition: null }, fallback_version: null, actors: ["doctor", "nurse", "agent"],
  permissions: { clinical_discharge: ["doctor"], prepare_document: ["nurse", "agent"] },
  documents: [{ document_id: "discharge_summary", produced_by: null, preparable_by: ["nurse", "agent"], stages: ["draft", "final"], sections: [], check: { role: "nurse", before: "st14" } }],
  steps: [
    { step_id: "st05", action_kind: "clinical_discharge", actor_roles: ["doctor"], external: true, document_ref: null, produces: ["signoff_record"], consumes: [], clock: "server", required_when: null },
    { step_id: "st06", action_kind: "prepare_document", actor_roles: ["nurse", "agent"], external: false, document_ref: { document_id: "discharge_summary", stage: "draft" }, produces: [], consumes: [], clock: "server", required_when: null }
  ],
  edges: [
    { edge_id: "e01", from: { step: "st05" }, to: { step: "st06" }, gate: "start", kind: "fence", origin: "platform", immutable: true, note: "platform" },
    { edge_id: "e04", from: { step: "st05" }, to: { step: "st06", stage: "draft" }, gate: "start", kind: "soft", origin: "ward_procedure", immutable: false, note: SOFT_EDGE_NOTE }
  ],
  triggers: [{ target: { step: "st06", stage: "draft" }, when: { after: { step: "st05" } }, condition: null }],
  metadata: {
    author: { kind: "human", id: "seed" }, proposal_id: null, change_ops: [], source_evidence: { event_ids: [], hypothesis_ids: [], experiment_ids: [], validation_report_id: null },
    approver: null, adopted_at: null, effective_from: null, supersedes: null, suspended: null, reverted: null, model_provenance: null,
    fences_hash: zero, permissions_hash: zero, structure_hash: zero, rules_hash: zero
  }
});

describe("workflow definition", () => {
  it("parses a minimal valid definition", () => {
    const r = WorkflowDefinition.safeParse(minimal());
    expect(r.success, JSON.stringify(r.success ? null : r.error.issues)).toBe(true);
  });
  it("refuses a fence marked mutable and a soft edge marked immutable", () => {
    expect(Edge.safeParse({ ...minimal().edges[0], immutable: false }).success).toBe(false);
    expect(Edge.safeParse({ ...minimal().edges[1], immutable: true }).success).toBe(false);
  });
  it("ties kind to origin", () => {
    expect(Edge.safeParse({ ...minimal().edges[1], origin: "platform" }).success).toBe(false);
    expect(Edge.safeParse({ ...minimal().edges[0], origin: "learned" }).success).toBe(false);
  });
  it("refuses a soft edge with a distinctive note", () => {
    expect(Edge.safeParse({ ...minimal().edges[1], note: "prepare the summary early" }).success).toBe(false);
  });
  it("refuses the agent on a clinical action, in permissions and on a step", () => {
    const a = minimal(); a.permissions = { ...a.permissions, clinical_discharge: ["doctor", "agent"] };
    expect(WorkflowDefinition.safeParse(a).success).toBe(false);
    const b = minimal(); b.steps[0]!.actor_roles = ["doctor", "agent"];
    expect(WorkflowDefinition.safeParse(b).success).toBe(false);
  });
  it("refuses a step actor without permission and a duplicate id", () => {
    const a = minimal(); a.steps[1]!.actor_roles = ["pharmacist"];
    expect(WorkflowDefinition.safeParse(a).success).toBe(false);
    const b = minimal(); b.steps.push({ ...b.steps[1]! });
    expect(WorkflowDefinition.safeParse(b).success).toBe(false);
  });
  it("refuses a trigger on an external step", () => {
    const w = minimal(); w.triggers = [{ target: { step: "st05" }, when: { on: "discharge.expected_recorded" }, condition: null }];
    expect(WorkflowDefinition.safeParse(w).success).toBe(false);
  });
  it("refuses unknown keys instead of stripping them", () => {
    expect(ConditionExpr.safeParse({ fact: "payer_type", eq: "hmo", all: [] }).success).toBe(false);
    expect(ConditionExpr.safeParse({ on: "a.b", after: { step: "st05" } }).success).toBe(false);
  });
  it("checks condition values against the fact", () => {
    expect(ConditionExpr.safeParse({ fact: "payer_type", eq: "hmo" }).success).toBe(true);
    expect(ConditionExpr.safeParse({ fact: "payer_type", eq: "hmo " }).success).toBe(false);
    expect(ConditionExpr.safeParse({ fact: "ward_requires", eq: "discharge_summary" }).success).toBe(true);
    expect(ConditionExpr.safeParse({ fact: "ward_requires", eq: "x" }).success).toBe(false);
  });
  it("caps predicate depth and condition atoms everywhere a condition appears", () => {
    const deep = { all_of: [{ any_of: [{ all_of: [{ on: "a.b" }] }] }] };
    expect(Trigger.safeParse({ target: { step: "st06" }, when: deep, condition: null }).success).toBe(false);
    const four = { all: [{ fact: "ward_id", eq: "A" }, { fact: "payer_type", eq: "hmo" }, { fact: "has_take_home_order", eq: "true" }, { fact: "signoff_recorded", eq: "true" }] } as const;
    expect(countAtoms(four)).toBe(4);
    expect(Trigger.safeParse({ target: { step: "st06" }, when: { on: "a.b" }, condition: four }).success).toBe(false);
    const w = minimal(); w.steps[1]!.required_when = four;
    expect(WorkflowDefinition.safeParse(w).success).toBe(false);
  });
  it("hashes are order independent and cover only what must be immutable", () => {
    const w = minimal();
    const f = fencesHash(w), p = permissionsHash(w), s = structureHash(w);
    w.edges = w.edges.filter((e) => e.kind === "fence");
    expect(fencesHash(w)).toBe(f);
    expect(f).not.toBe(hashJson([]));
    w.permissions = { prepare_document: ["agent", "nurse"], clinical_discharge: ["doctor"] };
    expect(permissionsHash(w)).toBe(p);
    w.steps[1]!.required_when = { fact: "payer_type", eq: "hmo" };
    expect(structureHash(w)).toBe(s);
    w.steps[1]!.external = true;
    expect(structureHash(w)).not.toBe(s);
  });
  it("definition hash ignores status, metadata and version numbers", () => {
    const a = minimal(); const b = { ...minimal(), status: "suspended" as const, version: 7, definition_hash: "f".repeat(64) };
    expect(definitionHash(a)).toBe(definitionHash(b));
  });
});
