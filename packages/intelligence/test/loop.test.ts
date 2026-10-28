import { join } from "node:path";
import { ModelError, createModelClient, type MockResponder } from "@hey-pisgah/model";
import { openStream, readStream } from "@hey-pisgah/store";
import { describe, expect, it } from "vitest";
import { checkDiscovery } from "../src/check.js";
import { appendCommitment, appendOnlyProblems, commitmentFor, currentContent, readCommitments } from "../src/commitments.js";
import { ELIDED, systemPrompt } from "../src/prompts.js";
import { SETTINGS, compact, runLoop } from "../src/loop.js";
import { scriptedInvestigator } from "../src/mock.js";
import { STREAMS, Session, sessionStreamId, type Arm } from "../src/session.js";
import { LEARNED, LONG, SHORT, pool, tempRoot } from "./helpers.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const budget = (calls = 40) => ({ runUsd: 1, runMaxCalls: calls, weekUsd: 120, weekStopFraction: 0.8, weekSince: () => new Date(0) });

// Writes a dev_validated report for every proposal, standing in for the evaluator the package may not import.
const fakeValidate = async (root: string) => {
  const out = openStream(root, STREAMS.validations, { writer: true });
  for (const p of readStream(root, STREAMS.proposals)) out.append("validation.completed", { proposal_ref: { stream_id: p.stream_id, seq: p.seq }, report: { proposal_id: (p.payload as { proposal_id: string }).proposal_id, status: "dev_validated", hashes: {} } }, { recorded_at: 0, occurred_at: 0 });
  out.close();
};

async function mockRun(arm: Arm, o: { calls?: number; mock?: MockResponder; a4?: boolean } = {}) {
  const storeRoot = tempRoot();
  const bodies: Record<string, unknown>[] = [];
  const inner = o.mock ?? scriptedInvestigator(arm);
  const client = createModelClient({ storeRoot, mode: "mock", budget: budget(o.calls), mock: (r) => { bodies.push(r.body); return inner(r); } });
  const runId = "run-100baaaa";
  const session = new Session({ storeRoot, runId, arm, pool: pool(), validate: fakeValidate, ...(o.a4 ? { a4Order: [{ ops: LEARNED as never, case_ids: [...LONG, SHORT] }] } : {}) });
  const out = await runLoop({ client, session, maxCalls: o.calls ?? 40, budgetUsd: 1, sleep: async () => {} });
  session.close();
  client.close();
  return { storeRoot, runId, out, bodies, session };
}

describe("discovery loop in mock mode", () => {
  it("runs the adaptive arm to a dev-valid proposal with xhigh on every call and reads in one turn", async () => {
    const r = await mockRun("adaptive");
    expect(r.out.stop).toBe("dev_valid_proposal");
    const rows = readStream(r.storeRoot, `ledger/${r.runId}`).filter((e) => e.record_type === "model.call").map((e) => e.payload as { effort: string; purpose: string });
    expect(rows.length).toBe(r.out.calls);
    expect(rows.every((x) => x.effort === "xhigh" && x.purpose === "discovery.adaptive")).toBe(true);
    for (const b of r.bodies) { expect(b.reasoning_effort).toBe("xhigh"); expect(b.parallel_tool_calls).toBe(true); }
    const turn1 = readStream(r.storeRoot, sessionStreamId(r.runId)).find((e) => e.record_type === "model.turn")!.payload as { tool_calls: unknown[] };
    expect(turn1.tool_calls.length).toBe(3);
    const c = checkDiscovery(r.storeRoot, r.runId);
    expect(c.pass).toBe(true);
    expect(c.summary.say_do_mismatches).toBe(0);
    expect(c.lines.join("\n")).toContain("distinguishes");
  });

  it("runs the prior arm with four tools, no records and one proposal", async () => {
    const r = await mockRun("prior");
    expect(r.out.stop).toBe("prior_proposal_submitted");
    expect((r.bodies[0]!.tools as unknown[]).length).toBe(4);
    expect(checkDiscovery(r.storeRoot, r.runId).pass).toBe(true);
  });

  it("keeps A3 identical to the adaptive prompt except the one experiment sentence", async () => {
    const a = systemPrompt("adaptive").split("\n");
    const b = systemPrompt("a3").split("\n");
    expect(a.filter((l) => !l.startsWith("run_experiment"))).toEqual(b);
    expect(systemPrompt("prior")).toBe(systemPrompt("a3"));
    const r = await mockRun("a3");
    expect((r.bodies[0]!.tools as { function: { name: string } }[]).map((t) => t.function.name)).not.toContain("run_experiment");
    expect(checkDiscovery(r.storeRoot, r.runId).pass).toBe(true);
  });

  it("runs the A4 arm from a listed order the model does not choose", async () => {
    const r = await mockRun("a4", { a4: true });
    expect(r.out.stop).toBe("dev_valid_proposal");
    expect(checkDiscovery(r.storeRoot, r.runId).summary.experiments).toBe(1);
  });

  it("stops at the call cap and when the model ends twice", async () => {
    expect((await mockRun("adaptive", { calls: 3 })).out.stop).toBe("budget_calls");
    const quiet: MockResponder = ({ body }) => ({ id: "m", object: "chat.completion", created: 0, model: String(body.model), choices: [{ index: 0, message: { role: "assistant", content: "nothing to do", refusal: null }, finish_reason: "stop", logprobs: null }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    const r = await mockRun("adaptive", { mock: quiet });
    expect(r.out.stop).toBe("model_ended");
    expect(r.out.calls).toBe(2);
    expect(checkDiscovery(r.storeRoot, r.runId).pass).toBe(false);
  });

  it("has the client refuse a planted Reasoning strength line", async () => {
    const client = createModelClient({ storeRoot: tempRoot(), mode: "mock", budget: budget() });
    await expect(client.call({ provider: "modal", model: SETTINGS.model, effort: "xhigh", messages: [{ role: "system", content: `${systemPrompt("adaptive")}\nReasoning strength: 8.` }], purpose: "t", run_id: null, task_id: null, task_state: null, thread: "main", affinity_key: null }))
      .rejects.toSatisfy((e: unknown) => e instanceof ModelError && e.code === "effort_override_refused");
    client.close();
  });

  it("elides older tool results beyond the context budget", () => {
    const big = "x".repeat(400);
    const m = [{ role: "system" as const, content: "s" }, ...[1, 2, 3].map((i) => ({ role: "tool" as const, tool_call_id: String(i), content: big }))];
    const out = compact(m, 900);
    expect(out.map((x) => x.content)).toEqual(["s", ELIDED, big, big]);
  });
});

describe("commitments", () => {
  it("are append-only with a reason per revision", () => {
    const root = tempRoot();
    const first = appendCommitment(root, "initial prompts", new Date("2026-10-30T00:00:00Z"));
    expect(first.revision).toBe(1);
    expect(() => appendCommitment(root, "same again")).toThrow();
    const f = readCommitments(root)!;
    const edited = { ...f, revisions: [{ ...f.revisions[0]!, reason: "rewritten" }] };
    expect(appendOnlyProblems(f, edited).length).toBeGreaterThan(0);
    expect(commitmentFor(root, "adaptive")?.revision).toBe(1);
  });
  it("hold the hashes the code runs with in the repository file", () => {
    const f = readCommitments(repoRoot);
    expect(f).not.toBeNull();
    expect(appendOnlyProblems(null, f!)).toEqual([]);
    expect(f!.revisions.at(-1)!.content).toEqual(currentContent());
  });
});
