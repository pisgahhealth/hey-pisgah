import {
  SOFT_EDGE_NOTE, WorkflowDefinition, definitionHash, fencesHash, permissionsHash, structureHash,
  type ActionKind, type ActorRole, type ConditionExpr, type Edge, type RecordKind, type Step, type WorkflowDefinition as WD
} from "@hey-pisgah/contracts";

// A test-only discharge-shaped definition; the real v1 lives in the hospital package.
const zero = "0".repeat(64);
type S = Partial<Step> & Pick<Step, "step_id" | "action_kind" | "actor_roles">;
const step = (s: S): Step => ({ external: false, document_ref: null, produces: [], consumes: [], clock: "server", required_when: null, alternative_group: null, ...s });
const fence = (edge_id: string, from: string, to: string, origin: Edge["origin"] = "platform", gate: Edge["gate"] = "start"): Edge =>
  ({ edge_id, from: { step: from }, to: { step: to }, gate, kind: "fence", origin, immutable: true, note: "Platform rule" });
const soft = (edge_id: string, from: string, to: string): Edge =>
  ({ edge_id, from: { step: from }, to: { step: to }, gate: "start", kind: "soft", origin: "ward_procedure", immutable: false, note: SOFT_EDGE_NOTE });
const sec = (section_id: string, record_kind: RecordKind, field_path: string, needed_for: "draft" | "final") =>
  ({ section_id, binding: { record_kind, field_path, version_policy: "current" as const }, needed_for, free_text: false as const });

const takeHome: ConditionExpr = { fact: "has_take_home_order", eq: "true" };
const hmo: ConditionExpr = { fact: "payer_type", eq: "hmo" };
const needsSummary: ConditionExpr = { fact: "ward_requires", eq: "discharge_summary" };

const permissions: Partial<Record<ActionKind, ActorRole[]>> = {
  record_expected_discharge: ["doctor"], order_take_home: ["doctor"], pharmacy_review: ["pharmacist"], dispense: ["pharmacist"],
  clinical_discharge: ["doctor"], prepare_document: ["nurse", "agent", "claims_clerk"], revise_document: ["nurse", "agent", "claims_clerk"],
  check_document: ["nurse"], submit_claim: ["claims_clerk"], insurer_response: ["insurer"], receive_payment: ["accounts_clerk"],
  approve_waiver: ["authoriser"], financial_clearance: ["accounts_clerk"], hand_over_document: ["nurse"], hand_over_take_home: ["nurse"],
  record_departure: ["nurse"], adopt_version: ["ward_manager"]
};

export function fixtureDefinition(): WD {
  const def: WD = {
    workflow_id: "inpatient_discharge", version: 1, parent_version: null, definition_hash: zero, status: "adopted",
    scope: { wards: "all", condition: null }, fallback_version: null,
    actors: ["doctor", "nurse", "pharmacist", "accounts_clerk", "claims_clerk", "authoriser", "ward_manager", "agent", "insurer"],
    permissions,
    documents: [
      { document_id: "discharge_summary", produced_by: null, preparable_by: ["nurse", "agent"], stages: ["draft", "final"],
        sections: [sec("patient_and_stay", "admission_record", "patient", "draft"), sec("medicines", "take_home_order", "items", "draft"),
          sec("follow_up", "signoff_record", "follow_up", "final"), sec("ward_contact", "ward_settings", "contact", "draft")],
        check: { role: "nurse", before: "st14" } },
      { document_id: "hmo_claim_cover", produced_by: null, preparable_by: ["claims_clerk", "agent"], stages: ["draft", "final"],
        sections: [sec("charges", "stay_bill", "total", "final"), sec("patient", "admission_record", "patient", "draft")], check: null },
      { document_id: "stay_bill", produced_by: "st05", preparable_by: [], stages: ["draft", "final"], sections: [], check: null }
    ],
    steps: [
      step({ step_id: "st01", action_kind: "record_expected_discharge", actor_roles: ["doctor"], external: true, produces: ["expected_discharge"], clock: "two_clock" }),
      step({ step_id: "st02", action_kind: "order_take_home", actor_roles: ["doctor"], external: true, produces: ["take_home_order"], required_when: takeHome }),
      step({ step_id: "st03", action_kind: "pharmacy_review", actor_roles: ["pharmacist"], required_when: takeHome }),
      step({ step_id: "st04", action_kind: "dispense", actor_roles: ["pharmacist"], produces: ["dispense_record"], required_when: takeHome }),
      step({ step_id: "st05", action_kind: "clinical_discharge", actor_roles: ["doctor"], external: true, produces: ["signoff_record", "stay_bill"] }),
      step({ step_id: "st06", action_kind: "prepare_document", actor_roles: ["nurse", "agent"], document_ref: { document_id: "discharge_summary", stage: "draft" }, required_when: needsSummary }),
      step({ step_id: "st07", action_kind: "prepare_document", actor_roles: ["nurse", "agent"], document_ref: { document_id: "discharge_summary", stage: "final" }, required_when: needsSummary }),
      step({ step_id: "st08", action_kind: "check_document", actor_roles: ["nurse"], document_ref: { document_id: "discharge_summary", stage: "final" }, required_when: needsSummary }),
      step({ step_id: "st09a", action_kind: "prepare_document", actor_roles: ["claims_clerk", "agent"], document_ref: { document_id: "hmo_claim_cover", stage: "draft" }, required_when: hmo }),
      step({ step_id: "st09b", action_kind: "prepare_document", actor_roles: ["claims_clerk", "agent"], document_ref: { document_id: "hmo_claim_cover", stage: "final" }, required_when: hmo }),
      step({ step_id: "st10", action_kind: "submit_claim", actor_roles: ["claims_clerk"], required_when: hmo }),
      step({ step_id: "st11", action_kind: "insurer_response", actor_roles: ["insurer"], external: true, produces: ["insurer_response"], required_when: hmo }),
      step({ step_id: "st12a", action_kind: "receive_payment", actor_roles: ["accounts_clerk"], produces: ["payment"], alternative_group: "settle" }),
      step({ step_id: "st12b", action_kind: "approve_waiver", actor_roles: ["authoriser"], produces: ["waiver"], alternative_group: "settle" }),
      step({ step_id: "st13", action_kind: "financial_clearance", actor_roles: ["accounts_clerk"], produces: ["clearance"] }),
      step({ step_id: "st14", action_kind: "hand_over_document", actor_roles: ["nurse"], document_ref: { document_id: "discharge_summary", stage: "final" }, required_when: needsSummary, clock: "two_clock" }),
      step({ step_id: "st15", action_kind: "hand_over_take_home", actor_roles: ["nurse"], required_when: takeHome }),
      step({ step_id: "st16", action_kind: "record_departure", actor_roles: ["nurse"], clock: "two_clock" })
    ],
    edges: [
      fence("e01", "st01", "st05"), fence("e02", "st02", "st03"), fence("e03", "st03", "st04"),
      soft("e04", "st05", "st06"), soft("e05", "st15", "st14"), soft("e06", "st07", "st09a"),
      fence("e08", "st06", "st07"), fence("e09", "st07", "st08"), fence("e10", "st08", "st14", "ward_requirement"),
      fence("e11", "st05", "st10"), fence("e12", "st09b", "st10"), fence("e13", "st10", "st11"),
      fence("e14", "st05", "st12a"), fence("e15", "st05", "st12b"), fence("e16", "st12a", "st13"), fence("e17", "st11", "st13"),
      fence("e18", "st13", "st16"), fence("e19", "st14", "st16", "ward_requirement"), fence("e20", "st15", "st16", "ward_requirement"),
      fence("e21", "st04", "st15"), fence("e22", "st09a", "st09b"), fence("e23", "st01", "st06")
    ],
    triggers: [
      { target: { step: "st06", stage: "draft" }, when: { after: { step: "st01" } }, condition: null },
      { target: { step: "st09a", stage: "draft" }, when: { after: { step: "st01" } }, condition: null }
    ],
    metadata: {
      author: { kind: "human", id: "fixture" }, proposal_id: null, change_ops: [],
      source_evidence: { event_ids: [], hypothesis_ids: [], experiment_ids: [], validation_report_id: null },
      approver: null, adopted_at: null, effective_from: null, supersedes: null, suspended: null, reverted: null, model_provenance: null,
      fences_hash: zero, permissions_hash: zero, structure_hash: zero, rules_hash: zero
    }
  };
  def.definition_hash = definitionHash(def);
  def.metadata.fences_hash = fencesHash(def);
  def.metadata.permissions_hash = permissionsHash(def);
  def.metadata.structure_hash = structureHash(def);
  return WorkflowDefinition.parse(def) as WD;
}

// Small seeded generator for tests; mulberry32 over a 32-bit seed.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
