import { describe, expect, it } from "vitest";
import { fencesHash, type Operation, type WorkflowDefinition } from "@hey-pisgah/contracts";
import { loadPool } from "@hey-pisgah/cases";
import { loadHandCase } from "@hey-pisgah/hospital";
import { runDefinition } from "@hey-pisgah/simulator";
import { applyOperations, type Facts } from "@hey-pisgah/workflow";
import { earliestPermitted } from "../src/arms/a1.js";
import { A4_EXPERIMENTS, a4Order, fuzz, oracleNote, randomExperiments, runMatched } from "../src/arms/experiments.js";
import { armVersion, loadProposalInput, ProposalInput } from "../src/arms/proposals.js";
import { poolCases, runArm } from "../src/arms/run.js";
import { singleOperationSpace } from "../src/arms/space.js";
import { singleOperationSweep } from "../src/arms/sweep.js";
import { staleCommitments } from "../src/commit-artifacts.js";
import { loadManifests } from "../src/data.js";
import { loadValidationCases } from "../src/pipeline.js";
import { predictionAfter, predictionBefore, type CheckHypothesis } from "../src/prediction.js";
import { v1 } from "./helpers.js";
import { worldRules } from "@hey-pisgah/hospital";

const hand = loadHandCase();
const fixture = new URL("../fixtures/proposals/learned-pair.json", import.meta.url).pathname;
const discovery = loadPool("discovery");
const facts = discovery.map((c) => c.schedule.facts as Facts);
const disc = discovery.map((c) => ({ case_id: c.case_id, facts: c.schedule.facts as Facts }));
const fam = loadManifests("discovery");
const familyOf = (id: string) => fam.get(id)!.family;
const apply = (ops: readonly unknown[]): WorkflowDefinition => { const r = applyOperations(v1, ops); if (!r.ok) throw new Error(r.errors[0]!.message); return r.definition; };

describe("A1 earliest-permitted transformer", () => {
  const a1 = earliestPermitted(v1);
  it("removes the soft edges and triggers into document preparation, keeps e05 and every fence", () => {
    expect(a1.removed_edges).toEqual(["e04", "e06", "e07"]);
    expect(a1.removed_triggers).toEqual(["st06", "st09a", "st17a"]);
    expect(a1.definition.edges.some((e) => e.edge_id === "e05")).toBe(true);
    expect(fencesHash(a1.definition)).toBe(fencesHash(v1));
  });
  it("gives the known wait on the hand F1 case, with the rework of drafting before the take-home order", () => {
    const run = (d: WorkflowDefinition) => { const r = runDefinition(d, hand.schedule, { world: worldRules() }); if (r.outcome !== "ok") throw new Error("aborted"); return r.metrics; };
    const m = run(a1.definition);
    expect(m.post_signoff_wait_min).toBe(hand.g2.expected.agent.changed_wait_min);
    expect(run(v1).post_signoff_wait_min).toBe(hand.g2.expected.agent.v1_wait_min);
    expect(m.rework_events).toBeGreaterThan(run(apply(hand.g2.ops)).rework_events);
  });
  it("is generic: a learned soft edge into a preparing step goes too", () => {
    const extra = apply([{ op: "add_soft_edge", from: { step: "st02" }, to: { step: "st07" }, gate: "start" }]);
    const r = earliestPermitted(extra);
    expect(r.removed_edges).toHaveLength(4);
    expect(r.definition.edges.filter((e) => e.kind === "soft").map((e) => e.edge_id)).toEqual(["e05"]);
  });
  it("matches its committed hash, and so does the A4 order", () => {
    expect(staleCommitments()).toEqual([]);
  });
});

describe("arms on the definition executor", () => {
  const dev = poolCases("dev");
  it("A2 runs the adopted fixture proposal after the same dev gate", async () => {
    const v = await armVersion(loadProposalInput(fixture), v1);
    expect(v.chosen).toEqual({ run_id: "fixture-1", proposal_id: "p-learned1" });
    expect(v.reports[0]).toMatchObject({ status: "dev_validated", gate_pass: true });
    const a2 = runArm("A2", v.definition, v1, dev), a0 = runArm("A0", v1, v1, dev);
    expect(a2.rows.every((r) => r.pass)).toBe(true);
    const cut = a2.rows.filter((r, i) => (a0.rows[i]!.metrics!.post_signoff_wait_min ?? 0) - (r.metrics!.post_signoff_wait_min ?? 0) >= 60);
    expect(cut.length).toBeGreaterThanOrEqual(3);
  });
  it("an arm with no dev-valid proposal equals A0, and A-prior takes three one-proposal runs", async () => {
    const base = loadProposalInput(fixture);
    const bad = { ...(base.runs[0]!.proposals[0] as Record<string, unknown>), proposal_id: "p-fencebad", ops: [{ op: "remove_soft_edge", edge_id: "e19" }] };
    const a3 = ProposalInput.parse({ ...base, arm: "A3", adopted: null, runs: [{ run_id: "r1", proposals: [bad] }] });
    const v = await armVersion(a3, v1);
    expect([v.equals_base, v.reports[0]!.status]).toEqual([true, "invalid"]);
    const ar = runArm("A3", v.definition, v1, dev), a0 = runArm("A0", v1, v1, dev);
    expect(ar.rows.map((r) => r.effect_set_hash)).toEqual(a0.rows.map((r) => r.effect_set_hash));
    const prior = ProposalInput.parse({ ...base, arm: "A-prior", adopted: null, runs: [{ run_id: "r1", proposals: [bad] }, { run_id: "r2", proposals: [base.runs[0]!.proposals[0]] }, { run_id: "r3", proposals: [] }] });
    const pv = await armVersion(prior, v1);
    expect(pv.chosen?.run_id).toBe("r2");
    expect(() => ProposalInput.parse({ ...prior, runs: [{ run_id: "r1", proposals: [bad, bad] }] })).toThrow();
  });
});

describe("A4, the sweep, fuzzing and the external note", () => {
  it("A4 is one committed order over the valid single-operation space", () => {
    const a = a4Order(v1, disc), b = a4Order(v1, disc);
    expect(a.order).toEqual(b.order);
    expect(a.order).toHaveLength(singleOperationSpace(v1, facts).entries.length);
    expect(a.experiments).toHaveLength(A4_EXPERIMENTS);
    expect(a.experiments.every((x) => x.ops.length === 1 && x.case_ids.length === 6)).toBe(true);
  });
  // CI samples the near space; the full 835-operation result lives in evaluation/results and reruns with HEY_PISGAH_FULL_SWEEP=1.
  it("finds no single operation that reproduces the learned pair, and says so", async () => {
    const near = (op: Operation) => op.op === "remove_soft_edge" || JSON.stringify(op).includes('"st06"') || JSON.stringify(op).includes('"st07"');
    const limit = process.env.HEY_PISGAH_FULL_SWEEP ? undefined : 48;
    const r = await singleOperationSweep(v1, loadValidationCases({ r2Effective: false }), facts, { reference: hand.g2.ops as Operation[], filter: near, ...(limit === undefined ? {} : { limit }) });
    expect(r.validated).toBeGreaterThan(limit === undefined ? 40 : 20);
    expect(r.passing).toBeGreaterThan(0);
    expect(r.reference).toMatchObject({ status: "dev_validated", in_space: false, single_op_with_same_effect: null });
    expect(r.reference!.best_cut).toBeGreaterThanOrEqual(60);
    expect(r.passing_and_cutting).toBe(0);
  }, 420_000);
  it("fuzzes random valid sequences without breaking a fence, the world or a hash", () => {
    const f = fuzz(v1, poolCases("dev"), facts, 40);
    expect(f).toMatchObject({ sequences: 40, aborted: 0, sublog_mismatch: 0, fences_changed: 0, prohibited_executed: 0, hash_drift: 0, green: true });
  });
  it("draws 30 random valid experiments of one to six discovery cases", () => {
    const xs = randomExperiments(v1, disc);
    expect(xs).toHaveLength(30);
    expect(xs.every((x) => x.ops.length >= 1 && x.ops.length <= 3 && x.case_ids.length >= 1 && x.case_ids.length <= 6)).toBe(true);
    expect(xs.every((x) => applyOperations(v1, x.ops, { caseFacts: facts }).ok)).toBe(true);
  });
  it("notes when an experiment's cases mix families whose response differs", () => {
    const f1 = discovery.filter((c) => familyOf(c.case_id) === "F1").map((c) => c.schedule);
    const f2 = discovery.filter((c) => familyOf(c.case_id) === "F2").map((c) => c.schedule);
    const mixed = runMatched(v1, hand.g2.ops as Operation[], [...f1, ...f2], facts);
    const plain = runMatched(v1, hand.g2.ops as Operation[], f2, facts);
    if (!mixed.ok || !plain.ok) throw new Error("invalid");
    expect(oracleNote(mixed.cases, familyOf).mixes_differing_response).toBe(true);
    expect(oracleNote(plain.cases, familyOf).mixes_differing_response).toBe(false);
  });
  it("checks predictions: distinguishes before, then one lands and one is contradicted", () => {
    const f1 = discovery.filter((c) => familyOf(c.case_id) === "F1").map((c) => c.case_id);
    const scope = { cases: f1 };
    const hs: CheckHypothesis[] = [
      { hypothesis_id: "h-aaaaaaa1", if_true: { metric: "post_signoff_wait_min", comparison: "intervention_lt_control", tolerance_min: 30, scope }, if_false: { metric: "post_signoff_wait_min", comparison: "no_difference", tolerance_min: 10, scope } },
      { hypothesis_id: "h-aaaaaaa2", if_true: { metric: "post_signoff_wait_min", comparison: "no_difference", tolerance_min: 10, scope }, if_false: { metric: "post_signoff_wait_min", comparison: "intervention_lt_control", tolerance_min: 30, scope } }
    ];
    const factOf = (id: string) => disc.find((d) => d.case_id === id)?.facts;
    expect(predictionBefore(hs, f1, factOf).distinguishes).toEqual([["h-aaaaaaa1", "h-aaaaaaa2"]]);
    const m = runMatched(v1, hand.g2.ops as Operation[], discovery.filter((c) => f1.includes(c.case_id)).map((c) => c.schedule), facts);
    if (!m.ok) throw new Error("invalid");
    const after = predictionAfter(hs, m.cases.map((c) => ({ ...c, facts: factOf(c.case_id)! })));
    expect(after).toEqual({ per_hypothesis: { "h-aaaaaaa1": { landed: "if_true" }, "h-aaaaaaa2": { landed: "if_false" } }, contradicted: ["h-aaaaaaa2"] });
    const none = predictionAfter(hs, m.cases.map((c) => ({ ...c, intervention: null, facts: factOf(c.case_id)! })));
    expect(Object.values(none.per_hypothesis).map((x) => x.landed)).toEqual(["inconclusive", "inconclusive"]);
  });
});
