import { loadV1 } from "@hey-pisgah/hospital";
import { createModelClient, type MockResponder } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { describe, expect, it } from "vitest";
import { cycle2Result, cycleResponse } from "../src/claims-results.js";
import { runCycleLoop } from "../src/cycle.js";
import { outcomeComparison, reverseOutcomes } from "../src/outcomes.js";
import { DiscoveryPool, loadObserved } from "../src/pool.js";
import { appTexts } from "../src/prompts.js";
import { denyScan } from "../src/deny.js";
import { Session, sessionStreamId } from "../src/session.js";
import { dispatch } from "../src/tools.js";
import { hyp, tempRoot } from "./helpers.js";

const OUTCOMES = loadObserved(new URL("../fixtures/outcomes/adopted-v2.json", import.meta.url).pathname);
const OBSERVED = loadObserved(new URL("../../../evaluation/results/observed-cases.json", import.meta.url).pathname);
const histories = new DiscoveryPool();
const pool = (outcomes = OUTCOMES) => new DiscoveryPool(undefined, outcomes, OBSERVED);
const second = (p = pool(), runId = "run-c2a00001") => new Session({ storeRoot: tempRoot(), runId, arm: "adaptive", cycle: 2, pool: p, insufficientEvidence: true, now: () => new Date("2026-10-30T09:00:00Z") });
const historyEvent = () => histories.get(histories.ids()[0]!)!.events.find((e) => e.kind === "step.completed")!.event_id;
const insufficient = { missing_measurement: "outcomes on more ward A cases under the version", distinguishes: [] as string[], why_it_matters: "one case cannot separate the version from the case" };

describe("the second cycle reads the new outcomes first", () => {
  it("lists the verified outcomes, then the observed journeys, before the histories", () => {
    const rows = (second().listCases().cases as { source: string; case_id: string; workflow_version?: number | null }[]);
    expect(rows.slice(0, 2).map((r) => [r.source, r.workflow_version])).toEqual([["outcome", 2], ["outcome", 1]]);
    expect(rows.slice(2, 2 + OBSERVED.length).every((r) => r.source === "observed")).toBe(true);
    expect(rows.slice(2 + OBSERVED.length).every((r) => r.source === "history")).toBe(true);
  });

  it("refuses a result or a proposal until compare_outcomes has read them (the review: 0 of 2 outcomes read)", async () => {
    const s = second();
    const ev = historyEvent();
    expect(s.endSession({ result: "no_change_warranted", note: "n", evidence_event_ids: [ev] })).toMatchObject({ ok: false, error: "read_outcomes_first" });
    expect(await s.submitProposal({})).toMatchObject({ ok: false, error: "read_outcomes_first" });
    const c = s.compareOutcomes() as Record<string, unknown> & ReturnType<typeof outcomeComparison>;
    expect(c.ok).toBe(true);
    expect(c.read_case_ids.length).toBe(OUTCOMES.length + OBSERVED.length);
    expect(s.endSession({ result: "no_change_warranted", note: "n", evidence_event_ids: [ev] })).toMatchObject({ ok: true });
    s.close();
  });

  it("compares the outcomes before and after adoption explicitly: the ward A case under version 2 waited less than ward A's histories", () => {
    const c = outcomeComparison(pool(), loadV1());
    const a = c.after.find((r) => r.ward_id === "A")!;
    expect(a).toMatchObject({ workflow_version: 2, post_signoff_wait_min: 57, direction: "better" });
    expect(a.wait_delta_min).toBeLessThan(0);
    expect(c.after.find((r) => r.ward_id === "B")).toMatchObject({ workflow_version: 1, post_signoff_wait_min: 91 });
    expect(c).toMatchObject({ supports_adopted: true, contradicts_adopted: false });
    expect(c.observed).toHaveLength(OBSERVED.length);
  });

  it("answers reversed evidence: with the histories kept and the outcomes turned around, no change is refused and insufficient evidence or a proposal is the answer", async () => {
    const reversed = reverseOutcomes(OUTCOMES, histories, loadV1());
    const c = outcomeComparison(pool(reversed), loadV1());
    expect(c.after.find((r) => r.ward_id === "A")).toMatchObject({ workflow_version: 2, direction: "worse" });
    expect(c.contradicts_adopted).toBe(true);
    const storeRoot = tempRoot();
    const s = new Session({ storeRoot, runId: "run-c2a00004", arm: "adaptive", cycle: 2, pool: pool(reversed), insufficientEvidence: true, now: () => new Date("2026-10-30T09:00:00Z") });
    s.compareOutcomes();
    const ev = historyEvent();
    expect(s.endSession({ result: "no_change_warranted", note: "the version holds", evidence_event_ids: [ev] })).toMatchObject({ ok: false, error: "outcomes_contradict" });
    // A proposal that does not cite the outcomes it answers is refused before anything else is checked.
    expect(await s.submitProposal({ parent_proposal_id: null, base_version: 1, ops: [{ op: "remove_soft_edge", edge_id: "e04" }], scope: { wards: "all", condition: null }, rationale: "r", evidence: { hypothesis_ids: [], experiment_ids: [], event_ids: [ev] }, expected_effects: [], known_exceptions: [], trade_offs: [] })).toMatchObject({ ok: false, error: "outcomes_contradict" });
    const ids = [hyp(s), hyp(s)];
    expect(s.endSession({ result: "insufficient_evidence", note: "one reversed case", evidence_event_ids: [ev], insufficient: { ...insufficient, distinguishes: ids } })).toMatchObject({ ok: true, result: "insufficient_evidence" });
    s.close();
    // The pair report reads that as a response to the reversed outcomes, never as a required reversal.
    const adoptedOps = [{ op: "remove_soft_edge", edge_id: "e04" }, { op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st01" } } }];
    expect(cycleResponse(storeRoot, "run-c2a00004", { observed: OBSERVED, outcomes: reversed, adoptedOps })).toMatchObject({ response: "insufficient_evidence", outcomes_contradict_adopted: true, compared_outcomes: true });
  });

  it("offers compare_outcomes only in a second cycle, counts its reads in the cycle-2 result, and keeps the texts clean", async () => {
    const storeRoot = tempRoot();
    const bodies: Record<string, unknown>[] = [];
    let step = 0;
    const reply = (body: Record<string, unknown>, name: string, args: unknown) => ({ id: "m", object: "chat.completion" as const, created: 0, model: String(body.model), choices: [{ index: 0, message: { role: "assistant" as const, content: null, refusal: null, tool_calls: [{ id: `c${step}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" as const, logprobs: null }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    const reads = ["list_cases", "get_ward_requirements", "get_workflow_definition", "get_derived_statistics"];
    let compared = false;
    const names = (b: Record<string, unknown>) => ((b.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
    // Reads the histories first, tries to end before the outcomes, then reads them and ends.
    const mock: MockResponder = (r) => {
      bodies.push(r.body);
      step += 1;
      const offered = names(r.body);
      if (!offered.includes("end_session")) return reply(r.body, reads[(step - 1) % reads.length]!, {});
      if (!compared && offered.includes("compare_outcomes")) { compared = true; return reply(r.body, "compare_outcomes", {}); }
      return reply(r.body, "end_session", { result: "no_change_warranted", note: compared ? "the adopted version did better on its ward" : `early ${step}`, evidence_event_ids: [historyEvent()] });
    };
    const client = createModelClient({ storeRoot, mode: "mock", budget: { runUsd: 100, runMaxCalls: 20, weekUsd: 1e6, weekStopFraction: 1, weekSince: () => new Date(0) }, mock });
    const session = new Session({ storeRoot, runId: "run-c2a00002", arm: "adaptive", cycle: 2, pool: pool(), insufficientEvidence: true });
    const out = await runCycleLoop({ client, session, maxCalls: 20, budgetUsd: 1, effort: "medium", sleep: async () => {} });
    session.close();
    client.close();
    expect(out.stop).toBe("declared_negative");
    expect(names(bodies[0]!)).toContain("compare_outcomes");
    const log = readStream(storeRoot, sessionStreamId("run-c2a00002"));
    const calls = log.filter((e) => e.record_type === "tool.called").map((e) => [(e.payload as { name: string }).name, (e.payload as { error: string | null }).error]).filter(([n]) => n === "end_session" || n === "compare_outcomes");
    expect(calls[0]).toEqual(["end_session", "read_outcomes_first"]);
    expect(calls.slice(-2)).toEqual([["compare_outcomes", null], ["end_session", null]]);
    const r = cycle2Result(storeRoot, "run-c2a00002", { observed: OBSERVED, outcomes: OUTCOMES }) as { read: { outcomes: number; observed: number }; outcome_comparison: { supports_adopted: boolean } };
    expect(r.read).toMatchObject({ outcomes: 2, observed: OBSERVED.length });
    expect(r.outcome_comparison.supports_adopted).toBe(true);
    // A first cycle never sees the tool.
    const first = new Session({ storeRoot: tempRoot(), runId: "run-c1a00003", arm: "adaptive", pool: histories });
    expect(await dispatch(first, "compare_outcomes", "{}")).toMatchObject({ ok: false, error: "not_available" });
    first.close();
    expect(denyScan(appTexts("adaptive"))).toEqual([]);
  });
});
