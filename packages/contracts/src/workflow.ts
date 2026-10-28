import { z } from "zod";
import { hashJson } from "./canonical.js";
import { EdgeId, IsoDateTime, Sha256, StepId, VersionNumber } from "./ids.js";

// Frozen (4.1): the executable workflow definition. Fences, permissions and step structure are immutable; only soft edges, triggers, conditions and section bindings may change.

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

// The agent may only ever hold these kinds, on a permission row or a step; anything else fails to parse.
export const AGENT_ALLOWED_KINDS: ReadonlySet<ActionKind> = Object.freeze(new Set<ActionKind>([
  "prepare_document", "revise_document", "request_check", "send_staff_message", "ask_staff", "apply_case_exception", "raise_workflow_conflict"
]));

export const DocumentId = z.enum([
  "discharge_summary", "stay_bill", "payment_receipt", "deposit_receipt", "refund_voucher", "clearance_slip",
  "hmo_claim_cover", "referral_letter", "sick_note"
]);
export type DocumentId = z.infer<typeof DocumentId>;
export const SectionId = z.string().regex(/^[a-z_]+$/);
export const Stage = z.enum(["draft", "final"]);
export type Stage = z.infer<typeof Stage>;

export const RecordKind = z.enum([
  "admission_record", "expected_discharge", "take_home_order", "dispense_record", "signoff_record", "stay_bill",
  "payment", "waiver", "clearance", "ward_settings", "insurer_response"
]);
export type RecordKind = z.infer<typeof RecordKind>;

export const SourceRef = z.strictObject({
  record_kind: RecordKind,
  field_path: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/),
  version_policy: z.literal("current")
});
export type SourceRef = z.infer<typeof SourceRef>;

export const Section = z.strictObject({ section_id: SectionId, binding: SourceRef, needed_for: Stage, free_text: z.literal(false) });

export const DocumentTemplate = z.strictObject({
  document_id: DocumentId,
  produced_by: StepId.nullable(),
  preparable_by: z.array(ActorRole),
  stages: z.tuple([z.literal("draft"), z.literal("final")]),
  sections: z.array(Section),
  check: z.strictObject({ role: ActorRole, before: StepId }).nullable()
}).refine((d) => d.check === null || d.check.role !== "agent", { message: "the agent never checks a document" });
export type DocumentTemplate = z.infer<typeof DocumentTemplate>;

// Closed fact list for applicability conditions with the values each fact may take; no ids, times or seeds.
export const FACT_VALUES = Object.freeze({
  ward_id: /^[A-Z][A-Za-z0-9_]*$/,
  ward_requires: DocumentId.options,
  payer_type: ["self_pay", "hmo", "corporate"],
  has_take_home_order: ["true", "false"],
  take_home_status: ["none", "ordered", "reviewed", "dispensed", "cancelled"],
  expected_discharge_recorded: ["true", "false"],
  expected_disposition: ["home", "transfer_out", "other"],
  signoff_recorded: ["true", "false"],
  final_bill_issued: ["true", "false"],
  insurer_status: ["none", "submitted", "responded"],
  payment_status: ["unpaid", "paid", "waived", "on_account"]
} as const);
export const ConditionFact = z.enum(Object.keys(FACT_VALUES) as [keyof typeof FACT_VALUES, ...(keyof typeof FACT_VALUES)[]]);
export type ConditionFact = z.infer<typeof ConditionFact>;

function validValue(fact: ConditionFact, v: string): boolean {
  const allowed = FACT_VALUES[fact];
  return allowed instanceof RegExp ? allowed.test(v) : (allowed as readonly string[]).includes(v);
}

// An atom is one of two shapes so a strict tool schema can express it; for ward_requires, eq means "the ward requires this document".
const Atom = z.union([
  z.strictObject({ fact: ConditionFact, eq: z.string() }).refine((a) => validValue(a.fact, a.eq), { message: "value is not allowed for this fact" }),
  z.strictObject({ fact: ConditionFact, in: z.array(z.string()).min(1).max(6) }).refine((a) => a.in.every((v) => validValue(a.fact, v)), { message: "a value is not allowed for this fact" })
]);
export type Atom = z.infer<typeof Atom>;
export type ConditionExpr = Atom | { not: ConditionExpr } | { all: ConditionExpr[] } | { any: ConditionExpr[] };
export const ConditionExpr: z.ZodType<ConditionExpr> = z.lazy(() =>
  z.union([Atom, z.strictObject({ not: ConditionExpr }), z.strictObject({ all: z.array(ConditionExpr).min(1) }), z.strictObject({ any: z.array(ConditionExpr).min(1) })])
);

export function countAtoms(c: ConditionExpr): number {
  if ("fact" in c) return 1;
  if ("not" in c) return countAtoms(c.not);
  const list = "all" in c ? c.all : c.any;
  return list.reduce((n, x) => n + countAtoms(x), 0);
}
export const CONDITION_MAX_ATOMS = 3;
export const CappedCondition = ConditionExpr.refine((c) => countAtoms(c) <= CONDITION_MAX_ATOMS, { message: "condition exceeds 3 atoms" });

export const EventKind = z.string().regex(/^[a-z_]+\.[a-z_]+$/);
export const StepRef = z.strictObject({ step: StepId, stage: Stage.optional() });
export type StepRef = z.infer<typeof StepRef>;

export type EventPredicate =
  | { on: string; where?: Record<string, string> | undefined }
  | { after: StepRef }
  | { all_of: EventPredicate[] }
  | { any_of: EventPredicate[] };
export const EventPredicate: z.ZodType<EventPredicate> = z.lazy(() =>
  z.union([
    z.strictObject({ on: EventKind, where: z.record(z.string(), z.string()).optional() }),
    z.strictObject({ after: StepRef }),
    z.strictObject({ all_of: z.array(EventPredicate).min(1) }),
    z.strictObject({ any_of: z.array(EventPredicate).min(1) })
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
export const CappedPredicate = EventPredicate.refine((p) => { const s = predicateShape(p); return s.depth <= PREDICATE_MAX_DEPTH && s.leaves <= PREDICATE_MAX_LEAVES; }, { message: "predicate exceeds depth 2 or 4 leaves" });

// One step has one action kind and at most one document stage; a hospital step with several kinds splits into st12a, st12b and so on.
export const Step = z.strictObject({
  step_id: StepId,
  action_kind: ActionKind,
  actor_roles: z.array(ActorRole).min(1),
  external: z.boolean(),
  document_ref: z.strictObject({ document_id: DocumentId, stage: Stage }).nullable(),
  produces: z.array(RecordKind),
  consumes: z.array(SourceRef),
  clock: z.enum(["server", "two_clock"]),
  required_when: CappedCondition.nullable(),
  alternative_group: z.string().regex(/^[a-z_]+$/).nullable()
});
export type Step = z.infer<typeof Step>;
// Alternatives rule: steps sharing an alternative_group are mutually exclusive ways of reaching the same state (payment, waiver, on-account). An edge whose from-step is in a group is satisfied when any member of the group completes, and a trigger on a group member fires only for the member the schedule selects, so three fences into clearance never deadlock.

// Stored edges are platform, permission, ward_requirement (fences) or ward_procedure, learned (soft); data_integrity fences are derived from bindings at load time and never stored.
export const StoredEdgeOrigin = z.enum(["platform", "permission", "ward_requirement", "ward_procedure", "learned"]);
export const EdgeOrigin = z.enum([...StoredEdgeOrigin.options, "data_integrity"]);
export const SOFT_ORIGINS: ReadonlySet<string> = new Set(["ward_procedure", "learned"]);
export const SOFT_EDGE_NOTE = "Ward procedure ordering";

export const Edge = z
  .strictObject({
    edge_id: EdgeId,
    from: StepRef,
    to: StepRef,
    gate: z.enum(["start", "complete"]),
    kind: z.enum(["fence", "soft"]),
    origin: StoredEdgeOrigin,
    immutable: z.boolean(),
    note: z.string()
  })
  .superRefine((e, ctx) => {
    const soft = SOFT_ORIGINS.has(e.origin);
    if (soft !== (e.kind === "soft")) ctx.addIssue({ code: "custom", message: `origin ${e.origin} implies kind ${soft ? "soft" : "fence"}` });
    if (e.immutable !== (e.kind === "fence")) ctx.addIssue({ code: "custom", message: "immutable equals kind === fence" });
    if (e.kind === "soft" && e.note !== SOFT_EDGE_NOTE) ctx.addIssue({ code: "custom", message: "every soft edge carries the identical neutral note" });
  });
export type Edge = z.infer<typeof Edge>;

// A derived fence lives only in memory, produced from section bindings by the workflow package.
export const DerivedEdge = z.strictObject({ from: StepRef, to: StepRef, gate: z.literal("complete"), origin: z.literal("data_integrity") });
export type DerivedEdge = z.infer<typeof DerivedEdge>;

export const Trigger = z.strictObject({ target: StepRef, when: CappedPredicate, condition: CappedCondition.nullable() });
export type Trigger = z.infer<typeof Trigger>;

export const WorkflowStatus = z.enum(["draft", "proposed", "dev_validated", "dev_failed", "adopted", "suspended", "reverted", "rejected"]);

export const Clocks = z.strictObject({ occurred_at: z.number().int().min(0), recorded_at: z.number().int().min(0), wall_at: IsoDateTime });
export type Clocks = z.infer<typeof Clocks>;

export const VersionMetadata = z.strictObject({
  author: z.strictObject({ kind: z.enum(["human", "model_session"]), id: z.string() }),
  proposal_id: z.string().nullable(),
  change_ops: z.array(z.unknown()),
  source_evidence: z.strictObject({ event_ids: z.array(z.string()), hypothesis_ids: z.array(z.string()), experiment_ids: z.array(z.string()), validation_report_id: z.string().nullable() }),
  approver: z.strictObject({ staff_id: z.string(), role: z.literal("ward_manager"), display_name: z.string() }).nullable(),
  adopted_at: Clocks.nullable(),
  effective_from: z.number().int().nullable(),
  supersedes: VersionNumber.nullable(),
  suspended: z.strictObject({ by: z.string(), reason: z.string(), at: Clocks }).nullable(),
  reverted: z.strictObject({ by: z.string(), reason: z.string(), at: Clocks }).nullable(),
  model_provenance: z
    .strictObject({ provider: z.string(), model_id: z.string(), mode: z.string(), endpoint: z.string(), request_ids: z.array(z.string()), prompt_hash: Sha256, tools_hash: Sha256, settings: z.record(z.string(), z.unknown()) })
    .nullable(),
  fences_hash: Sha256,
  permissions_hash: Sha256,
  structure_hash: Sha256,
  rules_hash: Sha256
});

// The unrefined shape, for deriving model-facing variants with pick or omit; validate with WorkflowDefinition.
export const WorkflowDefinitionBase = z.strictObject({
  workflow_id: z.literal("inpatient_discharge"),
  version: VersionNumber,
  parent_version: VersionNumber.nullable(),
  definition_hash: Sha256,
  status: WorkflowStatus,
  scope: z.strictObject({ wards: z.union([z.array(z.string().regex(FACT_VALUES.ward_id)).min(1), z.literal("all")]), condition: CappedCondition.nullable() }),
  fallback_version: VersionNumber.nullable(),
  actors: z.array(ActorRole),
  permissions: z.partialRecord(ActionKind, z.array(ActorRole)),
  documents: z.array(DocumentTemplate),
  steps: z.array(Step).min(1),
  edges: z.array(Edge),
  triggers: z.array(Trigger),
  metadata: VersionMetadata
});

export const WorkflowDefinition = WorkflowDefinitionBase.superRefine((w, ctx) => {
  for (const [kind, roles] of Object.entries(w.permissions)) {
    if (roles?.includes("agent") && !AGENT_ALLOWED_KINDS.has(kind as ActionKind)) ctx.addIssue({ code: "custom", message: `agent may not hold ${kind}` });
  }
  const stepIds = new Set<string>();
  for (const s of w.steps) {
    if (stepIds.has(s.step_id)) ctx.addIssue({ code: "custom", message: `duplicate step ${s.step_id}` });
    stepIds.add(s.step_id);
    const allowed = w.permissions[s.action_kind] ?? [];
    for (const r of s.actor_roles) {
      if (!allowed.includes(r)) ctx.addIssue({ code: "custom", message: `${s.step_id}: ${r} lacks permission for ${s.action_kind}` });
    }
    if (s.actor_roles.includes("agent") && !AGENT_ALLOWED_KINDS.has(s.action_kind)) ctx.addIssue({ code: "custom", message: `${s.step_id}: agent may not act on ${s.action_kind}` });
  }
  const edgeIds = new Set<string>();
  for (const e of w.edges) {
    if (edgeIds.has(e.edge_id)) ctx.addIssue({ code: "custom", message: `duplicate edge ${e.edge_id}` });
    edgeIds.add(e.edge_id);
    if (!stepIds.has(e.from.step) || !stepIds.has(e.to.step)) ctx.addIssue({ code: "custom", message: `edge ${e.edge_id} names an unknown step` });
  }
  for (const t of w.triggers) {
    const target = w.steps.find((s) => s.step_id === t.target.step);
    if (!target) ctx.addIssue({ code: "custom", message: "trigger targets an unknown step" });
    else if (target.external) ctx.addIssue({ code: "custom", message: `trigger may not target external step ${target.step_id}` });
  }
  for (const d of w.documents) {
    if (d.preparable_by.includes("agent") && !w.steps.some((s) => s.document_ref?.document_id === d.document_id && s.actor_roles.includes("agent") && AGENT_ALLOWED_KINDS.has(s.action_kind))) {
      ctx.addIssue({ code: "custom", message: `${d.document_id}: agent is preparable_by with no permitted preparing step` });
    }
  }
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionBase>;

// Code-point order, never localeCompare, so hashes agree across machines.
const byKey = <T>(xs: T[], key: (x: T) => string) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

// The hashes the model can never change: stored fences, permissions and step structure. Each is order-independent.
export function fencesHash(w: Pick<WorkflowDefinition, "edges">): string {
  const fences = w.edges.filter((e) => e.kind === "fence").map((e) => ({ edge_id: e.edge_id, from: e.from, to: e.to, gate: e.gate, origin: e.origin }));
  return hashJson(byKey(fences, (f) => f.edge_id));
}
export function permissionsHash(w: Pick<WorkflowDefinition, "permissions">): string {
  const rows = Object.entries(w.permissions).map(([kind, roles]) => ({ kind, roles: [...(roles ?? [])].sort() }));
  return hashJson(byKey(rows, (r) => r.kind));
}
export function structureHash(w: Pick<WorkflowDefinition, "steps" | "documents">): string {
  const steps = w.steps.map(({ required_when: _c, ...s }) => ({ ...s, actor_roles: [...s.actor_roles].sort() }));
  const docs = w.documents.map(({ sections, ...d }) => ({ ...d, sections: sections.map((x) => ({ section_id: x.section_id, needed_for: x.needed_for })) }));
  return hashJson({ steps: byKey(steps, (s) => s.step_id), documents: byKey(docs, (d) => d.document_id) });
}
// Content identity: everything except version numbers, status and metadata.
export function definitionHash(w: WorkflowDefinition): string {
  const { definition_hash: _h, status: _s, metadata: _m, version: _v, parent_version: _p, ...body } = w;
  return hashJson(body);
}
