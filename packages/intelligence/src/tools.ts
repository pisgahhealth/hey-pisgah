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
  get_derived_statistics: z.object({ top: z.number().int().optional() }),
  choose_question: z.object({ hypothesis_ids: z.array(z.string()), question: z.string(), expected_change: z.object({ step: z.string(), behaviour: z.enum(["start_time", "eligibility", "event_order"]) }) }),
  next_cycle: z.object({ reason: z.string() }),
  get_precondition_table: z.object({}),
  run_sweep: z.object({ op_kinds: z.array(z.enum(["remove_soft_edge", "add_soft_edge", "move_step_after", "set_prep_trigger", "add_condition", "rebind_section"])), case_ids: z.array(z.string()), top_k: z.number().int().optional(), target_steps: z.array(z.string()).optional(), pairs: z.boolean().optional() }),
  set_hypothesis_status: z.object({ hypothesis_id: z.string(), status: z.enum(["retained", "rejected"]), experiment_ids: z.array(z.string()), evidence_event_ids: z.array(z.string()), note: z.string() }),
  run_experiment: z.object({
    hypothesis_id: z.string(), distinguishes: z.array(z.string()), base: z.object({ version: z.number().int().optional(), proposal_id: z.string().optional() }),
    ops: z.array(Loose).min(1).max(3), case_ids: z.array(z.string()).min(1).max(6), note: z.string(),
    expected_change: z.object({ step: z.string(), behaviour: z.enum(["start_time", "eligibility", "event_order"]) }).optional()
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
  record_note: z.object({ note: z.string() }),
  end_session: z.object({ result: z.enum(["no_change_warranted"]), note: z.string(), evidence_event_ids: z.array(z.string()) })
} as const;
export type ToolName = keyof typeof TOOL_ARGS;

// Descriptions say what each tool returns or records, never what to look for.
export const DESCRIPTIONS: Record<ToolName, string> = {
  list_cases: "List the recorded discharge cases in this session's pool: case id, ward, payer, requirement version, event and note counts, and the facts recorded when each case opened.",
  get_case_timeline: "Read one page of a case's recorded events and staff notes, ordered by the occurred clock or the recorded clock. Every event carries both clocks; a late entry carries its reason. Note text arrives inside untrusted_text. Page with offset and next_offset; kinds filters by event kind, and note.recorded selects notes. ",
  get_record: "Read the recorded versions of one record kind in a case, with content where the record holds any, or every event that names one document_id.",
  compute_intervals: "Minutes between two selected events in each listed case, on one clock. A selector names an event kind, may narrow by step_id, record_kind, document_id, stage or role, and takes the first or last match. Returns per-case minutes with the event ids used, and the median, min and max.",
  get_queue_snapshot: "The state of each staff role in a case at one minute on the occurred clock: other patients' work that had arrived, this case's queued, running and finished jobs, and any busy block in progress.",
  get_staff_activity: "Every job one role did on a case, per staff member, with queue, start and completion minutes, and that role's busy blocks.",
  get_ward_requirements: "The ward requirements in force: required documents with their conditions, the approver, and each ward's procedure text, for one ward or all.",
  get_workflow_definition: "The current workflow definition (steps, edges, triggers, documents, permissions), the full action-kind and event-kind registries, the condition facts and their values, the record kinds a section may bind to, the rules the engine applies when it runs a definition, and the operation vocabulary with its limits.",
  record_hypothesis: "Record a hypothesis: statement, mechanism, subject refs, competing hypothesis ids or the reason none were identified, at least 3 evidence events from at least 2 cases with a stance each, if_true and if_false predictions (metric, comparison of intervention to control, tolerance, and cases or a condition) that differ, and what would refute it. Tolerance is capped at 60 for minute metrics and 3 for counts. A record never changes; set revises to replace an older one. Returns the id and hash; a schema error lists each failing field with its expected type and an example. In the investigation cycle it also takes predicted_magnitude_min, falsifying_experiment and if_null (what you conclude if the change is delivered and the outcome does not move), which the ledger keeps.",
  set_hypothesis_status: "Set a hypothesis status. retained needs a cited delivered experiment whose result matches its if_true prediction on the cases where the named behaviour moved. rejected needs a cited delivered experiment whose result matches its if_false prediction or contradicts its if_true prediction there, or recorded events when no experiment is cited. An experiment that was not delivered supports and rejects nothing. A refused change is counted.",
  run_experiment: "Run the base version and a changed version (1 to 3 operations) on the same recorded world for 1 to 6 pool cases, naming expected_change: the step and the behaviour (start_time, eligibility or event_order) you expect the change to move. Checks run in order: schema, ids, definition rules, then a deterministic lint that refuses a change leaving every step's start and completion rule equivalent, one whose cited hypotheses (hypothesis_id and distinguishes) cannot be told apart on these cases, or one already run; a lint refusal says why, uses no experiment and is not counted as a refused request. Returns a receipt (rules changed, the named behaviour per case in both versions, delivered k of n cases, the first event where the logs diverge, the outcome), per-case metrics and deltas, step time and action differences, and the median deltas. A refused request is counted, and the third ends access.",
  get_experiment: "Read a stored experiment result by id.",
  get_listed_experiment: "Run the next experiment from this session's committed list on the same recorded world and return its result in the experiment result shape.",
  submit_proposal: "Submit a workflow change: base version, 1 to 3 operations, scope (wards and an optional condition), rationale, evidence (hypothesis, experiment and event ids), expected effects and known exceptions. The server adds the id, the cases viewed and a hash. Validation runs on cases outside the pool; the reply says whether the report is ready.",
  get_validation_report: "Read the validation report for a proposal: status, pass or fail per case on both versions with failing check ids, deltas, and the gate result.",
  list_ledger: "The investigation ledger the session keeps from tool results: observations, hypotheses with their predictions and ledger fields, experiments with their receipts, the current question, proposals and the budget left.",
  get_derived_statistics: "Derived from every recorded case in the pool: each step's median wait (from its latest-finishing predecessor's completion to its start) and work, how often it lies on the critical path from the clinical sign-off to departure, the critical segments ranked by total minutes with example event ids, and each case's critical path.",
  choose_question: "Name the question this cycle's experiment must answer: at least two hypothesis ids it must tell apart and expected_change, the step behaviour you expect the experiment to move. Two hypotheses can be told apart when their if_true predictions name the same metric, share an experimentable pool case, and allow delta ranges that do not overlap: intervention_lt_control with tolerance t allows deltas of -t or less, intervention_gt_control allows t or more, and no_difference allows -t to t. A refusal lists each pair's ranges and overlap.",
  next_cycle: "Close this cycle with a reason; the next cycle opens with a fresh conversation that holds the ledger.",
  get_precondition_table: "The engine's start, completion and trigger rules, and for each operation kind the rule it edits and the condition under which that edit can change what the engine does; the same table for every definition.",
  run_sweep: "Run every legal single operation of the named op_kinds that touches the scope steps, and every pair of them, on the same 1 to 6 pool cases and seeds; the scope is both steps of each of the top_k critical segments from get_derived_statistics (default 3), or target_steps. An operation touches the scope when its target is a scope step, or, for an edge removal, either end of the edge is. Cells the definition rules refuse are skipped, and cells the static test calls a no-op are not run. Returns counts, the 20 best cells by summed wait delta and up to 10 delivered cells whose wait did not move, each with its operations, whether a targeted step's start or completion moved, the median and summed wait deltas, cases better and worse, and the steps whose minutes shifted. A sweep takes 1 to 60 single operations, uses no experiment, and runs at most 3 times a session.",
  record_note: "Save a short free-text note, up to 600 characters, for later turns. Saved notes are shown as a numbered list at the top of every later turn; at most 20 notes are kept.",
  end_session: "End the session with a result, a note and the recorded event ids inspected. no_change_warranted is a valid result."
};

const READS: ToolName[] = ["list_cases", "get_case_timeline", "get_record", "compute_intervals", "get_queue_snapshot", "get_staff_activity", "get_ward_requirements", "get_workflow_definition"];
const RECORDS: ToolName[] = ["record_hypothesis", "set_hypothesis_status", "record_note"];
const CLOSE: ToolName[] = ["submit_proposal", "get_validation_report", "list_ledger", "end_session"];

// The tool set of each arm; A3 differs from the adaptive arm only by the experiment tools.
export function armTools(arm: Arm): ToolName[] {
  switch (arm) {
    case "adaptive": return [...READS, "get_derived_statistics", "record_hypothesis", "set_hypothesis_status", "choose_question", "get_precondition_table", "run_sweep", "run_experiment", "get_experiment", ...CLOSE, "next_cycle"];
    case "a3": return [...READS, ...RECORDS, ...CLOSE];
    case "a4": return [...READS, ...RECORDS, "get_listed_experiment", "get_experiment", ...CLOSE];
    case "prior": return ["get_ward_requirements", "get_workflow_definition", "submit_proposal", "end_session"];
  }
}

// Optional statuses join the schema only when the insufficient_evidence flag is on.
const LEDGER_ARGS = { predicted_magnitude_min: z.number().int(), falsifying_experiment: z.string(), if_null: z.string() };

function argsFor(name: ToolName, flags: { insufficientEvidence?: boolean | undefined; arm?: Arm }): z.ZodType {
  if (name === "record_hypothesis" && flags.arm === "adaptive") return TOOL_ARGS.record_hypothesis.extend(LEDGER_ARGS);
  if (!flags.insufficientEvidence) return TOOL_ARGS[name];
  if (name === "set_hypothesis_status") return TOOL_ARGS.set_hypothesis_status.extend({ status: z.enum(["retained", "rejected", "insufficient_evidence"]), insufficient: Insufficient.optional() });
  if (name === "end_session") return TOOL_ARGS.end_session.extend({ result: z.enum(["no_change_warranted", "insufficient_evidence"]), insufficient: Insufficient.optional() });
  return TOOL_ARGS[name];
}

export function toolDefs(arm: Arm, flags: { insufficientEvidence?: boolean | undefined } = {}, only?: ReadonlySet<string>): ChatTool[] {
  return armTools(arm).filter((n) => !only || only.has(n)).map((name) => {
    const { $schema: _drop, ...parameters } = z.toJSONSchema(argsFor(name, { ...flags, arm })) as Record<string, unknown>;
    return { type: "function" as const, function: { name, description: DESCRIPTIONS[name], parameters } };
  });
}

// Runs one tool call; unknown tools and unparseable arguments come back as data the model can read, and pageChars shortens timeline pages.
export async function dispatch(s: Session, name: string, argText: string, o: { pageChars?: number; turn?: number } = {}): Promise<Record<string, unknown>> {
  if (!(armTools(s.o.arm) as string[]).includes(name)) return { ok: false, error: "no_such_tool", message: "No tool has that name in this session." };
  if (s.allowedTools && !s.allowedTools.has(name)) { s.counters.stage_refusals += 1; return { ok: false, error: "not_in_this_stage", message: "That tool is not offered in the current stage of the cycle.", tools: [...s.allowedTools].sort() }; }
  let args: unknown;
  try { args = argText.trim() ? JSON.parse(argText) : {}; } catch { s.counters.repairs += 1; return { ok: false, error: "invalid_arguments", message: "The arguments are not valid JSON." }; }
  const loose = argsFor(name as ToolName, { insufficientEvidence: s.o.insufficientEvidence, arm: s.o.arm }).safeParse(args);
  if (!loose.success && name !== "run_experiment" && name !== "record_hypothesis") {
    s.counters.repairs += 1;
    return { ok: false, error: "invalid_arguments", message: "The arguments do not match the schema.", issues: loose.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "$"}: ${i.message}`) };
  }
  const a = (loose.success ? loose.data : args) as never;
  switch (name as ToolName) {
    case "list_cases": return s.listCases();
    case "get_case_timeline": return s.timeline(a, o.pageChars);
    case "get_record": return s.record(a);
    case "compute_intervals": return s.intervals(a);
    case "get_queue_snapshot": return s.queue(a);
    case "get_staff_activity": return s.staff(a);
    case "get_ward_requirements": return s.requirements(a);
    case "get_workflow_definition": return s.definition(o.turn);
    case "record_hypothesis": return s.recordHypothesis(args);
    case "set_hypothesis_status": return s.setStatus(args);
    case "run_experiment": return s.runExperiment(args);
    case "get_experiment": return s.getExperiment(a);
    case "get_listed_experiment": return s.nextListed();
    case "submit_proposal": return s.submitProposal(args);
    case "get_validation_report": return s.validationReport(a);
    case "list_ledger": return s.ledger();
    case "get_derived_statistics": return s.statistics(a);
    case "choose_question": return s.chooseQuestion(args);
    case "next_cycle": return s.nextCycle(args);
    case "get_precondition_table": return s.preconditions();
    case "run_sweep": return s.runSweep(args);
    case "record_note": return s.recordNote(args);
    case "end_session": return s.endSession(args);
  }
}
