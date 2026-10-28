import { WorkflowChangeProposal, hashJson, type RunResult } from "@hey-pisgah/contracts";
import { BEHAVIOUR_UNCHANGED, externalSubLogHash, runDefinition } from "@hey-pisgah/simulator";
import { openStream, readStream } from "@hey-pisgah/store";
import { describe, expect, it } from "vitest";
import { STREAMS, type Session } from "../src/session.js";
import { UNKNOWN_ID } from "../src/unknown.js";
import { LEARNED, LONG, SHORT, eventId, hyp, pred, session } from "./helpers.js";

const two = (s: Session) => { const h1 = hyp(s); const h2 = hyp(s, { competing: [h1], if_true: pred("no_difference", 10), if_false: pred("intervention_lt_control", 30) }); return { h1, h2 }; };
const req = (h1: string, h2: string, o: Record<string, unknown> = {}) => ({ hypothesis_id: h1, distinguishes: [h2], base: { version: 1 }, ops: LEARNED, case_ids: [...LONG, SHORT], note: "n", ...o });
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
    expect(JSON.stringify(s.runExperiment(req("h-00000000", "h-00000000", { distinguishes: [] })))).toBe(JSON.stringify(UNKNOWN_ID));
    expect(s.counters.invalid_requests).toBe(1);
    const h1 = hyp(s);
    expect(s.runExperiment(req(h1, h1, { distinguishes: [] })).ok).toBe(true);
    expect(JSON.stringify(s.runExperiment(req(h1, h1, { distinguishes: [], case_ids: ["c-zz99zz99"] })))).toBe(JSON.stringify(UNKNOWN_ID));
    expect(s.counters.invalid_requests).toBe(2);
    const fence = s.runExperiment(req(h1, h1, { distinguishes: [], ops: [{ op: "remove_soft_edge", edge_id: "e19" }] }));
    expect(fence.error).toBe("invalid_request");
    expect(fence.stage).toBe("static");
    expect(s.locked).toBe(true);
    expect(s.stop?.reason).toBe("lockout");
    expect(s.runExperiment(req(h1, h1, { distinguishes: [] })).error).toBe("locked_out");
    expect(readStream(s.o.storeRoot, STREAMS.experiments).map((e) => e.record_type)).toEqual(["experiment.invalid", "experiment.completed", "experiment.invalid", "experiment.invalid"]);
    s.close();
  });

  it("refuses an experiment when no active hypothesis is registered", () => {
    const s = session();
    const h1 = hyp(s);
    expect(s.setStatus({ hypothesis_id: h1, status: "rejected", experiment_ids: [], evidence_event_ids: [eventId(SHORT, "st16")], note: "record-only rejection" }).ok).toBe(true);
    const r = s.runExperiment(req(h1, h1, { distinguishes: [] }));
    expect(r.error).toBe("preregistration");
    expect(s.counters.invalid_requests).toBe(1);
    hyp(s);
    expect(s.runExperiment(req(h1, h1, { distinguishes: [] })).ok).toBe(true);
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
    const h1 = hyp(s);
    for (let i = 0; i < 8; i++) expect(s.runExperiment(req(h1, h1, { distinguishes: [], case_ids: [LONG[i % 3]!] })).ok).toBe(true);
    expect(s.runExperiment(req(h1, h1, { distinguishes: [] })).error).toBe("budget_exhausted");
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
