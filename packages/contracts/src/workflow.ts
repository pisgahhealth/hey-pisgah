import { z } from "zod";
import { hashJson, type Json } from "./canonical.js";
import { EdgeId, Sha256, StepId, VersionNumber } from "./ids.js";

// Frozen (4.1): the executable workflow definition. Fences are immutable; only soft edges, triggers, conditions and section bindings may change.

export const ActorRole = z.enum([
  "doctor", "nurse", "pharmacist", "accounts_clerk", "claims_clerk", "authoriser", "ward_manager", "agent", "insurer", "sponsor"
]);
export type ActorRole = z.infer<typeof ActorRole>;

export const ActionKind = z.enum([
  "record_expected_discharge", "order_take_home", "amend_take_home", "pharmacy_review", "dispense", "resolve_screen",
  "clinical_discharge", "prepare_document", "revise_document", "request_check", "check_document", "submit_claim",
  "insurer_response", "receive_payment", "approve_waiver", "approve_on_account", "financial_clearance",
  "hand_over_document", "hand_over_take_home", "record_departure", "refund_deposit",
  "send_staff_message", "ask_staff", "apply_case_exception", "raise_workflow_conflict",
  "adopt_version", "suspend_version", "revert_version"
]);
export type ActionKind = z.infer<typeof ActionKind>;

// The agent may only ever appear on these kinds; a permissions table granting it anything else fails to parse.
export const AGENT_ALLOWED_KINDS: readonly ActionKind[] = [
  "prepare_document", "revise_document", "request_check", "send_staff_message", "ask_staff", "apply_case_exception", "raise_workflow_conflict"
];

export const DocumentId = z.enum([
  "discharge_summary", "stay_bill", "payment_receipt", "deposit_receipt", "refund_voucher", "clearance_slip",
  "hmo_claim_cover", "referral_letter", "sick_note"
]);
export type DocumentId = z.infer<typeof DocumentId>;

export const Stage = z.enum(["draft", "final"]);
export type Stage = z.infer<typeof Stage>;

export const RecordKind = z.enum([
  "admission_record", "expected_discharge", "take_home_order", "dispense_record", "signoff_record", "stay_bill",
  "payment", "waiver", "clearance", "ward_settings", "insurer_response"
]);
export type RecordKind = z.infer<typeof RecordKind>;

export const SourceRef = z.object({
  record_kind: RecordKind,
  field_path: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/),
  version_policy: z.literal("current")
});
export type SourceRef = z.infer<typeof SourceRef>;

export const Section = z.object({
  section_id: z.string().regex(/^[a-z_]+$/),
  binding: SourceRef,
  needed_for: Stage,
  free_text: z.literal(false)
});

export const DocumentTemplate = z.object({
  document_id: DocumentId,
  produced_by: StepId.nullable(),
  preparable_by: z.array(ActorRole),
  stages: z.tuple([z.literal("draft"), z.literal("final")]),
  sections: z.array(Section),
  check: z.object({ role: ActorRole, before: StepId }).nullable()
});
export type DocumentTemplate = z.infer<typeof DocumentTemplate>;

// Closed fact list for applicability conditions; no ids, times or seeds.
export const ConditionFact = z.enum([
  "ward_id", "ward_requires", "payer_type", "has_take_home_order", "take_home_status", "expected_discharge_recorded",
  "expected_disposition", "signoff_recorded", "final_bill_issued", "insurer_status", "payment_status"
]);
export type ConditionFact = z.infer<typeof ConditionFact>;

const Atom = z.union([
  z.object({ eq: z.tuple([ConditionFact, z.union([z.string(), z.boolean()])]) }),
  z.object({ in: z.tuple([ConditionFact, z.array(z.string()).min(1).max(6)]) })
]);
export type ConditionExpr =
  | z.infer<typeof Atom>
  | { not: ConditionExpr }
  | { all: ConditionExpr[] }
  | { any: ConditionExpr[] };
export const ConditionExpr: z.ZodType<ConditionExpr> = z.lazy(() =>
  z.union([Atom, z.object({ not: ConditionExpr }), z.object({ all: z.array(ConditionExpr).min(1) }), z.object({ any: z.array(ConditionExpr).min(1) })])
);

export function countAtoms(c: ConditionExpr): number {
  if ("eq" in c || "in" in c) return 1;
  if ("not" in c) return countAtoms(c.not);
  const list = "all" in c ? c.all : c.any;
  return list.reduce((n, x) => n + countAtoms(x), 0);
}
export const CONDITION_MAX_ATOMS = 3;

export const EventKind = z.string().regex(/^[a-z_]+\.[a-z_]+$/);
export const StepRef = z.object({ step: StepId, stage: Stage.optional() });
export type StepRef = z.infer<typeof StepRef>;

export type EventPredicate =
  | { on: string; where?: Record<string, string> | undefined }
  | { after: StepRef }
  | { all_of: EventPredicate[] }
  | { any_of: EventPredicate[] };
export const EventPredicate: z.ZodType<EventPredicate> = z.lazy(() =>
  z.union([
    z.object({ on: EventKind, where: z.record(z.string(), z.string()).optional() }),
    z.object({ after: StepRef }),
    z.object({ all_of: z.array(EventPredicate).min(1) }),
    z.object({ any_of: z.array(EventPredicate).min(1) })
  ])
);

export function predicateShape(p: EventPredicate): { depth: number; leaves: number } {
  if ("on" in p || "after" in p) return { depth: 0, leaves: 1 };
  const list = "all_of" in p ? p.all_of : p.any_of;
  const shapes = list.map(predicateShape);
  return { depth: 1 + Math.max(...shapes.map((s) => s.depth)), leaves: shapes.reduce((n, s) => n + s.leaves, 0) };
}
export const PREDICATE_MAX_DEPTH = 2;
export const PREDICATE_MAX_LEAVES = 4;

export const Step = z.object({
  step_id: StepId,
  action_kind: ActionKind,
  actor_roles: z.array(ActorRole).min(1),
  external: z.boolean(),
  document_ref: z.object({ document_id: DocumentId, stage: Stage }).nullable(),
  produces: z.array(RecordKind),
  consumes: z.array(SourceRef),
  clock: z.enum(["server", "two_clock"]),
  required_when: ConditionExpr.nullable()
});
export type Step = z.infer<typeof Step>;

export const EdgeOrigin = z.enum(["platform", "data_integrity", "permission", "ward_requirement", "ward_procedure", "learned"]);
const FENCE_ORIGINS = new Set<string>(["platform", "data_integrity", "permission", "ward_requirement"]);
export const SOFT_EDGE_NOTE = "Ward procedure ordering, v1";

export const Edge = z
  .object({
    edge_id: EdgeId,
    from: StepRef,
    to: StepRef,
    gate: z.enum(["start", "complete"]),
    kind: z.enum(["fence", "soft"]),
    origin: EdgeOrigin,
    immutable: z.boolean(),
    note: z.string()
  })
  .superRefine((e, ctx) => {
    if (e.kind === "fence" && !e.immutable) ctx.addIssue({ code: "custom", message: "a fence is always immutable" });
    if (FENCE_ORIGINS.has(e.origin) && e.kind !== "fence") ctx.addIssue({ code: "custom", message: `origin ${e.origin} implies kind fence` });
    if (e.kind === "soft" && e.note !== SOFT_EDGE_NOTE) ctx.addIssue({ code: "custom", message: "every soft edge carries the identical neutral note" });
  });
export type Edge = z.infer<typeof Edge>;

export const Trigger = z
  .object({ target: StepRef, when: EventPredicate, condition: ConditionExpr.nullable() })
  .superRefine((t, ctx) => {
    const s = predicateShape(t.when);
    if (s.depth > PREDICATE_MAX_DEPTH || s.leaves > PREDICATE_MAX_LEAVES) ctx.addIssue({ code: "custom", message: "predicate exceeds depth 2 or 4 leaves" });
    if (t.condition && countAtoms(t.condition) > CONDITION_MAX_ATOMS) ctx.addIssue({ code: "custom", message: "condition exceeds 3 atoms" });
  });
export type Trigger = z.infer<typeof Trigger>;

export const WorkflowStatus = z.enum(["draft", "proposed", "dev_validated", "dev_failed", "adopted", "suspended", "reverted", "rejected"]);

export const Clocks = z.object({ occurred_at: z.number().int(), recorded_at: z.number().int(), wall_at: z.string().datetime() });

export const VersionMetadata = z.object({
  author: z.object({ kind: z.enum(["human", "model_session"]), id: z.string() }),
  proposal_id: z.string().nullable(),
  change_ops: z.array(z.unknown()),
  source_evidence: z.object({ event_ids: z.array(z.string()), hypothesis_ids: z.array(z.string()), experiment_ids: z.array(z.string()), validation_report_id: z.string().nullable() }),
  approver: z.object({ staff_id: z.string(), role: z.literal("ward_manager"), display_name: z.string() }).nullable(),
  adopted_at: Clocks.nullable(),
  effective_from: z.number().int().nullable(),
  supersedes: VersionNumber.nullable(),
  suspended: z.object({ by: z.string(), reason: z.string(), at: Clocks }).nullable(),
  reverted: z.object({ by: z.string(), reason: z.string(), at: Clocks }).nullable(),
  model_provenance: z
    .object({ provider: z.string(), model_id: z.string(), mode: z.string(), endpoint: z.string(), request_ids: z.array(z.string()), prompt_hash: Sha256, tools_hash: Sha256, settings: z.record(z.string(), z.unknown()) })
    .nullable(),
  fences_hash: Sha256,
  permissions_hash: Sha256,
  rules_hash: Sha256
});

export const WorkflowDefinition = z
  .object({
    workflow_id: z.literal("inpatient_discharge"),
    version: VersionNumber,
    parent_version: VersionNumber.nullable(),
    definition_hash: Sha256,
    status: WorkflowStatus,
    scope: z.object({ wards: z.union([z.array(z.string()).min(1), z.literal("all")]), condition: ConditionExpr.nullable() }),
    fallback_version: VersionNumber.nullable(),
    actors: z.array(ActorRole),
    permissions: z.partialRecord(ActionKind, z.array(ActorRole)),
    documents: z.array(DocumentTemplate),
    steps: z.array(Step).min(1),
    edges: z.array(Edge),
    triggers: z.array(Trigger),
    metadata: VersionMetadata
  })
  .superRefine((w, ctx) => {
    for (const [kind, roles] of Object.entries(w.permissions)) {
      if (roles.includes("agent") && !AGENT_ALLOWED_KINDS.includes(kind as ActionKind)) {
        ctx.addIssue({ code: "custom", message: `agent may not hold ${kind}` });
      }
    }
    const steps = new Set(w.steps.map((s) => s.step_id));
    for (const e of w.edges) {
      if (!steps.has(e.from.step) || !steps.has(e.to.step)) ctx.addIssue({ code: "custom", message: `edge ${e.edge_id} names an unknown step` });
    }
    for (const t of w.triggers) {
      const target = w.steps.find((s) => s.step_id === t.target.step);
      if (!target) ctx.addIssue({ code: "custom", message: "trigger targets an unknown step" });
      else if (target.external) ctx.addIssue({ code: "custom", message: `trigger may not target external step ${target.step_id}` });
    }
    if (w.scope.condition && countAtoms(w.scope.condition) > CONDITION_MAX_ATOMS) ctx.addIssue({ code: "custom", message: "scope condition exceeds 3 atoms" });
  });
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

// The three hashes the model can never change: fences, permissions and the simulator rules.
export function fencesHash(w: Pick<WorkflowDefinition, "edges">): string {
  const fences = w.edges.filter((e) => e.kind === "fence").map((e) => ({ edge_id: e.edge_id, from: e.from, to: e.to, gate: e.gate, origin: e.origin }));
  return hashJson(fences as unknown as Json);
}
export function permissionsHash(w: Pick<WorkflowDefinition, "permissions">): string {
  return hashJson(w.permissions as unknown as Json);
}
export function definitionHash(w: Omit<WorkflowDefinition, "definition_hash" | "metadata" | "status">): string {
  const { ...body } = w;
  return hashJson(body as unknown as Json);
}
