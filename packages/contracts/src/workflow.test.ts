import { describe, expect, it } from "vitest";
import { hashJson } from "./canonical.js";
import { Edge, SOFT_EDGE_NOTE, Trigger, WorkflowDefinition, countAtoms, fencesHash, type WorkflowDefinition as WD } from "./workflow.js";

const zero = "0".repeat(64);
const minimal = (): WD => ({
  workflow_id: "inpatient_discharge", version: 1, parent_version: null, definition_hash: zero, status: "adopted",
  scope: { wards: "all", condition: null }, fallback_version: null, actors: ["doctor", "nurse", "agent"],
  permissions: { clinical_discharge: ["doctor"], prepare_document: ["nurse", "agent"] },
  documents: [],
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
    fences_hash: zero, permissions_hash: zero, rules_hash: zero
  }
});

describe("workflow definition", () => {
  it("parses a minimal valid definition", () => {
    expect(WorkflowDefinition.safeParse(minimal()).success).toBe(true);
  });
  it("refuses a mutable fence", () => {
    const r = Edge.safeParse({ ...minimal().edges[0], immutable: false });
    expect(r.success).toBe(false);
  });
  it("refuses a platform-origin soft edge", () => {
    const r = Edge.safeParse({ ...minimal().edges[1], origin: "platform" });
    expect(r.success).toBe(false);
  });
  it("refuses a soft edge with a distinctive note", () => {
    const r = Edge.safeParse({ ...minimal().edges[1], note: "prepare the summary early" });
    expect(r.success).toBe(false);
  });
  it("refuses the agent on a clinical action", () => {
    const w = minimal();
    w.permissions = { ...w.permissions, clinical_discharge: ["doctor", "agent"] };
    expect(WorkflowDefinition.safeParse(w).success).toBe(false);
  });
  it("refuses a trigger on an external step", () => {
    const w = minimal();
    w.triggers = [{ target: { step: "st05" }, when: { on: "discharge.expected_recorded" }, condition: null }];
    expect(WorkflowDefinition.safeParse(w).success).toBe(false);
  });
  it("caps predicate depth and condition atoms", () => {
    const deep = { all_of: [{ any_of: [{ all_of: [{ on: "a.b" }] }] }] };
    expect(Trigger.safeParse({ target: { step: "st06" }, when: deep, condition: null }).success).toBe(false);
    const four = { all: [{ eq: ["ward_id", "A"] }, { eq: ["payer_type", "hmo"] }, { eq: ["has_take_home_order", true] }, { eq: ["signoff_recorded", true] }] } as const;
    expect(countAtoms(four)).toBe(4);
    expect(Trigger.safeParse({ target: { step: "st06" }, when: { on: "a.b" }, condition: four }).success).toBe(false);
  });
  it("fences_hash ignores soft edges", () => {
    const w = minimal();
    const before = fencesHash(w);
    w.edges = w.edges.filter((e) => e.kind === "fence");
    expect(fencesHash(w)).toBe(before);
    expect(before).not.toBe(hashJson([]));
  });
});
