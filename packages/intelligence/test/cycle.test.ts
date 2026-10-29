import { loadV1, worldRules } from "@hey-pisgah/hospital";
import { createModelClient, type MockResponder } from "@hey-pisgah/model";
import { eventLogHash, runDefinition } from "@hey-pisgah/simulator";
import { openStream, readStream } from "@hey-pisgah/store";
import { applyOperations, isPreparingStep } from "@hey-pisgah/workflow";
import { describe, expect, it } from "vitest";
import { CYCLE, STAGE_TOOLS, runCycleLoop } from "../src/cycle.js";
import { denyScan } from "../src/deny.js";
import { scriptedInvestigator } from "../src/mock.js";
import { isStaticNoop, preconditionTable, ruleChanges } from "../src/preconditions.js";
import { STAGES, appTexts } from "../src/prompts.js";
import { STREAMS, Session, sessionStreamId } from "../src/session.js";
import { criticalPath, derivedStatistics } from "../src/stats.js";
import { dispatch } from "../src/tools.js";
import { LONG, pool, tempRoot } from "./helpers.js";

const budget = { runUsd: 100, runMaxCalls: 200, weekUsd: 1e6, weekStopFraction: 1, weekSince: () => new Date(0) };
const reply = (body: Record<string, unknown>, calls: [string, unknown][], content: string | null = null) => ({ id: "m", object: "chat.completion" as const, created: 0, model: String(body.model), choices: [{ index: 0, message: { role: "assistant" as const, content, refusal: null, ...(calls.length ? { tool_calls: calls.map(([name, args], i) => ({ id: `c${Math.random().toString(16).slice(2, 8)}_${i}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } })) } : {}) }, finish_reason: calls.length ? "tool_calls" as const : "stop" as const, logprobs: null }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });

const fakeValidate = async (root: string) => {
  const out = openStream(root, STREAMS.validations, { writer: true });
  for (const p of readStream(root, STREAMS.proposals)) out.append("validation.completed", { proposal_ref: { stream_id: p.stream_id, seq: p.seq }, report: { proposal_id: (p.payload as { proposal_id: string }).proposal_id, status: "dev_validated", hashes: {} } }, { recorded_at: 0, occurred_at: 0 });
  out.close();
};

async function run(mock: MockResponder, maxCalls = 40) {
  const storeRoot = tempRoot();
  const bodies: Record<string, unknown>[] = [];
  const client = createModelClient({ storeRoot, mode: "mock", budget, mock: (r) => { bodies.push(r.body); return mock(r); } });
  const session = new Session({ storeRoot, runId: "run-cyc1e000", arm: "adaptive", pool: pool(), validate: fakeValidate });
  const out = await runCycleLoop({ client, session, maxCalls, budgetUsd: 1, effort: "high", sleep: async () => {} });
  session.close();
  client.close();
  const log = readStream(storeRoot, sessionStreamId("run-cyc1e000"));
  return { out, bodies, log, session };
}

const toolNames = (b: Record<string, unknown>) => ((b.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name).sort();
const msgs = (b: Record<string, unknown>) => b.messages as { role: string; content: string }[];

describe("the investigation cycle", () => {
  it("opens with the prior as hypothesis one, offers each stage's tools only, and reaches a dev-valid proposal in mock mode", async () => {
    const r = await run(scriptedInvestigator("adaptive"));
    expect(r.out.stop).toBe("dev_valid_proposal");
    const stages = r.log.filter((e) => e.record_type === "stage.entered").map((e) => (e.payload as { stage: string }).stage);
    expect(stages.slice(0, 3)).toEqual(["prior", "construct", "interpret"]);
    expect(toolNames(r.bodies[0]!)).toEqual([...STAGE_TOOLS.prior].sort());
    const construct = r.bodies.find((b) => msgs(b).at(-1)!.content.startsWith("Stage: construct"))!;
    expect(toolNames(construct)).toEqual(["get_precondition_table", "get_workflow_definition", "list_cases", "run_experiment", "run_sweep"]);
    expect(msgs(r.bodies[0]!).map((m) => m.role)).toEqual(["system", "user", "user", "user"]);
    expect(msgs(r.bodies[0]!)[3]!.content.startsWith("Stage: observe, cycle 0. Start from what you would propose without the records")).toBe(true);
  });

  it("stays in construct after a refused request and moves to interpret only once an experiment ran", async () => {
    const inner = scriptedInvestigator("adaptive");
    let bad = true;
    const mock: MockResponder = (r) => {
      const m = r.body.messages as { role: string; content: string }[];
      if (bad && String(m.at(-1)?.content ?? "").startsWith("Stage: construct")) {
        bad = false;
        return reply(r.body, [["run_experiment", { hypothesis_id: "h-00000000", distinguishes: [], base: { version: 1 }, ops: [{ op: "remove_soft_edge", edge_id: "e04" }], case_ids: [LONG[0]], note: "n", expected_change: { step: "st06", behaviour: "start_time" } }]]);
      }
      return inner(r);
    };
    const r = await run(mock);
    expect(r.out.stop).toBe("dev_valid_proposal");
    const entered = r.log.filter((e) => e.record_type === "stage.entered").map((e) => e.payload as { stage: string; turn: number });
    const c = entered.find((e) => e.stage === "construct")!, i = entered.find((e) => e.stage === "interpret")!;
    expect(i.turn - c.turn).toBe(2);
  });

  it("refuses a tool outside the stage, as data", async () => {
    const s = new Session({ storeRoot: tempRoot(), runId: "run-cyc1e001", arm: "adaptive", pool: pool() });
    s.allowedTools = new Set(STAGE_TOOLS.decide);
    const r = await dispatch(s, "get_case_timeline", JSON.stringify({ case_id: LONG[0], order: "occurred" }));
    expect(r).toMatchObject({ ok: false, error: "not_in_this_stage" });
    expect(s.counters.stage_refusals).toBe(1);
    s.close();
  });

  it("moves on when a stage's turns are spent, opens each cycle with a fresh conversation, and carries the ledger the session filled", async () => {
    let n = 0;
    const reads: MockResponder = ({ body }) => { n += 1; return reply(body, n % 2 ? [["list_cases", {}]] : [["get_derived_statistics", { top: 3 }]]); };
    const r = await run(reads, 12);
    expect(r.out.stop).toBe("budget_calls");
    const stages = r.log.filter((e) => e.record_type === "stage.entered").map((e) => e.payload as { stage: string; cycle: number });
    expect(stages.map((x) => `${x.cycle}:${x.stage}`).slice(0, 4)).toEqual(["0:prior", "0:decide", "1:observe", "1:decide"]);
    expect(r.log.filter((e) => e.record_type === "cycle.closed").map((e) => (e.payload as { reason: string }).reason)[0]).toBe("no question was chosen");
    const firstOfCycle1 = r.bodies[CYCLE.turns.prior + CYCLE.turns.decide]!;
    expect(msgs(firstOfCycle1).length).toBe(4);
    const ledger = JSON.parse(msgs(firstOfCycle1)[2]!.content.split("\n")[1]!) as { cycle: number; observations: string[] };
    expect(ledger.cycle).toBe(1);
    expect(ledger.observations.some((o) => o.startsWith("statistics: top segments"))).toBe(true);
    expect(ledger.observations.some((o) => o.includes("no question was chosen"))).toBe(true);
    const notes = r.log.filter((e) => e.record_type === "note.recorded").length;
    expect(notes).toBe(0);
  });

  it("keeps the ledger's experiment receipt across cycles with no note written", async () => {
    const r = await run(scriptedInvestigator("adaptive"));
    const obs = r.log.filter((e) => e.record_type === "ledger.observation").map((e) => String((e.payload as { line: string }).line));
    expect(obs.some((l) => /st06 start_time moved in \d of 4; delivered_outcome_better/.test(l)), obs.join("\n")).toBe(true);
  });

  it("states every stage, the ledger header and the precondition table with no denied term", () => {
    expect(denyScan(appTexts("adaptive"))).toEqual([]);
    expect(denyScan([{ label: "table", text: JSON.stringify(preconditionTable()) }, { label: "stages", text: JSON.stringify(STAGES) }])).toEqual([]);
  });
});

describe("derived statistics", () => {
  it("walk the critical path from departure back to the sign-off", () => {
    const p = criticalPath(loadV1(), pool().get(LONG[0])!.events);
    expect(p.path.map((s) => `${s.from}>${s.to}`)).toEqual(["null>st05", "st05>st06", "st06>st07", "st07>st08", "st08>st14", "st14>st16"]);
  });

  it("record the well-posedness finding: the summary chain is the third critical segment, behind two that end on steps no operation may target", () => {
    const st = derivedStatistics(loadV1(), pool().ids().map((id) => pool().get(id)!));
    const ranking = st.ranking as { segment: string; cases: number }[];
    expect(ranking.slice(0, 4).map((r) => r.segment)).toEqual(["st04>st15", "st02>st03", "st05>st06", "st07>st08"]);
    expect(ranking[2]!.cases).toBe(3);
  });
});

describe("the static no-op test against the engine", () => {
  it("never calls a change a no-op when the engine runs it differently, over every edge removal, trigger and move on the pool", () => {
    const base = loadV1();
    const world = worldRules();
    const targets = base.steps.filter((s) => !s.external && isPreparingStep(s)).map((s) => s.step_id);
    const ops: unknown[] = [
      ...base.edges.filter((e) => e.kind === "soft").map((e) => ({ op: "remove_soft_edge", edge_id: e.edge_id })),
      ...targets.flatMap((t) => base.steps.filter((s) => s.step_id !== t).flatMap((s) => [{ op: "set_prep_trigger", target: { step: t }, when: { after: { step: s.step_id } } }, { op: "move_step_after", step: { step: t }, after: { step: s.step_id }, gate: "start" }]))
    ];
    const files = pool().ids().map((id) => pool().experimentable(id)!);
    const control = files.map((f) => eventLogHash((runDefinition(base, f.schedule, { world, run_id: "run-11111111" }) as unknown as { events: never[] }).events));
    let noops = 0;
    for (const op of ops) {
      const r = applyOperations(base, [op], { caseFacts: pool().caseFacts() });
      if (!r.ok || !isStaticNoop(ruleChanges(base, r.definition), false)) continue;
      noops += 1;
      files.forEach((f, i) => expect(eventLogHash((runDefinition(r.definition, f.schedule, { world, run_id: "run-11111111" }) as unknown as { events: never[] }).events)).toBe(control[i]));
    }
    expect(noops).toBeGreaterThan(5);
  });
});
