import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonical } from "@hey-pisgah/contracts";
import { caseIdFor, loadPool } from "@hey-pisgah/cases";
import { RESERVED_CANARIES, seedList } from "@hey-pisgah/cases/reserved";
import { REWORK_BUDGET_MIN_PER_CASE, loadHandCase } from "@hey-pisgah/hospital";
import { eventLogHash } from "@hey-pisgah/simulator";
import { openStream, readStream } from "@hey-pisgah/store";
import type { Facts } from "@hey-pisgah/workflow";
import { devGate, proposalDefinition, runCase, runValidationStream, validateProposal, validationSummary, type CaseRow } from "../src/pipeline.js";
import { ok, v1 } from "./helpers.js";

const hand = loadHandCase();
const proposal = (ops: readonly unknown[], extra: Record<string, unknown> = {}) => ({
  proposal_id: "p-aaaaaaaa", parent_proposal_id: null, base_version: 1, ops: [...ops], scope: { wards: "all", condition: null }, rationale: "Prepare the summary draft once the round entry is in.",
  evidence: { hypothesis_ids: [], experiment_ids: [], event_ids: [] }, expected_effects: [], known_exceptions: [], viewed_case_ids: [], status: "submitted", hash: "0".repeat(64), ...extra
});

describe("validation pipeline", () => {
  it("validates a planted good proposal on the 15 dev cases", async () => {
    const r = await validateProposal(proposal(hand.g2.ops));
    expect(r.status).toBe("dev_validated");
    expect(r.gate).toMatchObject({ pass: true, no_regression: true, prohibited_attempts: 0, exception_check: true, fences_intact: true, documents_kept: true, rework_budget_min_per_case: REWORK_BUDGET_MIN_PER_CASE, rework_within_budget: true });
    expect(r.cases).toHaveLength(15);
    expect(r.cases.some((c) => (c.delta.post_signoff_wait_min ?? 0) <= -60)).toBe(true);
    expect(validationSummary([r])).toMatchObject({ dev_gate_pass: true, exception_check_pass: true, fences_unchanged: true, proposals_validated: 1 });
  });
  it("adds the 2 variation cases once r2 is effective, where blind application fails AC-05 on both arms", async () => {
    const r = await validateProposal(proposal(hand.g2.after_order_ops), { r2Effective: true });
    expect(r.cases).toHaveLength(17);
    const varied = r.cases.filter((c) => ["c-be48c313", "c-830e004c"].includes(c.case_id));
    expect(varied.map((c) => [c.base.failing, c.proposal.failing])).toEqual([[["AC-05"], ["AC-05"]], [["AC-05"], ["AC-05"]]]);
    expect(r.status).toBe("dev_validated");
  });
  it("fails a planted bad proposal whose known exception is not true", async () => {
    const r = await validateProposal(proposal(hand.g2.ops, { known_exceptions: [{ condition: { fact: "ward_id", eq: "B" }, behaviour: "not_applied" }] }));
    expect(r.status).toBe("dev_failed");
    expect(r.gate?.exception_check).toBe(false);
    expect(r.cases.filter((c) => !c.in_scope && !c.identical_log).length).toBeGreaterThan(0);
  });
  it("refuses a proposal that touches a fence before any run", async () => {
    const r = await validateProposal(proposal([{ op: "remove_soft_edge", edge_id: "e19" }]));
    expect(r).toMatchObject({ status: "invalid", stage_failed: "static", cases: [] });
  });
  it("repairs a malformed proposal at most twice through the hook", async () => {
    const { rationale: _drop, ...broken } = proposal(hand.g2.ops);
    const fixed = await validateProposal(broken, { repair: (raw) => ({ ...(raw as object), rationale: "repaired" }) });
    expect([fixed.repairs, fixed.status]).toEqual([1, "dev_validated"]);
    let calls = 0;
    const never = await validateProposal(broken, { repair: (raw) => { calls += 1; return raw; } });
    expect([never.repairs, calls, never.status, never.stage_failed]).toEqual([2, 2, "invalid", "schema"]);
  });
  it("passes the pool's facts so a single-case scope condition is refused", () => {
    const facts = loadPool("discovery").map((c) => c.schedule.facts as Facts);
    const lone = (["payer_type", "ward_id"] as const).flatMap((f) => [...new Set(facts.map((x) => String(x[f])))].map((v) => ({ fact: f, eq: v })))
      .find((c) => facts.filter((x) => x[c.fact] === c.eq).length === 1);
    expect(lone).toBeDefined();
    const p = proposal(hand.g2.ops, { scope: { wards: "all", condition: lone } });
    const r = proposalDefinition(v1, p as never, facts);
    expect(r.ok === false && r.errors[0]?.code).toBe("single_case_condition");
    const op = proposal([...hand.g2.ops, { op: "add_condition", target: { step: { step: "st06" } }, condition: lone }]);
    const viaOps = proposalDefinition(v1, op as never, facts);
    expect(viaOps.ok === false && viaOps.errors[0]?.code).toBe("single_case_condition");
  });
  it("keeps the report free of reserved ids, canaries and family labels", async () => {
    const text = canonical(await validateProposal(proposal(hand.g2.ops)));
    const reservedIds = seedList().map((e) => caseIdFor(e.seed));
    for (const t of [...reservedIds, ...RESERVED_CANARIES]) expect(text.includes(t)).toBe(false);
    expect(/reserved|\bF(?:[1-9]|1[0-2]|V)\b|should_apply|famil/i.test(text)).toBe(false);
  });
});

describe("required documents", () => {
  it("refuses a change that switches a ward-required document off, though every acceptance check passes", async () => {
    const r = await validateProposal(proposal([{ op: "add_condition", target: { step: { step: "st17b" } }, condition: { fact: "payment_status", eq: "unpaid" } }]));
    expect(r.status).toBe("dev_failed");
    expect(r.gate).toMatchObject({ pass: false, no_regression: true, exception_check: true, fences_intact: true, documents_kept: false });
    expect(r.cases.every((c) => c.documents_dropped!.includes("refund_voucher"))).toBe(true);
    expect(r.cases.every((c) => c.proposal.pass)).toBe(true);
  });
});

describe("exception check", () => {
  it("out-of-scope cases have event log hashes identical to the base", async () => {
    const r = await validateProposal(proposal(hand.g2.ops, { scope: { wards: ["A"], condition: null } }));
    const out = r.cases.filter((c) => !c.in_scope);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.identical_log)).toBe(true);
    expect(r.gate?.exception_check).toBe(true);
    const wardB = loadPool("dev").find((c) => c.case_id === "c-b47991ef")!;
    expect(out.find((c) => c.case_id === wardB.case_id)?.identical_log).toBe(true);
    const learned = proposalDefinition(v1, proposal(hand.g2.ops) as never, []);
    if (!learned.ok) throw new Error("ops");
    expect(eventLogHash(ok(runCase(learned.def, wardB.schedule)).events)).not.toBe(eventLogHash(ok(runCase(v1, wardB.schedule)).events));
    expect(r.cases.filter((c) => c.in_scope).some((c) => !c.identical_log)).toBe(true);
  });
});

describe("dev gate", () => {
  const row = (base: boolean, prop: boolean, inScope = true, identical = true): CaseRow => ({
    case_id: "c-aaaaaaaa", seen: false, in_scope: inScope, identical_log: identical,
    base: { pass: base, failing: base ? [] : ["AC-05"], outcome: "ok" }, proposal: { pass: prop, failing: prop ? [] : ["AC-05"], outcome: "ok" },
    delta: { post_signoff_wait_min: 0, bed_release_delay_min: 0, rework_min: 0, unnecessary_docs: 0 }
  });
  const x = { def: v1, base: v1, aborted: false, prohibited: 0 };
  it("does not require improvement and tolerates a case failing on both arms", () => {
    expect(devGate([row(true, true), row(false, false)], x).pass).toBe(true);
  });
  it("fails on a regression, a prohibited attempt, an exception mismatch or an aborted run", () => {
    expect(devGate([row(true, false)], x)).toMatchObject({ pass: false, no_regression: false });
    expect(devGate([row(true, true)], { ...x, prohibited: 1 }).pass).toBe(false);
    expect(devGate([row(true, true, false, false)], x)).toMatchObject({ pass: false, exception_check: false });
    expect(devGate([row(true, true)], { ...x, aborted: true })).toMatchObject({ pass: false, fences_intact: false });
  });
  it("passes extra rework up to the per-case budget and fails one minute over it, counting in-scope cases only", () => {
    const reworked = (min: number, inScope = true): CaseRow => ({ ...row(true, true, inScope, !inScope), delta: { post_signoff_wait_min: -20, bed_release_delay_min: 0, rework_min: min, unnecessary_docs: 0 } });
    expect(devGate([reworked(3), reworked(1)], { ...x, reworkBudgetMinPerCase: 3 })).toMatchObject({ pass: true, rework_max_added_min: 3, rework_within_budget: true });
    expect(devGate([reworked(4), reworked(1)], { ...x, reworkBudgetMinPerCase: 3 })).toMatchObject({ pass: false, rework_max_added_min: 4, rework_within_budget: false });
    expect(devGate([reworked(1)], { ...x, reworkBudgetMinPerCase: 0 })).toMatchObject({ pass: false, rework_within_budget: false });
    expect(devGate([reworked(-5)], { ...x, reworkBudgetMinPerCase: 0 })).toMatchObject({ pass: true, rework_max_added_min: 0 });
    expect(devGate([reworked(0), { ...reworked(9, false), identical_log: true }], { ...x, reworkBudgetMinPerCase: 0 }).rework_within_budget).toBe(true);
    expect(devGate([reworked(REWORK_BUDGET_MIN_PER_CASE)], x)).toMatchObject({ pass: true, rework_budget_min_per_case: REWORK_BUDGET_MIN_PER_CASE });
    expect(devGate([reworked(REWORK_BUDGET_MIN_PER_CASE + 1)], x).pass).toBe(false);
  });
  it("assesses the adopted form against the budget on the dev cases: 2 minutes on one case passes at 2 and fails at 1", async () => {
    const ops = [{ op: "remove_soft_edge", edge_id: "e04" }, { op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st01" } } }];
    const at2 = await validateProposal(proposal(ops), { reworkBudgetMinPerCase: 2 });
    expect([at2.status, at2.gate?.rework_max_added_min, at2.gate?.rework_within_budget]).toEqual(["dev_validated", 2, true]);
    const at1 = await validateProposal(proposal(ops), { reworkBudgetMinPerCase: 1 });
    expect([at1.status, at1.gate?.rework_within_budget, at1.gate?.no_regression, at1.gate?.documents_kept]).toEqual(["dev_failed", false, true, true]);
  }, 60_000);
});

describe("validations stream", () => {
  it("reads proposals, writes one validation each, and skips what it already validated", async () => {
    const root = mkdtempSync(join(tmpdir(), "val-"));
    const w = openStream(root, "learning/proposals", { writer: true });
    w.append("proposal.submitted", proposal(hand.g2.ops), { recorded_at: 0, occurred_at: 0 });
    w.append("proposal.submitted", proposal([{ op: "remove_soft_edge", edge_id: "e19" }], { proposal_id: "p-bbbbbbbb" }), { recorded_at: 0, occurred_at: 0 });
    w.close();
    const first = await runValidationStream(root);
    expect(first.map((r) => r.status)).toEqual(["dev_validated", "invalid"]);
    expect(await runValidationStream(root)).toEqual([]);
    const v = readStream(root, "learning/validations");
    expect(v.map((e) => [e.record_type, (e.payload as { proposal_ref: { seq: number } }).proposal_ref.seq])).toEqual([["validation.completed", 1], ["validation.completed", 2]]);
  });
});
