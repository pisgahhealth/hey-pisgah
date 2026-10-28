import { join } from "node:path";
import { ModelError, createModelClient, type MockResponder } from "@hey-pisgah/model";
import { openStream, readStream } from "@hey-pisgah/store";
import { describe, expect, it } from "vitest";
import { checkDiscovery } from "../src/check.js";
import { appendCommitment, appendOnlyProblems, commitmentFor, currentContent, readCommitments } from "../src/commitments.js";
import { ARGS_NOTE, DEFINITION_NOTE, DROPPED_NOTE, resultDigest } from "../src/digest.js";
import { ELIDED, NOTES_HEADER, REPEAT_NOTE, systemPrompt } from "../src/prompts.js";
import { ENGINE_SEMANTICS } from "../src/views.js";
import { SETTINGS, compact, dropOldTurns, runLoop, type Digests } from "../src/loop.js";
import { scriptedInvestigator } from "../src/mock.js";
import { STREAMS, Session, sessionStreamId, type Arm } from "../src/session.js";
import { LEARNED, LONG, SHORT, evidence, pool, tempRoot } from "./helpers.js";

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

  it("answers a repeated identical call with a note and ends the run as stalled after three", async () => {
    const same: MockResponder = ({ body }) => ({ id: "m", object: "chat.completion", created: 0, model: String(body.model), choices: [{ index: 0, message: { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "c1", type: "function", function: { name: "compute_intervals", arguments: JSON.stringify({ case_ids: [...LONG], from: { kind: "step.completed", step_id: "st05" }, to: { kind: "step.completed", step_id: "st16" }, clock: "occurred" }) } }] }, finish_reason: "tool_calls", logprobs: null }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    const r = await mockRun("adaptive", { mock: same });
    expect(r.out.stop).toBe("declared_negative");
    expect(r.out.detail).toBe("stalled");
    expect(r.out.calls).toBe(4);
    const tools = readStream(r.storeRoot, sessionStreamId(r.runId)).filter((e) => e.record_type === "tool.called").map((e) => e.payload as { ok: boolean; error: string | null; result: string });
    expect(tools.map((t) => t.error)).toEqual([null, "repeated_call", "repeated_call", "repeated_call"]);
    expect(JSON.parse(tools[1]!.result).message).toBe(REPEAT_NOTE);
    const stopped = readStream(r.storeRoot, sessionStreamId(r.runId)).find((e) => e.record_type === "session.stopped")!.payload as { repeated_calls: number };
    expect(stopped.repeated_calls).toBe(3);
    expect(checkDiscovery(r.storeRoot, r.runId).lines.join("\n")).toContain("declared result stalled");
  });

  it("has the client refuse a planted Reasoning strength line", async () => {
    const client = createModelClient({ storeRoot: tempRoot(), mode: "mock", budget: budget() });
    await expect(client.call({ provider: "modal", model: SETTINGS.model, effort: "xhigh", messages: [{ role: "system", content: `${systemPrompt("adaptive")}\nReasoning strength: 8.` }], purpose: "t", run_id: null, task_id: null, task_state: null, thread: "main", affinity_key: null }))
      .rejects.toSatisfy((e: unknown) => e instanceof ModelError && e.code === "effort_override_refused");
    client.close();
  });

  it("elides older tool results beyond the context budget and never the turn the model has not seen", () => {
    const big = "x".repeat(400);
    const tool = (i: number) => ({ role: "tool" as const, tool_call_id: String(i), content: big });
    const call = (i: number, args = "{}") => ({ role: "assistant" as const, content: null, tool_calls: [{ id: String(i), type: "function" as const, function: { name: "get_record", arguments: args } }] });
    const m = [{ role: "system" as const, content: "s" }, call(1), tool(1), call(2), tool(2), call(3), tool(3), call(4), tool(4)];
    const out = compact(m, 900);
    expect(out.filter((x) => x.role === "tool").map((x) => x.content)).toEqual([ELIDED, big, big, big]);
    const unseen = compact([{ role: "system" as const, content: "s" }, call(1), tool(1), tool(2), tool(3)], 10);
    expect(unseen.filter((x) => x.role === "tool").map((x) => x.content)).toEqual([big, big, big]);
    const longArgs = JSON.stringify({ statement: "y".repeat(600) });
    const args = compact([{ role: "system" as const, content: "s" }, call(1, longArgs), tool(1), call(2), tool(2)], 500);
    expect((args[1] as { tool_calls: { function: { arguments: string } }[] }).tool_calls[0]!.function.arguments).toBe(JSON.stringify({ elided: ARGS_NOTE }));
  });

  it("shows the definition whole once, then its short form with the engine rules", () => {
    const s = new Session({ storeRoot: tempRoot(), runId: "run-d1ae5100", arm: "adaptive", pool: pool() });
    const full = JSON.stringify(s.definition());
    const digests: Digests = new Map([["d", { name: "get_workflow_definition", digest: JSON.stringify(resultDigest("get_workflow_definition", s.definition(), s.base)), cases: [] }]]);
    const read = [{ role: "system" as const, content: "s" }, { role: "assistant" as const, content: null, tool_calls: [{ id: "d", type: "function" as const, function: { name: "get_workflow_definition", arguments: "{}" } }] }, { role: "tool" as const, tool_call_id: "d", content: full }];
    expect(compact(read, 100_000, digests)[2]!.content).toBe(full);
    const later = compact([...read, { role: "assistant" as const, content: "next" }], 100_000, digests)[2]!.content as string;
    expect(later.length).toBeLessThan(full.length / 3);
    const d = JSON.parse(later) as { digest: string; edges: string[]; triggers: string[]; engine_semantics: string[] };
    expect(d.digest).toBe(DEFINITION_NOTE);
    expect(d.edges).toContain("e04 st05>st06 start soft");
    expect(d.triggers).toContain('st06 when {"after":{"step":"st05"}}');
    expect(d.engine_semantics).toEqual([...ENGINE_SEMANTICS]);
    s.close();
  });

  it("drops whole older turns past the history cap and keeps the definition's short form in one note", () => {
    const s = new Session({ storeRoot: tempRoot(), runId: "run-d1ae5101", arm: "adaptive", pool: pool() });
    const digest = JSON.stringify(resultDigest("get_workflow_definition", s.definition(), s.base));
    const turn = (i: number, content: string) => [{ role: "assistant" as const, content: null, tool_calls: [{ id: `c${i}`, type: "function" as const, function: { name: "get_record", arguments: "{}" } }] }, { role: "tool" as const, tool_call_id: `c${i}`, content }];
    const m = [{ role: "system" as const, content: "s" }, { role: "user" as const, content: "k" }, ...turn(0, digest), ...[1, 2, 3, 4, 5].flatMap((i) => turn(i, "x".repeat(3000)))];
    const out = dropOldTurns(m, 8000);
    expect(out.slice(0, 2)).toEqual(m.slice(0, 2));
    const note = JSON.parse(out[2]!.content as string) as { elided_turns: number; note: string; definition: { digest: string } };
    expect(note.note).toBe(DROPPED_NOTE);
    expect(note.elided_turns).toBe(3);
    expect(note.definition.digest).toBe(DEFINITION_NOTE);
    expect(out.slice(3)).toEqual(m.slice(-6));
    expect(out[3]!.role).toBe("assistant");
    expect(dropOldTurns(m, 1_000_000)).toEqual(m);
    const huge = [...m.slice(0, 6), ...turn(9, "x".repeat(60_000))];
    expect(dropOldTurns(huge, 8000)).toEqual(huge);
    expect(compact(huge, 8000).filter((x) => x.role === "tool").map((x) => (x.content as string).length)).toEqual(huge.filter((x) => x.role === "tool").map((x) => (x.content as string).length));
    s.close();
  });

  it("keeps a sixty-call run's conversation under the history cap", async () => {
    const ids = pool().ids();
    let n = 0;
    const reads: MockResponder = ({ body }) => {
      n += 1;
      const c = ids[n % ids.length]!;
      const calls = n === 1 ? [["list_cases", {}], ["get_workflow_definition", {}], ["get_ward_requirements", {}]] : [["get_case_timeline", { case_id: c, order: n % 2 ? "occurred" : "recorded", limit: 60 }], ["get_staff_activity", { case_id: c, role: "nurse" }]];
      return { id: "m", object: "chat.completion", created: 0, model: String(body.model), choices: [{ index: 0, message: { role: "assistant", content: "reading", refusal: null, tool_calls: calls.map(([name, args], i) => ({ id: `c${n}_${i}`, type: "function", function: { name: name as string, arguments: JSON.stringify(args) } })) }, finish_reason: "tool_calls", logprobs: null }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    };
    const r = await mockRun("adaptive", { calls: 60, mock: reads });
    expect(r.out.calls).toBe(60);
    const newest = 2 * 8_200 + 1_500;
    for (const b of r.bodies) expect(JSON.stringify((b.messages as unknown[]).slice(2)).length).toBeLessThan(SETTINGS.history_chars + newest);
  });
});

describe("working notes", () => {
  it("are capped, logged, shown numbered after the kickoff on every later call, and scanned", async () => {
    const s = new Session({ storeRoot: tempRoot(), runId: "run-0e7e0001", arm: "adaptive", pool: pool() });
    expect(s.recordNote({ note: "x".repeat(601) }).error).toBe("invalid_arguments");
    expect(s.recordNote({ note: "c-491dbab0 waits 149 min after the clinical discharge" })).toMatchObject({ ok: true, note_number: 1 });
    for (let i = 2; i <= 20; i++) expect(s.recordNote({ note: `n${i}` }).ok).toBe(true);
    expect(s.recordNote({ note: "one more" }).error).toBe("notes_full");
    s.close();
    let n = 0;
    const script: MockResponder = ({ body }) => {
      n += 1;
      const calls = n === 1 ? [["record_note", { note: "the wait is longest in Ward C cases" }]] : [["get_case_timeline", { case_id: LONG[n % 3], order: "occurred", limit: 60 }]];
      return { id: "m", object: "chat.completion", created: 0, model: String(body.model), choices: [{ index: 0, message: { role: "assistant", content: null, refusal: null, tool_calls: calls.map(([name, args], i) => ({ id: `c${n}_${i}`, type: "function", function: { name: name as string, arguments: JSON.stringify(args) } })) }, finish_reason: "tool_calls", logprobs: null }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    };
    const r = await mockRun("adaptive", { calls: 30, mock: script });
    expect((r.bodies[0]!.messages as unknown[]).length).toBe(2);
    for (const b of r.bodies.slice(1)) expect((b.messages as { role: string; content: string }[])[2]).toEqual({ role: "user", content: `${NOTES_HEADER}\n1. the wait is longest in Ward C cases` });
    const c = checkDiscovery(r.storeRoot, r.runId);
    expect(c.summary.notes).toBe(1);
    expect(c.lines.join("\n")).toContain("1. the wait is longest in Ward C cases");
    const planted = await mockRun("adaptive", { calls: 2, mock: ({ body }) => ({ id: "m", object: "chat.completion", created: 0, model: String(body.model), choices: [{ index: 0, message: { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "p1", type: "function", function: { name: "record_note", arguments: JSON.stringify({ note: "start it earlier" }) } }] }, finish_reason: "tool_calls", logprobs: null }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) });
    expect(checkDiscovery(planted.storeRoot, planted.runId).summary.deny_hits).toBe(1);
  });
});

describe("pinned results", () => {
  it("keep results on a case an active hypothesis cites whole, and drop their turns last", () => {
    const turn = (i: number, content: string) => [{ role: "assistant" as const, content: null, tool_calls: [{ id: `c${i}`, type: "function" as const, function: { name: "get_record", arguments: "{}" } }] }, { role: "tool" as const, tool_call_id: `c${i}`, content }];
    const big = "x".repeat(3000);
    const m = [{ role: "system" as const, content: "s" }, { role: "user" as const, content: "k" }, ...[0, 1, 2, 3, 4, 5].flatMap((i) => turn(i, big))];
    const pinned = new Set(["c0"]);
    const out = compact(m, 4000, new Map(), pinned);
    expect(out.filter((x) => x.role === "tool").map((x) => (x.content as string).length)).toEqual([3000, ELIDED.length, ELIDED.length, ELIDED.length, 3000, 3000]);
    const dropped = dropOldTurns(m, 8000, pinned);
    const kept = dropped.filter((x) => x.role === "tool").map((x) => (x as { tool_call_id: string }).tool_call_id);
    expect(kept[0]).toBe("c0");
    expect(kept.at(-1)).toBe("c5");
  });

  it("follow the cases an active hypothesis cites", () => {
    const s = new Session({ storeRoot: tempRoot(), runId: "run-0e7e0002", arm: "adaptive", pool: pool() });
    expect(s.citedCases().size).toBe(0);
    s.recordHypothesis({ statement: "s", mechanism: "m", subject_refs: [], competing: { none_identified_reason: "r" }, evidence: evidence(), if_true: { metric: "post_signoff_wait_min", comparison: "intervention_lt_control", tolerance_min: 30, scope: { cases: [LONG[2]] } }, if_false: { metric: "post_signoff_wait_min", comparison: "no_difference", tolerance_min: 10, scope: { cases: [LONG[2]] } }, refuted_if: "r" });
    expect([...s.citedCases()].sort()).toEqual([LONG[0], LONG[2], SHORT].sort());
    s.close();
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
