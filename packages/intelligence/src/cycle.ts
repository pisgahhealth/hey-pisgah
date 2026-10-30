import { ExperimentBudget, hashJson, sha256 } from "@hey-pisgah/contracts";
import { ModelError, type ChatMessage } from "@hey-pisgah/model";
import { definitionDigest, resultDigest } from "./digest.js";
import { REPEAT_LIMIT, SETTINGS, compact, type Digests, type LoopOptions, type LoopOutcome } from "./loop.js";
import { CYCLE_CLOSED, LEDGER_HEADER, NUDGE, PROPOSE_NOTE, REPEAT_NOTE, STAGES, armHashes, fill, kickoff, systemPrompt } from "./prompts.js";
import { armTools, dispatch, toolDefs } from "./tools.js";

export type Stage = keyof typeof STAGES;

// Turns each stage allows before the controller moves on, and the cycle cap; these are the cycle's transitions, not read or hypothesis budgets.
export const CYCLE = { turns: { prior: 4, observe: 4, decide: 3, construct: 3, interpret: 2, declare: 2 }, max_cycles: 10 } as const;
// A second cycle keeps room for this many calls at the most a call has cost, so it can still declare a result before the cap.
export const DECLARE_RESERVE_CALLS = 4;

const READS = ["list_cases", "get_derived_statistics", "get_case_timeline", "get_record", "compute_intervals", "get_queue_snapshot", "get_staff_activity", "get_ward_requirements", "get_workflow_definition"];
// The tools the controller offers in each stage; the model never sees the others.
export const STAGE_TOOLS: Record<Stage, readonly string[]> = {
  prior: ["get_workflow_definition", "get_ward_requirements", "list_cases", "get_derived_statistics", "record_hypothesis", "choose_question"],
  observe: [...READS, "record_hypothesis", "set_hypothesis_status", "choose_question", "list_ledger", "end_session"],
  decide: ["record_hypothesis", "choose_question", "end_session"],
  construct: ["get_workflow_definition", "list_cases", "get_precondition_table", "run_sweep", "run_experiment"],
  interpret: ["get_experiment", "set_hypothesis_status", "record_hypothesis", "submit_proposal", "get_validation_report", "list_ledger", "next_cycle", "end_session"],
  declare: ["compare_outcomes", "submit_proposal", "propose_rollback", "end_session"]
};

// Added to these stages only in a second cycle whose pool holds outcomes or observed journeys.
export const SECOND_CYCLE_TOOLS: Partial<Record<Stage, readonly string[]>> = { prior: ["compare_outcomes"], observe: ["compare_outcomes", "propose_rollback"], decide: ["propose_rollback"], interpret: ["propose_rollback"] };

export type CycleOptions = LoopOptions & { effort: "low" | "medium" | "high" | "xhigh" };

function casesOf(args: string): string[] {
  try {
    const a = JSON.parse(args || "{}") as { case_id?: unknown; case_ids?: unknown };
    return [...(typeof a.case_id === "string" ? [a.case_id] : []), ...(Array.isArray(a.case_ids) ? a.case_ids.filter((x): x is string => typeof x === "string") : [])];
  } catch { return []; }
}
function callKey(name: string, args: string): string {
  try { return `${name} ${hashJson(JSON.parse(args || "{}"))}`; } catch { return `${name} ${args}`; }
}

// The investigation cycle: observe, construct and run, interpret; the controller owns the stage, its tools and the fresh conversation of each cycle, and the ledger carries forward.
export async function runCycleLoop(o: CycleOptions): Promise<LoopOutcome> {
  const s = o.session;
  if (s.o.arm !== "adaptive") throw new Error("the investigation cycle runs the adaptive arm only");
  const provider = o.provider ?? SETTINGS.provider;
  const model = o.model ?? SETTINGS.model;
  const system: ChatMessage = { role: "system", content: systemPrompt("adaptive") };
  const kick: ChatMessage = { role: "user", content: kickoff("adaptive", { cases: s.pool.ids().length, calls: o.maxCalls, usd: o.budgetUsd, proposals: ExperimentBudget.proposals, cycle: s.o.cycle ?? 1 }) };
  s.log("session.opened", { run_id: s.runId, arm: "adaptive", controller: "cycle", cycle_settings: CYCLE, stage_tools: STAGE_TOOLS, cycle: s.o.cycle ?? 1, mode: o.client.mode, provider, model, settings: SETTINGS, effort: o.effort, max_calls: o.maxCalls, budget_usd: o.budgetUsd, hashes: armHashes("adaptive"), commitment: o.commitment ?? null, insufficient_evidence: s.o.insufficientEvidence ?? false, system_prompt: system.content, kickoff: kick.content });
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let stop: { reason: string; detail: string } | null = null;
  let turns = 0;
  let maxCost = 0;
  let repeats = 0;
  let definitionSeen = false;
  const arm = new Set<string>(armTools("adaptive"));
  // submit_proposal is offered in interpret only once a delivered experiment made the primary metric better on the cases it moved.
  const offered = (st: Stage) => new Set([...STAGE_TOOLS[st], ...(s.hasNewEvidence() ? SECOND_CYCLE_TOOLS[st] ?? [] : [])].filter((t) => arm.has(t) && (t !== "submit_proposal" || s.improvedExperiments().length > 0)));
  // Entered once in a second cycle when the budget reserve is reached; its turns end in a declared result or a recorded no_result.
  let declaring = false;

  for (s.cycle = 0; !stop && s.cycle < CYCLE.max_cycles; s.cycle++) {
    s.question = null;
    s.cycleClosed = false;
    const at: { stage: Stage } = { stage: s.cycle === 0 ? "prior" : s.counters.experiments_used >= ExperimentBudget.experiments ? "interpret" : "observe" };
    const ledgerText = `${fill(LEDGER_HEADER, { cycle: s.cycle })}\n${JSON.stringify(s.ledger())}${definitionSeen ? `\n${JSON.stringify(definitionDigest(s.base))}` : ""}`;
    const messages: ChatMessage[] = [system, kick, { role: "user", content: ledgerText }];
    const digests: Digests = new Map();
    let stageTurns = 0;
    let idle = 0;
    let previous: string | null = null;
    let experimentAtStage = s.experiments.size;
    let lastExperiment = "none";
    const enter = (st: Stage) => {
      at.stage = st;
      stageTurns = 0;
      experimentAtStage = s.experiments.size;
      const tools = [...offered(st)];
      const improved = st === "interpret" ? s.improvedExperiments() : [];
      const note = improved.length ? `\n${fill(PROPOSE_NOTE, { side_effects: JSON.stringify(improved) })}` : "";
      messages.push({ role: "user", content: `${fill(STAGES[st], { cycle: s.cycle, turns: CYCLE.turns[st], tools: tools.join(", "), question: s.question?.question ?? "", hypotheses: s.question?.hypothesis_ids.join(", ") ?? "", expected: s.question ? `${s.question.expected_change.step} ${s.question.expected_change.behaviour}` : "", experiment: lastExperiment })}${note}` });
      s.log("stage.entered", { cycle: s.cycle, stage: st, turn: turns, tools });
    };
    s.log("cycle.opened", { cycle: s.cycle, ledger_hash: sha256(ledgerText), ledger_chars: ledgerText.length });
    enter(at.stage);
    let closed: string | null = null;
    while (!stop && !closed) {
      if (s.stop) { stop = { reason: s.stop.reason, detail: s.stop.detail }; break; }
      const u = o.client.runUsage(s.runId);
      if (!declaring && s.hasNewEvidence() && turns > 0 && ((maxCost > 0 && u.usd + DECLARE_RESERVE_CALLS * maxCost > o.budgetUsd) || u.calls + DECLARE_RESERVE_CALLS > o.maxCalls)) {
        declaring = true;
        s.log("declare.entered", { cycle: s.cycle, turn: turns, usd: u.usd, calls: u.calls, reserve_calls: DECLARE_RESERVE_CALLS, max_cost: maxCost });
        enter("declare");
      }
      if (u.calls >= o.maxCalls) { stop = { reason: "budget_calls", detail: `${u.calls} calls` }; break; }
      if (u.usd + maxCost > o.budgetUsd) { stop = { reason: "budget_usd", detail: `${u.usd.toFixed(4)} spent, next call could pass the cap` }; break; }
      const stage: Stage = at.stage;
      s.allowedTools = offered(stage);
      const tools = toolDefs("adaptive", { insufficientEvidence: s.o.insufficientEvidence }, s.allowedTools);
      let res;
      let tries = 0;
      for (;;) {
        try {
          res = await o.client.call({ provider, model, effort: o.effort, messages: compact(messages, SETTINGS.history_chars, digests), tools, parallel_tool_calls: SETTINGS.parallel_tool_calls, max_completion_tokens: SETTINGS.max_completion_tokens, purpose: "propose_experiment", run_id: s.runId, task_id: null, task_state: null, thread: "main", affinity_key: s.runId });
          break;
        } catch (e) {
          if (e instanceof ModelError && e.code === "budget_exhausted") { stop = { reason: "budget_exhausted", detail: String(e.detail.scope ?? "") }; break; }
          if (e instanceof ModelError && e.code === "provider_error" && tries === 0) { tries += 1; s.log("model.retry", { turn: turns, status: e.detail.status ?? null }); await sleep(5000); continue; }
          if (e instanceof ModelError) { stop = { reason: e.code, detail: e.message.slice(0, 200) }; break; }
          throw e;
        }
      }
      if (!res) break;
      turns += 1;
      stageTurns += 1;
      maxCost = Math.max(maxCost, res.row.cost_usd);
      const msg = res.completion.choices[0]?.message;
      const calls = (msg?.tool_calls ?? []).flatMap((c) => (c.type === "function" ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments ?? "" }] : []));
      s.log("model.turn", { turn: turns, cycle: s.cycle, stage, response_id: res.row.response_id, finish_reason: res.completion.choices[0]?.finish_reason ?? null, content: (msg?.content ?? "").slice(0, 4000), tool_calls: calls, cost_usd: res.row.cost_usd, prompt_tokens: res.row.prompt_tokens, completion_tokens: res.row.completion_tokens, reasoning_tokens: res.row.reasoning_tokens, latency_ms: res.row.latency_ms, ledger_seq: res.ref.seq });
      if (!calls.length) {
        idle += 1;
        messages.push({ role: "assistant", content: msg?.content ?? "" }, { role: "user", content: NUDGE });
      } else {
        idle = 0;
        messages.push({ role: "assistant", content: msg?.content ?? null, tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) });
        const pageChars = Math.max(2_000, Math.floor(SETTINGS.turn_result_chars / calls.length));
        for (const [i, c] of calls.entries()) {
          const key = callKey(c.name, c.arguments);
          const repeated = key === previous;
          previous = key;
          if (repeated) repeats += 1;
          const result = repeated ? { ok: false, error: "repeated_call", message: REPEAT_NOTE } : await dispatch(s, c.name, c.arguments, { pageChars, turn: turns });
          if (c.name === "get_workflow_definition" && result.ok !== false) definitionSeen = true;
          const text = JSON.stringify(result);
          s.log("tool.called", { turn: turns, cycle: s.cycle, stage, index: i, call_id: c.id, name: c.name, args: c.arguments.slice(0, 8000), args_hash: sha256(c.arguments), result_hash: sha256(text), ok: result.ok !== false, error: result.ok === false ? String(result.error) : null, result: text.slice(0, 30_000) });
          const short = resultDigest(c.name, result, s.base);
          digests.set(c.id, { name: c.name, digest: short ? JSON.stringify(short) : null, cases: casesOf(c.arguments) });
          messages.push({ role: "tool", tool_call_id: c.id, content: text });
          if (c.name === "run_experiment" && (result.ok === true || result.error === "experiment_aborted")) lastExperiment = String(result.experiment_id);
        }
        if (repeats >= REPEAT_LIMIT && !s.stop) s.stall(repeats);
      }
      if (s.stop) continue;
      const spent = stageTurns >= CYCLE.turns[stage] || idle >= 2;
      if (stage === "declare") { if (spent) stop = { reason: "no_result_declared", detail: `${stageTurns} declare turns without a result` }; continue; }
      if ((stage === "prior" || stage === "observe" || stage === "decide") && s.question) {
        if (s.counters.experiments_used >= ExperimentBudget.experiments) enter("interpret"); else enter("construct");
      } else if (stage === "construct" && s.experiments.size > experimentAtStage) enter("interpret");
      else if (stage === "interpret" && s.cycleClosed) closed = "closed by the investigator";
      else if (spent) {
        if (stage === "prior" || stage === "observe") enter("decide");
        else if (stage === "decide") closed = "no question was chosen";
        else if (stage === "construct") closed = "no experiment ran";
        else closed = "the interpret stage ended";
      }
    }
    if (closed) { s.observe(fill(CYCLE_CLOSED, { reason: `cycle ${s.cycle}, ${closed}` })); s.log("cycle.closed", { cycle: s.cycle, reason: closed, turn: turns }); }
  }
  if (!stop) stop = s.stop ? { reason: s.stop.reason, detail: s.stop.detail } : { reason: "cycles_exhausted", detail: `${CYCLE.max_cycles} cycles` };
  s.allowedTools = null;
  const u = o.client.runUsage(s.runId);
  const out: LoopOutcome = { stop: stop.reason, detail: stop.detail, calls: u.calls, usd: Math.round(u.usd * 1e6) / 1e6, turns };
  s.log("session.stopped", { ...out, counters: s.counters, repeated_calls: repeats, cycles: s.cycle, hypotheses: s.hypotheses.size, experiments: s.experiments.size, proposals: [...s.proposals.keys()] });
  return out;
}
