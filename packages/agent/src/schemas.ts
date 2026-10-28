import { z } from "zod";
import { CaseId, DocumentId, EventId, EventKind, RecordId, RecordKind, SectionId, Stage, StepId, VersionNumber } from "@hey-pisgah/contracts";

// Staff message templates; the agent picks one and never writes free text to staff.
export const TEMPLATES = {
  document_ready: "The {document} {stage} for this patient is ready.",
  check_requested: "Please check the {document} {stage} for this patient.",
  status_request: "Please record the current status for this patient's discharge."
} as const;
export const TemplateId = z.enum(Object.keys(TEMPLATES) as [keyof typeof TEMPLATES, ...(keyof typeof TEMPLATES)[]]);
export const StaffRole = z.enum(["doctor", "nurse", "pharmacist", "accounts_clerk", "claims_clerk", "ward_manager"]);

const DocStage = { case_id: CaseId, document_id: DocumentId, stage: Stage };

// Arguments of every execution tool; the dispatcher and the port validate with the same schemas.
export const ARGS = {
  get_case_state: z.strictObject({ case_id: CaseId, page: z.number().int().min(1).max(50).optional() }),
  get_ward_requirements: z.strictObject({ case_id: CaseId }),
  get_workflow_definition: z.strictObject({ case_id: CaseId }),
  get_record: z.strictObject({ record_id: RecordId }),
  prepare_document: z.strictObject(DocStage),
  revise_document: z.strictObject(DocStage),
  request_check: z.strictObject(DocStage),
  send_staff_message: z.strictObject({ case_id: CaseId, role: StaffRole, template_id: TemplateId, document_id: DocumentId.optional(), stage: Stage.optional() }),
  ask_staff: z.strictObject({ case_id: CaseId, role: StaffRole, question: z.string().min(1).max(300) }),
  apply_case_exception: z.strictObject({
    case_id: CaseId,
    op: z.strictObject({ document_id: DocumentId, section_id: SectionId, note: z.string().min(1).max(200) }),
    reason: z.string().min(1).max(300),
    confirm_by_role: z.enum(["doctor", "nurse", "pharmacist", "ward_manager"])
  }),
  raise_workflow_conflict: z.strictObject({
    case_id: CaseId,
    version: VersionNumber,
    requirement_version: z.string().regex(/^r\d+$/),
    explanation: z.string().min(1).max(600),
    evidence: z.array(EventId).max(10)
  }),
  wait_until: z.strictObject({
    event_kind: EventKind.optional(),
    step_id: StepId.optional(),
    record_kind: RecordKind.optional(),
    deadline_simulated_min: z.number().int().min(0).max(2880)
  }),
  finish_task: z.strictObject({ summary: z.string().max(300) })
} as const;
export type ToolName = keyof typeof ARGS;

// Tools that change the hospital record; each one is journaled as an intent before it reaches the port.
export const WRITE_TOOLS = ["prepare_document", "revise_document", "request_check", "send_staff_message", "ask_staff", "apply_case_exception", "raise_workflow_conflict"] as const;
export type WriteTool = (typeof WRITE_TOOLS)[number];
export const READ_TOOLS = ["get_case_state", "get_ward_requirements", "get_workflow_definition", "get_record"] as const;
export const CONTROL_TOOLS = ["wait_until", "finish_task"] as const;
export const isWriteTool = (n: string): n is WriteTool => (WRITE_TOOLS as readonly string[]).includes(n);
