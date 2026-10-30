import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModelClient } from "@hey-pisgah/model";
import { openStream, readStream } from "@hey-pisgah/store";
import { describe, expect, it } from "vitest";
import { runCycleLoop } from "../src/cycle.js";
import { scriptedInvestigator } from "../src/mock.js";
import { publishRuns, runRecord } from "../src/publish.js";
import { STREAMS, Session } from "../src/session.js";
import { pool, tempRoot } from "./helpers.js";

const validate = async (root: string) => {
  const out = openStream(root, STREAMS.validations, { writer: true });
  for (const p of readStream(root, STREAMS.proposals)) out.append("validation.completed", { proposal_ref: { stream_id: p.stream_id, seq: p.seq }, report: { proposal_id: (p.payload as { proposal_id: string }).proposal_id, status: "dev_validated", hashes: {} } }, { recorded_at: 0, occurred_at: 0 });
  out.close();
};

describe("publishing runs", () => {
  it("records each run's outcome, cost and prompt tokens per call, and keeps the evaluator's fields", async () => {
    const storeRoot = tempRoot();
    const client = createModelClient({ storeRoot, mode: "mock", mock: scriptedInvestigator("adaptive"), budget: { runUsd: 1, runMaxCalls: 40, weekUsd: 120, weekStopFraction: 0.8, weekSince: () => new Date(0) } });
    const session = new Session({ storeRoot, runId: "run-9b1a0001", arm: "adaptive", pool: pool(), validate });
    await runCycleLoop({ client, session, maxCalls: 40, budgetUsd: 1, sleep: async () => {}, effort: "medium" });
    session.close();
    client.close();
    const r = runRecord(storeRoot, "run-9b1a0001", "mock");
    expect(r).toMatchObject({ outcome: "dev_valid_proposal", check_discovery: "PASS", effort: "medium", pair_refusals: 0, prompt_tokens_per_call: 0 });
    expect((r.hypotheses as unknown[]).length).toBe(2);
    expect((r.experiments as { event_logs_identical_to_control: string }[])[0]!.event_logs_identical_to_control).toBe("0 of 4 cases");
    const file = join(tempRoot(), "discovery.json");
    writeFileSync(file, JSON.stringify({ measured: false, citations: { injected_notes: 1 } }));
    publishRuns(file, [r, { ...r, run_id: "run-9b1a0002", outcome: "no_outcome" }], { arm: "adaptive" });
    const out = JSON.parse(readFileSync(file, "utf8")) as { measured: boolean; citations: unknown; adaptive_runs: { k_of_n: Record<string, number> } };
    expect(out.measured).toBe(false);
    expect(out.citations).toEqual({ injected_notes: 1 });
    expect(out.adaptive_runs.k_of_n).toEqual({ n: 2, dev_valid_proposal: 1, honest_negative: 0, insufficient_evidence: 0, no_outcome: 1 });
  });
});
