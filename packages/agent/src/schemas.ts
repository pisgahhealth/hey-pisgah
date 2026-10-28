import { z } from "zod";
import { CaseId, DocumentId, EventId, EventKind, RecordId, RecordKind, SectionId, SourceRef, Stage, StepId, VersionNumber } from "@hey-pisgah/contracts";

// Staff message templates; the agent picks one and never writes free text to staff.
export const TEMPLATES = {
  document_ready: "The {document} {stage} for this patient is ready.",
  check_requested: "Please check the {document} {stage} for this patient.",
  status_request: "Please record the current status for this patient's discharge."
} as const;
export const TemplateId = z.enum(Object.keys(TEMPLATES) as [keyof typeof TEMPLATES, ...(keyof typeof TEMPLATES)[]]);
export const StaffRole = z.enum(["doctor", "nurse", "pharmacist", "accounts_clerk", "claims_clerk", "ward_manager"]);

const DocStage = { case_id: CaseId, document_id: DocumentId, stage: Stage };

const conflictV1 = {
  case_id: CaseId,
  version: VersionNumber,
  requirement_version: z.string().regex(/^r\d+$/),
  explanation: z.string().min(1).max(600),
  evidence: z.array(EventId).max(10)
};
const exceptionV1 = {
  case_id: CaseId,
  op: z.strictObject({ document_id: DocumentId, section_id: SectionId, note: z.string().min(1).max(200) }),
  reason: z.string().min(1).max(300),
  confirm_by_role: z.enum(["doctor", "nurse", "pharmacist", "ward_manager"])
};
const common = {
  get_case_state: z.strictObject({ case_id: CaseId, page: z.number().int().min(1).max(50).optional() }),
  get_ward_requirements: z.strictObject({ case_id: CaseId }),
  get_workflow_definition: z.strictObject({ case_id: CaseId }),
  get_record: z.strictObject({ record_id: RecordId }),
  prepare_document: z.strictObject(DocStage),
  send_staff_message: z.strictObject({ case_id: CaseId, role: StaffRole, template_id: TemplateId, document_id: DocumentId.optional(), stage: Stage.optional() }),
  ask_staff: z.strictObject({ case_id: CaseId, role: StaffRole, question: z.string().min(1).max(300) })
};
const control = {
  wait_until: z.strictObject({
    event_kind: EventKind.optional(),
    step_id: StepId.optional(),
    record_kind: RecordKind.optional(),
    deadline_simulated_min: z.number().int().min(0).max(2880)
  }),
  finish_task: z.strictObject({ summary: z.string().max(300) })
};

// The definition element a conflict names: a step, an edge, a trigger (by its target step) or a section as document_id.section_id.
export const DefinitionElement = z.strictObject({ kind: z.enum(["step", "edge", "trigger", "section"]), id: z.string().min(1).max(80) });

// The tool set the L1.4 live recording used; kept so that recording still replays byte for byte.
export const ARGS_V1 = {
  get_case_state: common.get_case_state,
  get_ward_requirements: common.get_ward_requirements,
  get_workflow_definition: common.get_workflow_definition,
  get_record: common.get_record,
  prepare_document: common.prepare_document,
  revise_document: z.strictObject(DocStage),
  request_check: z.strictObject(DocStage),
  send_staff_message: common.send_staff_message,
  ask_staff: common.ask_staff,
  apply_case_exception: z.strictObject(exceptionV1),
  raise_workflow_conflict: z.strictObject(conflictV1),
  ...control
} as const;

// The current tool set: revise_document and request_check are gone, a conflict cites a definition element, an exception may name a new source.
export const ARGS = {
  ...common,
  apply_case_exception: z.strictObject({
    ...exceptionV1,
    op: z.strictObject({ document_id: DocumentId, section_id: SectionId, source: z.strictObject({ record_kind: RecordKind, field_path: SourceRef.shape.field_path }).optional(), note: z.string().min(1).max(200) })
  }),
  raise_workflow_conflict: z.strictObject({ ...conflictV1, definition_element: DefinitionElement }),
  ...control
} as const;
export type ToolName = keyof typeof ARGS_V1;
export type ToolProfile = "v1" | "v2";
export type ArgSchemas = Record<string, z.ZodType>;
export const argsFor = (profile: ToolProfile): ArgSchemas => (profile === "v1" ? ARGS_V1 : ARGS) as ArgSchemas;
export const toolNames = (profile: ToolProfile): ToolName[] => Object.keys(argsFor(profile)) as ToolName[];

// Tools that change the hospital record; each one is journaled as an intent before it reaches the port.
export const WRITE_TOOLS = ["prepare_document", "revise_document", "request_check", "send_staff_message", "ask_staff", "apply_case_exception", "raise_workflow_conflict"] as const;
export type WriteTool = (typeof WRITE_TOOLS)[number];
export const READ_TOOLS = ["get_case_state", "get_ward_requirements", "get_workflow_definition", "get_record"] as const;
export const CONTROL_TOOLS = ["wait_until", "finish_task"] as const;
export const isWriteTool = (n: string): n is WriteTool => (WRITE_TOOLS as readonly string[]).includes(n);

// At most this many ask_staff questions per task; later ones are refused and counted.
export const ASK_LIMIT = 3;
