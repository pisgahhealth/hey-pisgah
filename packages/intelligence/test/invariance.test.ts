import { createModelClient, type MockResponder } from "@hey-pisgah/model";
import { describe, expect, it } from "vitest";
import { STAGE_TOOLS, runCycleLoop } from "../src/cycle.js";
import { denyScan } from "../src/deny.js";
import { STAGES, appTexts } from "../src/prompts.js";
import { Session } from "../src/session.js";
import { SWEEP_RULE } from "../src/sweep.js";
import { dispatch, toolDefs } from "../src/tools.js";
import { VARIANTS, loadVariant } from "../src/variants.js";
import { tempRoot } from "./helpers.js";

const budget = { runUsd: 100, runMaxCalls: 200, weekUsd: 1e6, weekStopFraction: 1, weekSince: () => new Date(0) };
const quiet: MockResponder = ({ body }) => ({ id: "m", object: "chat.completion", created: 0, model: String(body.model), choices: [{ index: 0, message: { role: "assistant", content: "x", refusal: null }, finish_reason: "stop", logprobs: null }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });

// Everything the model sees that the app writes, for one variant: the opening request of a run, every stage's tools, and the generated tables.
async function seen(id: (typeof VARIANTS)[number]): Promise<Record<string, string>> {
  const v = loadVariant(id);
  const storeRoot = tempRoot();
  const bodies: Record<string, unknown>[] = [];
  const client = createModelClient({ storeRoot, mode: "mock", budget, mock: (r) => { bodies.push(r.body); return quiet(r); } });
  const s = new Session({ storeRoot, runId: "run-1a7a0000", arm: "adaptive", base: v.base, pool: v.pool });
  await runCycleLoop({ client, session: s, maxCalls: 1, budgetUsd: 1, effort: "high", sleep: async () => {} });
  const table = await dispatch(s, "get_precondition_table", "{}");
  const def = s.definition() as Record<string, unknown>;
  const { definition: _d, allowed_sources: _a, ...registries } = def;
  const stats = s.statistics() as Record<string, unknown>;
  s.close();
  client.close();
  return {
    request: JSON.stringify({ messages: bodies[0]!.messages, tools: bodies[0]!.tools, reasoning_effort: bodies[0]!.reasoning_effort }),
    stage_tools: JSON.stringify(Object.fromEntries(Object.entries(STAGE_TOOLS).map(([k, t]) => [k, toolDefs("adaptive", {}, new Set(t))]))),
    stages: JSON.stringify(STAGES),
    app_texts: JSON.stringify(appTexts("adaptive")),
    precondition_table: JSON.stringify(table),
    registries: JSON.stringify(registries),
    statistics_method: String(stats.note_on_method),
    sweep_rule: JSON.stringify(SWEEP_RULE)
  };
}

describe("answer invariance across simulator variants", () => {
  it("shows the model byte-identical prompts, tool descriptions and generated tables in all three variants", async () => {
    const [a, b, c] = await Promise.all(VARIANTS.map(seen));
    for (const k of Object.keys(a!)) {
      expect(b![k], k).toBe(a![k]);
      expect(c![k], k).toBe(a![k]);
    }
    expect(denyScan(Object.entries(a!).map(([label, text]) => ({ label, text })))).toEqual([]);
  });

  it("plants answers of one, two and three operations on different steps, in worlds that differ", () => {
    const vs = VARIANTS.map(loadVariant);
    expect(vs.map((v) => v.planted.length)).toEqual([1, 2, 3]);
    const steps = vs.map((v) => v.planted_steps);
    for (let i = 0; i < steps.length; i++) for (let j = i + 1; j < steps.length; j++) expect(steps[i]!.some((s) => steps[j]!.includes(s))).toBe(false);
    expect(new Set(vs.map((v) => v.base.definition_hash)).size).toBe(3);
    expect(new Set(vs.map((v) => v.pool.ids().join(","))).size).toBe(3);
    expect(vs.map((v) => v.pool.ids().length)).toEqual([12, 12, 12]);
  });

  it("lets the planted change through the investigator's own experiment tool in every variant, delivered and better", async () => {
    for (const id of VARIANTS) {
      const v = loadVariant(id);
      const s = new Session({ storeRoot: tempRoot(), runId: "run-1a7a0001", arm: "adaptive", base: v.base, pool: v.pool });
      const files = v.pool.ids();
      const ev = (cid: string) => v.pool.get(cid)!.events.find((e) => e.kind === "step.completed")!.event_id;
      const evidence = [{ event_id: ev(files[0]!), case_id: files[0], stance: "context", note: "n" }, { event_id: ev(files[1]!), case_id: files[1], stance: "context", note: "n" }, { event_id: ev(files[2]!), case_id: files[2], stance: "context", note: "n" }];
      const lf = { predicted_magnitude_min: 20, falsifying_experiment: "f", if_null: "n" };
      const scope = { cases: files.slice(0, 6) };
      const h1 = s.recordHypothesis({ ...lf, statement: "s", mechanism: "m", subject_refs: [], competing: { none_identified_reason: "r" }, evidence, if_true: { metric: "post_signoff_wait_min", comparison: "intervention_lt_control", tolerance_min: 10, scope }, if_false: { metric: "post_signoff_wait_min", comparison: "no_difference", tolerance_min: 5, scope }, refuted_if: "r", revises: null });
      const h2 = s.recordHypothesis({ ...lf, statement: "s", mechanism: "m", subject_refs: [], competing: [h1.hypothesis_id], evidence, if_true: { metric: "post_signoff_wait_min", comparison: "no_difference", tolerance_min: 5, scope }, if_false: { metric: "post_signoff_wait_min", comparison: "intervention_lt_control", tolerance_min: 10, scope }, refuted_if: "r", revises: null });
      const x = s.runExperiment({ hypothesis_id: h1.hypothesis_id, distinguishes: [h2.hypothesis_id], base: { version: 1 }, ops: v.planted, case_ids: files.slice(0, 6), note: "planted", expected_change: { step: v.planted_steps[0]!, behaviour: "start_time" } });
      expect(x.ok, `${id} ${JSON.stringify(x).slice(0, 300)}`).toBe(true);
      expect((x.receipt as { outcome: string }).outcome, id).toBe("delivered_outcome_better");
      s.close();
    }
  });
});
