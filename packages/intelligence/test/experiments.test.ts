import { WorkflowChangeProposal, hashJson, type RunResult } from "@hey-pisgah/contracts";
import { BEHAVIOUR_UNCHANGED, externalSubLogHash, runDefinition } from "@hey-pisgah/simulator";
import { openStream, readStream } from "@hey-pisgah/store";
import { describe, expect, it } from "vitest";
import { STREAMS, type Session } from "../src/session.js";
import { UNKNOWN_ID } from "../src/unknown.js";
import { LEARNED, LONG, SHORT, eventId, hyp, pred, session } from "./helpers.js";

const two = (s: Session) => { const h1 = hyp(s); const h2 = hyp(s, { competing: [h1], if_true: pred("no_difference", 10), if_false: pred("intervention_lt_control", 30) }); return { h1, h2 }; };
const req = (h1: string, h2: string, o: Record<string, unknown> = {}) => ({ hypothesis_id: h1, distinguishes: [h2], base: { version: 1 }, ops: LEARNED, case_ids: [...LONG, SHORT], note: "n", expected_change: { step: "st06", behaviour: "start_time" }, ...o });
const proposal = (o: Record<string, unknown> = {}) => ({ parent_proposal_id: null, base_version: 1, ops: LEARNED, scope: { wards: "all", condition: null }, rationale: "r", evidence: { hypothesis_ids: [], experiment_ids: [], event_ids: [] }, expected_effects: [{ metric: "post_signoff_wait_min", direction: "down", subgroup_condition: null }], known_exceptions: [], ...o });

describe("matched experiments", () => {
  it("runs control and intervention on the same world and returns numbers, diffs and no verdict", () => {
    const s = session();
    const { h1, h2 } = two(s);
    const r = s.runExperiment(req(h1, h2));
    expect(r.ok).toBe(true);
    const cases = r.cases as { case_id: string; delta: { post_signoff_wait_min: number } }[];
    expect(cases.map((c) => c.case_id)).toEqual([...LONG, SHORT]);
    for (const c of cases.slice(0, 3)) expect(c.delta.post_signoff_wait_min).toBeLessThanOrEqual(-30);
    const text = JSON.stringify(r);
    for (const w of ["prediction_check", "verdict", "landed", "family", "contradicted", "speaks_to"]) expect(text).not.toContain(w);
    const stored = readStream(s.o.storeRoot, STREAMS.experiments).find((e) => e.record_type === "experiment.completed")!.payload as { prediction_check: { before: { distinguishes: string[][] }; after: { per_hypothesis: Record<string, { landed: string }> } }; hypothesis_hashes: Record<string, string> };
    expect(stored.prediction_check.before.distinguishes).toEqual([[h1, h2]]);
    expect(stored.prediction_check.after.per_hypothesis[h1]).toEqual({ landed: "if_true" });
    expect(stored.prediction_check.after.per_hypothesis[h2]).toEqual({ landed: "if_false" });
    expect(stored.hypothesis_hashes[h1]).toBe(s.hypotheses.get(h1)!.hash);
    expect(readStream(s.o.storeRoot, STREAMS.hypotheses).filter((e) => e.record_type === "hypothesis.frozen").length).toBe(2);
    s.close();
  });

  it("says when the event logs equal control and names what still gates the targeted steps", () => {
    const s = session();
    const { h1, h2 } = two(s);
    const ops = [{ op: "move_step_after", step: { step: "st06" }, after: { step: "st01" }, gate: "start" }, { op: "add_soft_edge", from: { step: "st05" }, to: { step: "st07" }, gate: "start" }];
    const r = s.runExperiment(req(h1, h2, { ops }));
    expect(r.ok).toBe(true);
    expect(r.intervention_hash).not.toBe(r.base_hash);
    const b = r.behaviour as { event_logs_identical_to_control: string; identical_cases: string[]; note: string | null; gating: { step: string; start_edges: { edge_id: string; from: string }[]; triggers: { when: unknown }[] }[] };
    expect(b.event_logs_identical_to_control).toBe("4 of 4 cases");
    expect(b.identical_cases).toEqual([...LONG, SHORT]);
    expect(b.note).toBe(BEHAVIOUR_UNCHANGED);
    expect(b.gating.map((g) => g.step)).toEqual(["st06", "st07"]);
    expect(b.gating[0]!.triggers).toEqual([{ when: { after: { step: "st05" } }, condition: null }]);
    expect(b.gating[0]!.start_edges.map((e) => e.from)).toEqual(["st01"]);
    expect(b.gating[1]!.start_edges.map((e) => e.from).sort()).toEqual(["st05", "st06"]);
    for (const c of r.cases as { event_logs_identical: boolean }[]) expect(c.event_logs_identical).toBe(true);
    const text = JSON.stringify(r);
    for (const w of ["verdict", "landed", "family", "should", "because"]) expect(text).not.toContain(w);
    const changed = s.runExperiment(req(h1, h2));
    const cb = changed.behaviour as { identical_cases: string[]; note: string | null; gating: unknown };
    expect(cb).toMatchObject({ identical_cases: [], note: null, gating: null });
    s.close();
  });

  it("aborts when the external sub-log differs between the arms", () => {
    let n = 0;
    const tamper: typeof runDefinition = (def, sch, o) => {
      const r = runDefinition(def, sch, o) as RunResult;
      n += 1;
      if (r.outcome !== "ok" || n % 2 === 1) return r;
      const i = r.events.findIndex((e) => e.kind.startsWith("world."));
      const events = r.events.map((e, j) => (j === i ? { ...e, occurred_at: e.occurred_at + 1, recorded_at: e.recorded_at + 1 } : e));
      expect(externalSubLogHash(events)).not.toBe(externalSubLogHash(r.events));
      return { ...r, events };
    };
    const s = session({ runner: tamper });
    const { h1, h2 } = two(s);
    const r = s.runExperiment(req(h1, h2));
    expect(r.error).toBe("experiment_aborted");
    expect(String(r.message)).toContain("external sub-log differs");
    expect(readStream(s.o.storeRoot, STREAMS.experiments).map((e) => e.record_type)).toEqual(["experiment.aborted"]);
    expect(s.counters.experiments_used).toBe(1);
    expect(s.counters.invalid_requests).toBe(0);
    s.close();
  });

  it("validates in order and locks out after three refused requests", () => {
    const s = session();
    expect(JSON.stringify(s.runExperiment(req("h-00000000", "h-00000000")))).toBe(JSON.stringify(UNKNOWN_ID));
    expect(s.counters.invalid_requests).toBe(1);
    const { h1, h2 } = two(s);
    expect(s.runExperiment(req(h1, h2)).ok).toBe(true);
    expect(JSON.stringify(s.runExperiment(req(h1, h2, { case_ids: ["c-zz99zz99"] })))).toBe(JSON.stringify(UNKNOWN_ID));
    expect(s.counters.invalid_requests).toBe(2);
    const fence = s.runExperiment(req(h1, h2, { ops: [{ op: "remove_soft_edge", edge_id: "e19" }] }));
    expect(fence.error).toBe("invalid_request");
    expect(fence.stage).toBe("static");
    expect(s.locked).toBe(true);
    expect(s.stop?.reason).toBe("lockout");
    expect(s.runExperiment(req(h1, h2)).error).toBe("locked_out");
    expect(readStream(s.o.storeRoot, STREAMS.experiments).map((e) => e.record_type)).toEqual(["experiment.invalid", "experiment.completed", "experiment.invalid", "experiment.invalid"]);
    s.close();
  });

  it("lints before it runs: a change the engine cannot act on, a request that tells no cited pair apart, and a repeat are refused with the reason as data", () => {
    const s = session();
    const { h1, h2 } = two(s);
    const noop = s.runExperiment(req(h1, h2, { ops: [{ op: "remove_soft_edge", edge_id: "e04" }] }));
    expect(noop.error).toBe("lint_refused");
    expect(noop.reasons).toEqual(["no_op"]);
    const rules = (noop.lint as { rules: { step: string; start_before: string; start_after: string; start_equivalent: boolean }[] }).rules;
    expect(rules.find((r) => r.step === "st06")).toMatchObject({ start_equivalent: true });
    expect(rules.find((r) => r.step === "st06")!.start_after).toContain("done st05");
    const alone = s.runExperiment(req(h1, h1, { distinguishes: [] }));
    expect(alone.reasons).toEqual(["no_discrimination"]);
    expect(s.runExperiment(req(h1, h2)).ok).toBe(true);
    const again = s.runExperiment(req(h1, h2));
    expect(again.reasons).toEqual(["already_run"]);
    expect(s.counters).toMatchObject({ lint_refusals: 3, invalid_requests: 0, experiments_used: 1 });
    expect(readStream(s.o.storeRoot, STREAMS.experiments).filter((e) => e.record_type === "experiment.lint_refused").length).toBe(3);
    expect(String(noop.message)).not.toMatch(/h-[0-9a-f]{8}|c-[0-9a-f]{8}/);
    s.close();
  });

  it("names the expected behaviour, returns a receipt, and tells a delivered change from an undelivered one", () => {
    const s = session();
    const { h1, h2 } = two(s);
    const moved = s.runExperiment(req(h1, h2));
    const r = moved.receipt as { delivered: string; outcome: string; target: { case_id: string; moved: boolean; control: { started: number }; intervention: { started: number } }[]; first_divergence: { first: unknown }[]; rules_changed: { edges_removed: string[]; triggers_changed: { step: string }[] } };
    expect(r.rules_changed.edges_removed).toEqual(["e04 st05>st06 start soft"]);
    expect(r.rules_changed.triggers_changed.map((t) => t.step)).toEqual(["st06"]);
    expect(r.target.filter((t) => LONG.includes(t.case_id as never)).every((t) => t.moved && t.intervention.started < t.control.started)).toBe(true);
    expect(r.outcome).toBe("delivered_outcome_better");
    expect(r.first_divergence.every((d) => d.first !== null)).toBe(true);
    const stuck = s.runExperiment(req(h1, h2, { ops: [{ op: "move_step_after", step: { step: "st06" }, after: { step: "st01" }, gate: "start" }] }));
    const sr = stuck.receipt as { delivered: string; outcome: string };
    expect(sr).toMatchObject({ delivered: "0 of 4 cases", outcome: "not_delivered" });
    const stored = s.experiments.get(String(stuck.experiment_id))!;
    expect(stored.delivered).toBe(false);
    expect(Object.values(stored.prediction_check.after!.per_hypothesis).every((v) => v.landed === "inconclusive")).toBe(true);
    expect(stored.prediction_check.after!.contradicted).toEqual([]);
    expect(s.setStatus({ hypothesis_id: h1, status: "rejected", experiment_ids: [String(stuck.experiment_id)], evidence_event_ids: [], note: "no change" }).error).toBe("status_refused");
    expect(s.counters).toMatchObject({ delivered: 1, not_delivered: 1, informative: 1 });
    s.close();
  });

  it("gives two schema repairs, then counts the request as refused", () => {
    const s = session();
    const h1 = hyp(s);
    const bad = req(h1, h1, { distinguishes: [], ops: [{ op: "rename_step" }] });
    expect(s.runExperiment(bad).error).toBe("invalid_arguments");
    expect(s.runExperiment(bad).error).toBe("invalid_arguments");
    expect(s.counters.invalid_requests).toBe(0);
    expect(s.runExperiment(bad).error).toBe("invalid_request");
    expect(s.counters.invalid_requests).toBe(1);
    expect(s.counters.repairs).toBe(3);
    s.close();
  });

  it("stops at eight experiments", () => {
    const s = session();
    const { h1, h2 } = two(s);
    const sets = [[LONG[0]], [LONG[1]], [LONG[2]], [LONG[0], LONG[1]], [LONG[0], LONG[2]], [LONG[1], LONG[2]], [...LONG], [LONG[0], SHORT]];
    for (const c of sets) expect(s.runExperiment(req(h1, h2, { case_ids: c })).ok).toBe(true);
    expect(s.runExperiment(req(h1, h2)).error).toBe("budget_exhausted");
    s.close();
  });
});

describe("proposal submission", () => {
  it("appends a strict proposal with server fields, runs the validator hook and stops on a dev-valid report", async () => {
    let called = 0;
    const s = session({
      validate: async (root) => {
        called += 1;
        const p = readStream(root, STREAMS.proposals).at(-1)!;
        const out = openStream(root, STREAMS.validations, { writer: true });
        out.append("validation.completed", { proposal_ref: { stream_id: p.stream_id, seq: p.seq }, report: { proposal_id: (p.payload as { proposal_id: string }).proposal_id, status: "dev_validated", hashes: {}, cases: [] } }, { recorded_at: 0, occurred_at: 0 });
        out.close();
      }
    });
    const { h1, h2 } = two(s);
    expect((await s.submitProposal(proposal({ evidence: { hypothesis_ids: [h1], experiment_ids: [], event_ids: [] } }))).error).toBe("evidence_rule");
    const x = s.runExperiment(req(h1, h2));
    const ok = await s.submitProposal(proposal({ evidence: { hypothesis_ids: [h1], experiment_ids: [x.experiment_id], event_ids: [eventId(LONG[0], "st16")] } }));
    expect(ok.ok).toBe(true);
    expect(ok.validation).toBe("dev_validated");
    expect(called).toBe(1);
    expect(s.stop?.reason).toBe("dev_valid_proposal");
    const stored = readStream(s.o.storeRoot, STREAMS.proposals).map((e) => WorkflowChangeProposal.parse(e.payload));
    expect(stored.length).toBe(1);
    const { hash, ...body } = stored[0]!;
    expect(hash).toBe(hashJson(body));
    expect(stored[0]!.viewed_case_ids).toEqual([...LONG, SHORT].sort());
    const report = s.validationReport({ proposal_id: String(ok.proposal_id) });
    expect(report.status).toBe("dev_validated");
    expect(report).not.toHaveProperty("hashes");
    s.close();
  });

  it("refuses a fence change and an id from another session, and keeps the slot", async () => {
    const s = session();
    const { h1, h2 } = two(s);
    const x = s.runExperiment(req(h1, h2));
    const ev = { hypothesis_ids: [h1], experiment_ids: [x.experiment_id], event_ids: [] };
    expect((await s.submitProposal(proposal({ ops: [{ op: "remove_soft_edge", edge_id: "e19" }], evidence: ev }))).error).toBe("static_invalid");
    expect(JSON.stringify(await s.submitProposal(proposal({ evidence: { ...ev, hypothesis_ids: ["h-0ther5e5"] } })))).toBe(JSON.stringify(UNKNOWN_ID));
    expect(s.counters.proposals_used).toBe(0);
    expect((await s.submitProposal(proposal({ evidence: ev }))).validation).toBe("pending");
    s.close();
  });

  it("lets the prior arm submit one proposal without citations", async () => {
    const s = session({ arm: "prior" });
    expect(s.runExperiment({}).error).toBe("not_available");
    const ok = await s.submitProposal(proposal());
    expect(ok.ok).toBe(true);
    expect(s.stop?.reason).toBe("prior_proposal_submitted");
    expect((await s.submitProposal(proposal())).error).toBe("proposals_exhausted");
    s.close();
  });

  it("ends on a declared negative that cites inspected events", () => {
    const s = session();
    expect(s.endSession({ result: "no_change_warranted", note: "n", evidence_event_ids: [] }).error).toBe("evidence_rule");
    expect(s.endSession({ result: "insufficient_evidence", note: "n", evidence_event_ids: [eventId(SHORT, "st16")] }).error).toBe("not_available");
    expect(s.endSession({ result: "no_change_warranted", note: "n", evidence_event_ids: [eventId(SHORT, "st16")] }).ok).toBe(true);
    expect(s.stop?.reason).toBe("declared_negative");
    s.close();
  });
});
