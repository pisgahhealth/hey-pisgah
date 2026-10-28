import { z } from "zod";
import { CaseId, Sha256, SimEvent, StepId } from "@hey-pisgah/contracts";
import { ExternalSchedule } from "@hey-pisgah/simulator";

export const FAMILIES = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "FV"] as const;
export const Family = z.enum(FAMILIES);
export type Family = z.infer<typeof Family>;
// Families that ride on top of another case rather than shaping its world.
export const Overlay = z.enum(["F11", "F12"]);
export type Overlay = z.infer<typeof Overlay>;
export const Pool = z.enum(["discovery", "dev", "dev_held", "variation", "demo", "reserved", "spare"]);
export type Pool = z.infer<typeof Pool>;
export const Ward = z.enum(["A", "B", "C"]);
export type Ward = z.infer<typeof Ward>;
export const Payer = z.enum(["self_pay", "hmo", "corporate"]);
export type Payer = z.infer<typeof Payer>;

// Staff notes are data for the agent, never instructions; the text is capped as the timeline tool caps it.
export const Note = z.strictObject({
  note_id: z.string().regex(/^n\d{2}$/),
  occurred_at: z.number().int().min(0).max(2880),
  recorded_at: z.number().int().min(0).max(2880),
  author_role: z.enum(["nurse", "doctor", "pharmacist", "accounts_clerk", "ward_manager"]),
  author_id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  untrusted_text: z.string().min(1).max(500)
});
export type Note = z.infer<typeof Note>;

// What the hospital record holds when the case opens; no field states a duration.
export const InitialState = z.strictObject({
  case_id: CaseId,
  ward_id: Ward,
  bed: z.string().regex(/^[A-C]-\d{2}$/),
  payer_type: Payer,
  requirement_version: z.string().regex(/^r\d+$/),
  patient: z.strictObject({
    name: z.string().min(3).max(80),
    hospital_no: z.string().regex(/^[A-Z]{2}\d{6}$/),
    sex: z.enum(["female", "male"]),
    age_years: z.number().int().min(16).max(95)
  }),
  admission_reason: z.string().min(3).max(120),
  deposit_naira: z.number().int().min(0),
  notes: z.array(Note)
});
export type InitialState = z.infer<typeof InitialState>;

// A port-side fault for truthful-completion cases; the definition executor never sees it.
export const InfraFault = z.strictObject({
  kind: z.enum(["write_ack_lost", "write_dropped", "read_unavailable", "event_delivery_late"]),
  target: z.string().min(1),
  from_min: z.number().int().min(0).max(2880),
  to_min: z.number().int().min(0).max(2880)
});
export type InfraFault = z.infer<typeof InfraFault>;

export const BehaviourClass = z.enum(["act", "wait", "ask", "refuse"]);
export type BehaviourClass = z.infer<typeof BehaviourClass>;
// An event the scorer can find in a trace: case start, a step completing or a note being recorded.
export const EventSel = z.union([
  z.strictObject({ case_start: z.literal(true) }),
  z.strictObject({ step_completed: StepId }),
  z.strictObject({ note_recorded: z.string().regex(/^n\d{2}$/) }),
  z.strictObject({ record_updated: z.string().regex(/^[a-z0-9_-]+$/) }),
  z.strictObject({ at_min: z.number().int().min(0).max(2880) })
]);
export type EventSel = z.infer<typeof EventSel>;
export const DecisionPoint = z.strictObject({
  dp_id: z.string().regex(/^dp\d{2}$/),
  kind: z.enum([
    "summary_draft_window", "summary_final_held", "readiness_message_held", "summary_final_open", "list_changed",
    "claim_cover_final_held", "claim_cover_final_open", "untrusted_instruction", "case_note_request", "requirement_conflict",
    "infra_fault", "refund_voucher_open"
  ]),
  from: EventSel,
  until: EventSel.nullable(),
  acceptable_classes: z.array(BehaviourClass).min(1),
  act_means: z.string().min(1).max(200)
});
export type DecisionPoint = z.infer<typeof DecisionPoint>;

export const Trap = z.enum(["T1", "T2", "T3", "T4", "T5", "T6"]);
export const Manifest = z.strictObject({
  case_id: CaseId,
  pool: Pool,
  family: Family,
  overlays: z.array(Overlay),
  seed: z.string().min(1),
  ward_id: Ward,
  payer_type: Payer,
  requirement_version: z.string().regex(/^r\d+$/),
  canary: z.string().min(4),
  should_apply: z.strictObject({ value: z.boolean(), why: z.enum(["helps", "no_effect", "not_required", "rework_risk", "signoff_risk", "requirement_conflict", "case_exception"]) }),
  variant: z.string().regex(/^[a-z_]+$/).nullable(),
  traps: z.array(Trap),
  decision_points: z.array(DecisionPoint).min(1),
  infra_fault: InfraFault.nullable(),
  schedule_hash: Sha256
});
export type Manifest = z.infer<typeof Manifest>;

// A discovery history: the event log the historical executor produced, without any metric.
export const History = z.strictObject({
  executor: z.literal("historical"),
  version_hash: Sha256,
  rules_hash: Sha256,
  events_hash: Sha256,
  events: z.array(SimEvent)
});
export type History = z.infer<typeof History>;

// The committed case file; it never carries the manifest.
export const CaseFile = z.strictObject({
  case_id: CaseId,
  schedule_hash: Sha256,
  schedule: ExternalSchedule,
  initial_state: InitialState,
  infra_fault: InfraFault.nullable(),
  history: History.nullable()
});
export type CaseFile = z.infer<typeof CaseFile>;

export type GeneratedCase = { schedule: ExternalSchedule; initial_state: InitialState; manifest: Manifest; infra_fault: InfraFault | null };
