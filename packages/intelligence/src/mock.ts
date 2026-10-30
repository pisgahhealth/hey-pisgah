import type { ChatCompletion, MockResponder } from "@hey-pisgah/model";
import type { Arm } from "./session.js";

type Msg = { role: string; content?: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string };
type Call = { name: string; args: unknown };
type Ctx = { results: { name: string; value: Record<string, unknown> }[] };

// Three pool cases with a long wait after the clinical discharge, plus one with a short wait, used by the scripted investigator.
export const MOCK_CASES = { long: ["c-491dbab0", "c-8c9cd194", "c-ed324a69"], short: "c-11060afa" } as const;
const OPS = [{ op: "remove_soft_edge", edge_id: "e04" }, { op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st02" } } }];

function results(messages: Msg[]): Ctx {
  const names = new Map<string, string>();
  for (const m of messages) for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
  const out: Ctx["results"] = [];
  for (const m of messages) {
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    try { out.push({ name: names.get(m.tool_call_id ?? "") ?? "?", value: JSON.parse(m.content) as Record<string, unknown> }); } catch { /* a stub or text */ }
  }
  return { results: out };
}

const last = (ctx: Ctx, name: string, n = 1) => ctx.results.filter((r) => r.name === name).at(-n)?.value ?? {};
function eventOf(ctx: Ctx, caseId: string, subject: string): string {
  for (const r of ctx.results) {
    if (r.name !== "get_case_timeline" || r.value.case_id !== caseId) continue;
    const items = ((r.value.items ?? []) as ({ kind?: string; subject?: string; event_id?: string } | string)[]).map((x) => (typeof x === "string" ? { event_id: x.split(" ")[0], kind: x.split(" ")[1], subject: x.split(" ")[2] } : x));
    const hit = items.find((e) => e.kind === "step.completed" && e.subject === subject);
    if (hit?.event_id) return hit.event_id;
  }
  return "ev-00000000";
}

function hypothesis(ctx: Ctx, which: 1 | 2): Call {
  const [a, b] = MOCK_CASES.long;
  const evidence = [
    { event_id: eventOf(ctx, a, "st05"), case_id: a, stance: "context", note: "clinical discharge recorded" },
    { event_id: eventOf(ctx, a, "st16"), case_id: a, stance: "supports", note: "departure long after it" },
    { event_id: eventOf(ctx, MOCK_CASES.short, "st16"), case_id: MOCK_CASES.short, stance: "contradicts", note: "short wait in this case" }
  ];
  const down = { metric: "post_signoff_wait_min", comparison: "intervention_lt_control", tolerance_min: 30, scope: { cases: [a, b, MOCK_CASES.long[2]] } };
  const same = { metric: "post_signoff_wait_min", comparison: "no_difference", tolerance_min: 10, scope: { cases: [a, b, MOCK_CASES.long[2]] } };
  if (which === 1) {
    return { name: "record_hypothesis", args: { statement: "Summary work starts only after the clinical discharge and then waits behind the nurse's busy block.", mechanism: "The summary draft is gated on the clinical discharge step, so the nurse check falls into the busy block.", subject_refs: ["st06", "e04"], competing: { none_identified_reason: "first reading" }, evidence, if_true: down, if_false: same, refuted_if: "Releasing the draft gate leaves the wait unchanged.", revises: null } };
  }
  const h1 = String(last(ctx, "record_hypothesis").hypothesis_id ?? "h-00000000");
  return { name: "record_hypothesis", args: { statement: "The wait is set by payment and clearance timing, not by the summary.", mechanism: "Accounts settle the bill after the sponsor arrives; departure waits for clearance.", subject_refs: ["st12a", "st13"], competing: [h1], evidence, if_true: same, if_false: down, refuted_if: "Changing summary timing alone shortens the wait.", revises: null } };
}

// The scripted turns for each arm; each turn reads the earlier tool results it needs from the conversation.
function script(arm: Arm, step: number, ctx: Ctx): Call[] | string {
  const ids = () => ({ h1: String(last(ctx, "record_hypothesis", 2).hypothesis_id ?? "h-00000000"), h2: String(last(ctx, "record_hypothesis").hypothesis_id ?? "h-00000000") });
  const proposal = (evidence: Record<string, unknown>): Call => ({ name: "submit_proposal", args: { parent_proposal_id: null, base_version: 1, ops: OPS, scope: { wards: "all", condition: null }, rationale: "Let the summary draft start once the take-home order stage is done, so the nurse verifies it before the clinical discharge and the final check is short.", evidence, expected_effects: [{ metric: "post_signoff_wait_min", direction: "down", subgroup_condition: null }], known_exceptions: [] } });
  if (arm === "prior") {
    if (step === 0) return [{ name: "get_workflow_definition", args: {} }, { name: "get_ward_requirements", args: {} }];
    if (step === 1) return [proposal({ hypothesis_ids: [], experiment_ids: [], event_ids: [] })];
    return "done";
  }
  const reads: Call[][] = [
    [{ name: "list_cases", args: {} }, { name: "get_workflow_definition", args: {} }, { name: "get_ward_requirements", args: {} }],
    [MOCK_CASES.long[0], MOCK_CASES.short].map((c) => ({ name: "get_case_timeline", args: { case_id: c, order: "occurred", limit: 60, kinds: ["step.completed"] } })),
    [{ name: "compute_intervals", args: { case_ids: [...MOCK_CASES.long, MOCK_CASES.short], from: { kind: "step.completed", step_id: "st05" }, to: { kind: "step.completed", step_id: "st16" }, clock: "occurred" } }]
  ];
  if (step < reads.length) return reads[step]!;
  if (step === 3) return [hypothesis(ctx, 1)];
  if (step === 4) return [hypothesis(ctx, 2)];
  const { h1, h2 } = ids();
  const x = String(last(ctx, arm === "a4" ? "get_listed_experiment" : "run_experiment").experiment_id ?? "x-00000000");
  if (arm === "a3") {
    if (step === 5) return [proposal({ hypothesis_ids: [h1], experiment_ids: [], event_ids: [eventOf(ctx, MOCK_CASES.long[0], "st16")] })];
    if (step === 6) return [{ name: "end_session", args: { result: "no_change_warranted", note: "No experiment tool in this session; the proposal stands as submitted.", evidence_event_ids: [eventOf(ctx, MOCK_CASES.long[0], "st16")] } }];
    return "done";
  }
  if (step === 5) return arm === "a4" ? [{ name: "get_listed_experiment", args: {} }] : [{ name: "run_experiment", args: { hypothesis_id: h1, distinguishes: [h2], base: { version: 1 }, ops: OPS, case_ids: [...MOCK_CASES.long, MOCK_CASES.short], note: "release the draft gate" } }];
  if (step === 6) return [{ name: "set_hypothesis_status", args: { hypothesis_id: h1, status: "retained", experiment_ids: [x], evidence_event_ids: [], note: "wait fell in all three" } }, { name: "set_hypothesis_status", args: { hypothesis_id: h2, status: "rejected", experiment_ids: [x], evidence_event_ids: [], note: "the summary timing alone moved the wait" } }];
  if (step === 7) return [proposal({ hypothesis_ids: [h1], experiment_ids: [x], event_ids: [eventOf(ctx, MOCK_CASES.long[0], "st16")] })];
  if (step === 8) return [{ name: "get_validation_report", args: { proposal_id: String(last(ctx, "submit_proposal").proposal_id ?? "p-00000000") } }];
  return "done";
}

// The planted change's hypothesis pair with the cycle's ledger fields, citing ranking examples from the derived statistics.
function cycleHypotheses(ctx: Ctx): Call[] {
  const ranking = ((last(ctx, "get_derived_statistics").ranking ?? []) as { example_events: { event_id: string; case_id: string }[] }[]).flatMap((r) => r.example_events);
  const two = ranking.filter((e, i) => ranking.findIndex((x) => x.case_id === e.case_id) === i).slice(0, 2);
  const evidence = [...two, ...ranking.filter((e) => !two.includes(e)).slice(0, 1)].map((e, i) => ({ ...e, stance: i === 0 ? "supports" : "context", note: "critical segment" }));
  const [a, b, c] = MOCK_CASES.long;
  const down = { metric: "post_signoff_wait_min", comparison: "intervention_lt_control", tolerance_min: 30, scope: { cases: [a, b, c] } };
  const same = { metric: "post_signoff_wait_min", comparison: "no_difference", tolerance_min: 10, scope: { cases: [a, b, c] } };
  const fields = { predicted_magnitude_min: 60, falsifying_experiment: "Release the draft and the wait stays.", if_null: "The wait is set elsewhere." };
  return [
    { name: "record_hypothesis", args: { statement: "Summary work starts only after the clinical discharge.", mechanism: "The draft is gated on the clinical discharge.", subject_refs: ["st06"], competing: { none_identified_reason: "first reading" }, evidence, if_true: down, if_false: same, refuted_if: "The wait does not fall.", revises: null, ...fields } },
    { name: "record_hypothesis", args: { statement: "Payment timing sets the wait.", mechanism: "Clearance waits for the sponsor.", subject_refs: ["st13"], competing: { none_identified_reason: "second reading" }, evidence, if_true: same, if_false: down, refuted_if: "The summary change alone cuts the wait.", revises: null, ...fields } }
  ];
}

// The scripted turns of the investigation cycle, keyed by the stage message and the turn within it.
function cycleScript(messages: Msg[], ctx: Ctx): Call[] | string {
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user" && String(messages[i]!.content ?? "").startsWith("Stage: ")) { at = i; break; }
  const stage = at >= 0 ? String(messages[at]!.content).slice(7).split(",")[0]! : "";
  const turn = messages.slice(at + 1).filter((m) => m.role === "assistant").length;
  const ids = ctx.results.filter((r) => r.name === "record_hypothesis" && r.value.ok === true).map((r) => String(r.value.hypothesis_id));
  const [h1, h2] = [ids.at(-2) ?? "h-00000000", ids.at(-1) ?? "h-00000000"];
  if (stage === "observe" && turn === 0) return [{ name: "get_derived_statistics", args: {} }, { name: "get_workflow_definition", args: {} }];
  if (stage === "observe" && turn === 1) return cycleHypotheses(ctx);
  if (stage === "observe" && turn === 2) return [{ name: "choose_question", args: { hypothesis_ids: [h1, h2], question: "Does releasing the draft cut the wait?", expected_change: { step: "st06", behaviour: "start_time" } } }];
  if (stage.startsWith("construct")) return [{ name: "run_experiment", args: { hypothesis_id: h1, distinguishes: [h2], base: { version: 1 }, ops: OPS, case_ids: [...MOCK_CASES.long, MOCK_CASES.short], note: "release the draft", expected_change: { step: "st06", behaviour: "start_time" } } }];
  const x = String(ctx.results.filter((r) => r.name === "run_experiment" && r.value.ok === true).at(-1)?.value.experiment_id ?? "x-00000000");
  if (stage === "interpret" && turn === 0) return [{ name: "set_hypothesis_status", args: { hypothesis_id: h1, status: "retained", experiment_ids: [x], evidence_event_ids: [], note: "wait fell" } }, { name: "set_hypothesis_status", args: { hypothesis_id: h2, status: "rejected", experiment_ids: [x], evidence_event_ids: [], note: "summary change moved it" } }];
  if (stage === "interpret" && turn === 1) return [{ name: "submit_proposal", args: { parent_proposal_id: null, base_version: 1, ops: OPS, scope: { wards: "all", condition: null }, rationale: "Release the summary draft once the take-home order stage is done.", evidence: { hypothesis_ids: [h1], experiment_ids: [x], event_ids: [] }, expected_effects: [{ metric: "post_signoff_wait_min", direction: "down", subgroup_condition: null }], known_exceptions: [] } }];
  return "done";
}

// A deterministic investigator that drives every tool through the real dispatcher, for mock mode and tests.
export function scriptedInvestigator(arm: Arm): MockResponder {
  return ({ body, hash }) => {
    const messages = (body.messages ?? []) as Msg[];
    const step = messages.filter((m) => m.role === "assistant").length;
    const cycle = arm === "adaptive" && messages.some((m) => m.role === "user" && String(m.content ?? "").startsWith("Stage: "));
    const out = cycle ? cycleScript(messages, results(messages)) : script(arm, step, results(messages));
    const message = typeof out === "string"
      ? { role: "assistant" as const, content: out, refusal: null }
      : { role: "assistant" as const, content: null, refusal: null, tool_calls: out.map((c, i) => ({ id: `call_${step}_${i}`, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
    const completion: ChatCompletion = { id: `mock-${hash.slice(0, 12)}`, object: "chat.completion", created: 0, model: String(body.model), choices: [{ index: 0, message, finish_reason: typeof out === "string" ? "stop" : "tool_calls", logprobs: null }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    return completion;
  };
}
