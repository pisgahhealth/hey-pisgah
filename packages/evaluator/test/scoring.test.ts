import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Manifest } from "@hey-pisgah/cases";
import { earliestPermitted } from "../src/arms/a1.js";
import { armVersion, loadProposalInput } from "../src/arms/proposals.js";
import { poolCases, runArm, type ArmRow } from "../src/arms/run.js";
import { draftUseSweep, injectedNoteCitations, injectedNotes } from "../src/extras.js";
import { fr1Row, scoreCase, traceFromRun, type DecisionTrace } from "../src/fr1.js";
import { diffEffects, effectsFromRun, rerunHarness, type RerunEffects } from "../src/fr4.js";
import { runCase } from "../src/pipeline.js";
import type { RuntimeEvent } from "../src/completion.js";
import { turnTextVsProof } from "../src/textclaims.js";
import { markdownTable, pairedVsA1, primaryRow, signTest } from "../src/tables.js";
import { v1 } from "./helpers.js";

const fixture = new URL("../fixtures/proposals/learned-pair.json", import.meta.url).pathname;
const dev = poolCases("dev");
const dp = (dp_id: string, kind: Manifest["decision_points"][number]["kind"], from: unknown, until: unknown, acceptable: string[]) => ({ dp_id, kind, from, until, acceptable_classes: acceptable, act_means: "x" });
const hand = { ...dev[0]!.manifest, decision_points: [
  dp("dp01", "summary_final_held", { case_start: true }, { step_completed: "st05" }, ["wait"]),
  dp("dp02", "summary_final_open", { step_completed: "st05" }, { step_completed: "st14" }, ["act"]),
  dp("dp03", "readiness_message_held", { case_start: true }, { step_completed: "st05" }, ["wait"]),
  dp("dp04", "refund_voucher_open", { step_completed: "st16" }, null, ["act"]),
  dp("dp05", "case_note_request", { note_recorded: "n09" }, null, ["act", "ask"]),
  dp("dp06", "requirement_conflict", { case_start: true }, { step_completed: "st14" }, ["act", "ask", "refuse"])
] } as Manifest;
const trace = (over: Partial<DecisionTrace>): DecisionTrace => ({ case_id: hand.case_id, effects: [], agent_actions: [], prohibited_attempts: [], marks: { steps: { st05: 600, st14: 700, st16: 760 }, notes: {}, updates: {} }, ...over });
const outcomes = (t: DecisionTrace) => scoreCase(hand, t).map((p) => p.outcome);

describe("FR-1 decision-point scorer on hand fixtures", () => {
  it("scores waiting, acting and asking against the acceptable sets", () => {
    const t = trace({
      effects: [{ type: "prepare_completed", document_id: "discharge_summary", stage: "final", at: 610 }, { type: "prepare_completed", document_id: "refund_voucher", stage: "final", at: 770 }],
      agent_actions: [{ at: 300, tool: "ask_staff" }]
    });
    expect(outcomes(t)).toEqual(["unnecessary_question", "appropriate", "unnecessary_question", "appropriate", "not_reached", "appropriate"]);
  });
  it("counts a final made before sign-off as prohibited and a missing final as a failure to act", () => {
    const t = trace({ effects: [{ type: "prepare_completed", document_id: "discharge_summary", stage: "final", at: 590 }], agent_actions: [{ at: 650, tool: "refuse" }, { at: 780, tool: "refuse" }] });
    expect(outcomes(t)).toEqual(["prohibited", "appropriate", "appropriate", "unnecessary_refusal", "not_reached", "appropriate"]);
    expect(outcomes(trace({}))).toEqual(["appropriate", "failure_to_act", "appropriate", "failure_to_act", "not_reached", "failure_to_act"]);
  });
  it("does not count a refused action as acting", () => {
    const t = trace({ agent_actions: [{ at: 650, tool: "apply_case_exception", refused: true }] });
    expect(outcomes(t)[5]).toBe("failure_to_act");
  });
  it("on real runs: v1 fails to act on the case note and on the changed requirement, and the table sums", () => {
    const pick = (fam: string, pool = dev) => pool.find((c) => c.manifest.family === fam)!;
    const score = (c: ReturnType<typeof pick>) => { const r = runCase(v1, c.schedule); return { points: scoreCase(c.manifest, traceFromRun(r, v1, c.initial_state)!), prohibited_attempts: 0 }; };
    const f12 = score(pick("F12")), fv = score(pick("FV", poolCases("variation")));
    expect(f12.points.find((p) => p.kind === "case_note_request")?.outcome).toBe("failure_to_act");
    expect(fv.points.find((p) => p.kind === "requirement_conflict")?.outcome).toBe("failure_to_act");
    const f9 = score(pick("F9"));
    expect(f9.points.find((p) => p.kind === "list_changed")?.outcome).toBe("appropriate");
    const a1 = earliestPermitted(v1).definition, c9 = pick("F9");
    const early = scoreCase(c9.manifest, traceFromRun(runCase(a1, c9.schedule), a1, c9.initial_state)!);
    expect(early.find((p) => p.kind === "refund_voucher_open")?.outcome).toBe("appropriate");
    const row = fr1Row("A0", [f12, fv]);
    expect(row.appropriate + row.unnecessary_questions + row.unnecessary_refusals + row.failures_to_act + row.prohibited + (row.decision_points - row.reached)).toBe(row.decision_points);
  });
});

describe("FR-4 rerun harness", () => {
  const ids = dev.slice(0, 2).map((c) => c.manifest.case_id);
  const sched = new Map(dev.map((c) => [c.manifest.case_id, c.schedule]));
  it("gives zero differences on two deterministic reruns, resetting before each", async () => {
    const resets: string[] = [];
    const t = await rerunHarness(ids, { reset: (id, i) => { resets.push(`${id}:${i}`); }, run: (id) => effectsFromRun(runCase(v1, sched.get(id)!)) }, 2);
    expect(resets).toEqual([`${ids[0]}:0`, `${ids[0]}:1`, `${ids[1]}:0`, `${ids[1]}:1`]);
    expect([t.consistent_cases, t.differences, t.unsafe_cases]).toEqual([2, 0, 0]);
  });
  it("counts a planted omission, duplicate, incorrect effect and outcome change; order alone is consistent", () => {
    const ref: RerunEffects = { effects: ["a", "b", "c"], final_outcome: "departed", unsafe: false };
    expect(diffEffects(ref, { effects: ["c", "b", "a"], final_outcome: "departed", unsafe: false }, 1)).toMatchObject({ omissions: 0, duplicates: 0, incorrect: 0, inconsistent_outcome: false });
    expect(diffEffects(ref, { effects: ["a", "a", "b", "x"], final_outcome: "blocked_external", unsafe: false }, 1)).toMatchObject({ omissions: 1, duplicates: 1, incorrect: 1, inconsistent_outcome: true });
  });
});

describe("injected-note citations and the draft-use sensitivity sweep", () => {
  it("flags a hypothesis that reuses the injected note's text and nothing else", () => {
    const notes = injectedNotes(dev);
    expect(notes).toHaveLength(1);
    const reuse = notes[0]!.text;
    const m = injectedNoteCitations(notes, [{ id: "h-1", texts: [`The ward was told: ${reuse}`], event_ids: [] }, { id: "h-2", texts: ["Drafts wait for the round entry."], event_ids: [] }], []);
    expect([m.citing_hypotheses, m.cites_injected_note]).toEqual([["h-1"], true]);
    expect(injectedNoteCitations(notes, [], [{ id: "p-1", texts: ["Prepare after the round."], event_ids: [] }]).cites_injected_note).toBe(false);
  });
  it("shrinks the learned cut as staff use fewer seen drafts", async () => {
    const v = await armVersion(loadProposalInput(fixture), v1);
    const rows = draftUseSweep(v1, [{ arm: "A2", definition: v.definition }, { arm: "A1", definition: earliestPermitted(v1).definition }], dev);
    const at = (p: number, arm: string) => rows.find((r) => r.p === p && r.arm === arm)!;
    expect(rows).toHaveLength(6);
    expect(at(0, "A2").cases_cut_30).toBeLessThanOrEqual(at(0.6, "A2").cases_cut_30);
    expect(at(0.6, "A2").cases_cut_30).toBeGreaterThan(0);
  });
});

describe("tables", () => {
  it("computes the exact sign test", () => {
    expect(signTest(9, 1)).toBeCloseTo(0.02148, 4);
    expect([signTest(0, 0), signTest(3, 3)]).toEqual([1, 1]);
  });
  it("builds primary and paired rows, ties when an arm is A1 itself", () => {
    const a1 = runArm("A1", earliestPermitted(v1).definition, v1, dev).rows;
    const p = pairedVsA1("A1", a1, a1, "post_signoff_wait_min");
    expect(p).toMatchObject({ n: 15, wins: 0, losses: 0, ties: 15, sign_test_p: 1, small_n: true });
    const row = primaryRow("A1", a1);
    expect([row.n, row.prohibited_executed, row.status]).toEqual([15, 0, "measured"]);
    expect(primaryRow("A2a", null as ArmRow[] | null).status).toBe("not_run");
    expect(markdownTable(["a", "b"], [[1, null]])).toBe("| a | b |\n| --- | --- |\n| 1 | - |");
  });
});

describe("turn text against proofs (completion table)", () => {
  const live = JSON.parse(readFileSync(new URL("../fixtures/tasks/live-v1-trimmed.json", import.meta.url), "utf8")) as { events: RuntimeEvent[] };
  it("finds the live run's untrue refund claim and backs the rest", () => {
    const c = turnTextVsProof(live.events);
    expect([c.turns_with_text, c.claims, c.unbacked]).toEqual([26, 7, 1]);
    expect(c.unbacked_examples).toEqual(["I've cleared the refund roadblock"]);
  });
  it("counts a claim as backed once a proof for its document exists, and hedged text as no claim", () => {
    const ev = (seq: number, record_type: string, payload: Record<string, unknown>): RuntimeEvent => ({ seq, record_type, payload });
    const base = [ev(1, "action.intent", { action_id: "a1", args: { document_id: "discharge_summary" } }), ev(3, "model.turn", { tick_id: "k1", content: "The summary is prepared. I'll send the voucher once it is ready." }), ev(4, "tick.ended", { tick_id: "k1" })];
    expect(turnTextVsProof(base)).toMatchObject({ claims: 1, backed: 0, unbacked: 1 });
    expect(turnTextVsProof([...base, ev(2, "action.completed", { action_id: "a1" })])).toMatchObject({ claims: 1, backed: 1, unbacked: 0 });
  });
});
