import { Metric } from "@hey-pisgah/contracts";
import type { ChatTool } from "@hey-pisgah/model";
import { z } from "zod";
import type { Arm, Session } from "./session.js";

const Loose = z.record(z.string(), z.unknown());
const Selector = z.object({
  kind: z.string(),
  step_id: z.string().optional(),
  record_kind: z.string().optional(),
  document_id: z.string().optional(),
  stage: z.enum(["draft", "final"]).optional(),
  role: z.string().optional(),
  occurrence: z.enum(["first", "last"]).optional()
});
const PredictionT = z.object({
  metric: Metric,
  comparison: z.enum(["intervention_lt_control", "intervention_gt_control", "no_difference"]),
  tolerance_min: z.number().int(),
  scope: z.object({ cases: z.array(z.string()).optional(), condition: Loose.optional() })
});
const Insufficient = z.object({ missing_measurement: z.string(), distinguishes: z.array(z.string()), why_it_matters: z.string() });

// Model-facing argument shapes; each handler validates again with the strict contract schema.
export const TOOL_ARGS = {
  list_cases: z.object({}),
  get_case_timeline: z.object({ case_id: z.string(), order: z.enum(["occurred", "recorded"]), offset: z.number().int().optional(), limit: z.number().int().optional(), kinds: z.array(z.string()).optional() }),
  get_record: z.object({ case_id: z.string(), record_kind: z.string().optional(), document_id: z.string().optional() }),
  compute_intervals: z.object({ case_ids: z.array(z.string()).min(1).max(12), from: Selector, to: Selector, clock: z.enum(["occurred", "recorded"]) }),
  get_queue_snapshot: z.object({ case_id: z.string(), at_min: z.number().int() }),
  get_staff_activity: z.object({ case_id: z.string(), role: z.string() }),
  get_ward_requirements: z.object({ ward_id: z.string().optional() }),
  get_workflow_definition: z.object({}),
  record_hypothesis: z.object({
    statement: z.string(), mechanism: z.string(), subject_refs: z.array(z.string()),
    competing: z.union([z.array(z.string()), z.object({ none_identified_reason: z.string() })]),
    evidence: z.array(z.object({ event_id: z.string(), case_id: z.string(), stance: z.enum(["supports", "contradicts", "context"]), note: z.string() })),
    if_true: PredictionT, if_false: PredictionT, refuted_if: z.string(), revises: z.string().nullable().optional()
  }),
  set_hypothesis_status: z.object({ hypothesis_id: z.string(), status: z.enum(["retained", "rejected"]), experiment_ids: z.array(z.string()), evidence_event_ids: z.array(z.string()), note: z.string() }),
  run_experiment: z.object({
    hypothesis_id: z.string(), distinguishes: z.array(z.string()), base: z.object({ version: z.number().int().optional(), proposal_id: z.string().optional() }),
    ops: z.array(Loose).min(1).max(3), case_ids: z.array(z.string()).min(1).max(6), note: z.string()
  }),
  get_experiment: z.object({ experiment_id: z.string() }),
  get_listed_experiment: z.object({}),
  submit_proposal: z.object({
    parent_proposal_id: z.string().nullable(), base_version: z.number().int(), ops: z.array(Loose).min(1).max(3),
    scope: z.object({ wards: z.union([z.array(z.string()), z.literal("all")]), condition: Loose.nullable() }),
    rationale: z.string(), evidence: z.object({ hypothesis_ids: z.array(z.string()), experiment_ids: z.array(z.string()), event_ids: z.array(z.string()) }),
    expected_effects: z.array(z.object({ metric: Metric, direction: z.enum(["down", "up", "same"]), subgroup_condition: Loose.nullable() })),
    known_exceptions: z.array(z.object({ condition: Loose, behaviour: z.literal("not_applied") }))
  }),
  get_validation_report: z.object({ proposal_id: z.string() }),
  list_ledger: z.object({}),
  end_session: z.object({ result: z.enum(["no_change_warranted"]), note: z.string(), evidence_event_ids: z.array(z.string()) })
} as const;
export type ToolName = keyof typeof TOOL_ARGS;

// Descriptions say what each tool returns or records, never what to look for.
export const DESCRIPTIONS: Record<ToolName, string> = {
  list_cases: "List the recorded discharge cases in this session's pool: case id, ward, payer, requirement version, event and note counts, and the facts recorded when each case opened.",
  get_case_timeline: "Read one page of a case's recorded events and staff notes, ordered by the occurred clock or the recorded clock. Every event carries both clocks; a late entry carries its reason. Note text arrives inside untrusted_text. Page with offset and next_offset; kinds filters by event kind, and note.recorded selects notes.",
  get_record: "Read the recorded versions of one record kind in a case, with content where the record holds any, or every event that names one document_id.",
  compute_intervals: "Minutes between two selected events in each listed case, on one clock. A selector names an event kind, may narrow by step_id, record_kind, document_id, stage or role, and takes the first or last match. Returns per-case minutes with the event ids used, and the median, min and max.",
  get_queue_snapshot: "The state of each staff role in a case at one minute on the occurred clock: other patients' work that had arrived, this case's queued, running and finished jobs, and any busy block in progress.",
  get_staff_activity: "Every job one role did on a case, per staff member, with queue, start and completion minutes, and that role's busy blocks.",
  get_ward_requirements: "The ward requirements in force: required documents with their conditions, the approver, and each ward's procedure text, for one ward or all.",
  get_workflow_definition: "The current workflow definition (steps, edges, triggers, documents, permissions), the full action-kind and event-kind registries, the condition facts and their values, the record kinds a section may bind to, and the operation vocabulary with its limits.",
  record_hypothesis: "Record a hypothesis: statement, mechanism, subject refs, competing hypothesis ids or the reason none were identified, at least 3 evidence events from at least 2 cases with a stance each, if_true and if_false predictions (metric, comparison of intervention to control, tolerance, and cases or a condition) that differ, and what would refute it. Tolerance is capped at 60 for minute metrics and 3 for counts. A record never changes; set revises to replace an older one. Returns the id and hash.",
  set_hypothesis_status: "Set a hypothesis status. retained needs a cited experiment whose result matches its if_true prediction. rejected needs a cited experiment whose result matches its if_false prediction or contradicts its if_true prediction, or recorded events when no experiment is cited. A refused change is counted.",
  run_experiment: "Run the base version and a changed version (1 to 3 operations) on the same recorded world for 1 to 6 pool cases. Returns per-case metrics for both versions, their deltas, step time differences, action differences, warnings, the median deltas and the budget left. Checks run in order: schema, ids, two recorded hypotheses or one with a stated reason, definition rules, schedule hashes. A refused request is counted, and the third ends access.",
  get_experiment: "Read a stored experiment result by id.",
  get_listed_experiment: "Run the next experiment from this session's committed list on the same recorded world and return its result in the experiment result shape.",
  submit_proposal: "Submit a workflow change: base version, 1 to 3 operations, scope (wards and an optional condition), rationale, evidence (hypothesis, experiment and event ids), expected effects and known exceptions. The server adds the id, the cases viewed and a hash. Validation runs on cases outside the pool; the reply says whether the report is ready.",
  get_validation_report: "Read the validation report for a proposal: status, pass or fail per case on both versions with failing check ids, deltas, and the gate result.",
  list_ledger: "List this session's hypotheses, experiments, proposals and the budget left.",
  end_session: "End the session with a result, a note and the recorded event ids inspected. no_change_warranted is a valid result."
};

const READS: ToolName[] = ["list_cases", "get_case_timeline", "get_record", "compute_intervals", "get_queue_snapshot", "get_staff_activity", "get_ward_requirements", "get_workflow_definition"];
const RECORDS: ToolName[] = ["record_hypothesis", "set_hypothesis_status"];
const CLOSE: ToolName[] = ["submit_proposal", "get_validation_report", "list_ledger", "end_session"];

// The tool set of each arm; A3 differs from the adaptive arm only by the experiment tools.
export function armTools(arm: Arm): ToolName[] {
  switch (arm) {
    case "adaptive": return [...READS, ...RECORDS, "run_experiment", "get_experiment", ...CLOSE];
    case "a3": return [...READS, ...RECORDS, ...CLOSE];
    case "a4": return [...READS, ...RECORDS, "get_listed_experiment", "get_experiment", ...CLOSE];
    case "prior": return ["get_ward_requirements", "get_workflow_definition", "submit_proposal", "end_session"];
  }
}

// Optional statuses join the schema only when the insufficient_evidence flag is on.
function argsFor(name: ToolName, flags: { insufficientEvidence?: boolean | undefined }): z.ZodType {
  if (!flags.insufficientEvidence) return TOOL_ARGS[name];
  if (name === "set_hypothesis_status") return TOOL_ARGS.set_hypothesis_status.extend({ status: z.enum(["retained", "rejected", "insufficient_evidence"]), insufficient: Insufficient.optional() });
  if (name === "end_session") return TOOL_ARGS.end_session.extend({ result: z.enum(["no_change_warranted", "insufficient_evidence"]), insufficient: Insufficient.optional() });
  return TOOL_ARGS[name];
}

export function toolDefs(arm: Arm, flags: { insufficientEvidence?: boolean | undefined } = {}): ChatTool[] {
  return armTools(arm).map((name) => {
    const { $schema: _drop, ...parameters } = z.toJSONSchema(argsFor(name, flags)) as Record<string, unknown>;
    return { type: "function" as const, function: { name, description: DESCRIPTIONS[name], parameters } };
  });
}

// Runs one tool call; unknown tools and unparseable arguments come back as data the model can read.
export async function dispatch(s: Session, name: string, argText: string): Promise<Record<string, unknown>> {
  if (!(armTools(s.o.arm) as string[]).includes(name)) return { ok: false, error: "no_such_tool", message: "No tool has that name in this session." };
  let args: unknown;
  try { args = argText.trim() ? JSON.parse(argText) : {}; } catch { s.counters.repairs += 1; return { ok: false, error: "invalid_arguments", message: "The arguments are not valid JSON." }; }
  const loose = argsFor(name as ToolName, { insufficientEvidence: s.o.insufficientEvidence }).safeParse(args);
  if (!loose.success && name !== "run_experiment") {
    s.counters.repairs += 1;
    return { ok: false, error: "invalid_arguments", message: "The arguments do not match the schema.", issues: loose.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "$"}: ${i.message}`) };
  }
  const a = (loose.success ? loose.data : args) as never;
  switch (name as ToolName) {
    case "list_cases": return s.listCases();
    case "get_case_timeline": return s.timeline(a);
    case "get_record": return s.record(a);
    case "compute_intervals": return s.intervals(a);
    case "get_queue_snapshot": return s.queue(a);
    case "get_staff_activity": return s.staff(a);
    case "get_ward_requirements": return s.requirements(a);
    case "get_workflow_definition": return s.definition();
    case "record_hypothesis": return s.recordHypothesis(args);
    case "set_hypothesis_status": return s.setStatus(args);
    case "run_experiment": return s.runExperiment(args);
    case "get_experiment": return s.getExperiment(a);
    case "get_listed_experiment": return s.nextListed();
    case "submit_proposal": return s.submitProposal(args);
    case "get_validation_report": return s.validationReport(a);
    case "list_ledger": return s.ledger();
    case "end_session": return s.endSession(args);
  }
}
