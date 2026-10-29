import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runValidationStream } from "@hey-pisgah/evaluator";
import { STREAMS, Session, dispatch, type StoredExperiment } from "@hey-pisgah/intelligence";
import { readStream } from "@hey-pisgah/store";
import { describe, expect, it } from "vitest";

// The planted change, scripted with no model: the oracle replay of the research note's step 0.
const PLANTED = [{ op: "remove_soft_edge", edge_id: "e04" }, { op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st02" } } }];
const LONG = ["c-491dbab0", "c-8c9cd194", "c-ed324a69"];
const SHORT = "c-11060afa";

type R = Record<string, unknown>;
const call = async (s: Session, name: string, args: unknown): Promise<R> => dispatch(s, name, JSON.stringify(args), { turn: 1 });

function eventOf(s: Session, caseId: string, step: string): string {
  return s.pool.get(caseId)!.events.find((e) => e.kind === "step.completed" && e.subject === step)!.event_id;
}

describe("oracle replay through the investigator's own tools", () => {
  it("records, tests and submits the planted change, and the dev gate validates it", async () => {
    const store = mkdtempSync(join(tmpdir(), "hp-oracle-"));
    const s = new Session({ storeRoot: store, runId: "run-0ac1e000", arm: "adaptive", validate: async (root) => { await runValidationStream(root); } });
    const evidence = [
      { event_id: eventOf(s, LONG[0]!, "st05"), case_id: LONG[0], stance: "context", note: "clinical discharge" },
      { event_id: eventOf(s, LONG[0]!, "st16"), case_id: LONG[0], stance: "supports", note: "departure" },
      { event_id: eventOf(s, SHORT, "st16"), case_id: SHORT, stance: "contradicts", note: "short wait" }
    ];
    const down = { metric: "post_signoff_wait_min", comparison: "intervention_lt_control", tolerance_min: 30, scope: { cases: LONG } };
    const same = { metric: "post_signoff_wait_min", comparison: "no_difference", tolerance_min: 10, scope: { cases: LONG } };
    const h1 = await call(s, "record_hypothesis", { statement: "The summary draft waits for the clinical discharge.", mechanism: "Its edge and its trigger both wait on the clinical discharge.", subject_refs: ["st06"], competing: { none_identified_reason: "first reading" }, evidence, if_true: down, if_false: same, refuted_if: "The wait does not fall.", revises: null });
    expect(h1.ok).toBe(true);
    const h2 = await call(s, "record_hypothesis", { statement: "Payment timing sets the wait.", mechanism: "Clearance waits for the sponsor.", subject_refs: ["st13"], competing: [h1.hypothesis_id], evidence, if_true: same, if_false: down, refuted_if: "The summary change alone cuts the wait.", revises: null });
    expect(h2.ok).toBe(true);
    const x = await call(s, "run_experiment", { hypothesis_id: h1.hypothesis_id, distinguishes: [h2.hypothesis_id], base: { version: 1 }, ops: PLANTED, case_ids: [...LONG, SHORT], note: "planted change" });
    expect(x.ok).toBe(true);
    const cases = x.cases as { case_id: string; delta: { post_signoff_wait_min: number } }[];
    for (const c of cases.filter((y) => LONG.includes(y.case_id))) expect(c.delta.post_signoff_wait_min).toBeLessThanOrEqual(-30);
    const stored = readStream(store, STREAMS.experiments).find((e) => e.record_type === "experiment.completed")!.payload as StoredExperiment;
    expect(stored.prediction_check.before.distinguishes).toEqual([[h1.hypothesis_id, h2.hypothesis_id]]);
    expect(stored.prediction_check.after!.per_hypothesis[String(h1.hypothesis_id)]).toEqual({ landed: "if_true" });
    expect(stored.prediction_check.after!.per_hypothesis[String(h2.hypothesis_id)]).toEqual({ landed: "if_false" });
    expect((await call(s, "set_hypothesis_status", { hypothesis_id: h1.hypothesis_id, status: "retained", experiment_ids: [x.experiment_id], evidence_event_ids: [], note: "wait fell" })).ok).toBe(true);
    expect((await call(s, "set_hypothesis_status", { hypothesis_id: h2.hypothesis_id, status: "rejected", experiment_ids: [x.experiment_id], evidence_event_ids: [], note: "summary change alone moved it" })).ok).toBe(true);
    const p = await call(s, "submit_proposal", { parent_proposal_id: null, base_version: 1, ops: PLANTED, scope: { wards: "all", condition: null }, rationale: "Planted change.", evidence: { hypothesis_ids: [h1.hypothesis_id], experiment_ids: [x.experiment_id], event_ids: [evidence[1]!.event_id] }, expected_effects: [{ metric: "post_signoff_wait_min", direction: "down", subgroup_condition: null }], known_exceptions: [] });
    expect(p.ok).toBe(true);
    expect(p.validation).toBe("dev_validated");
    expect(s.stop?.reason).toBe("dev_valid_proposal");
    const report = await call(s, "get_validation_report", { proposal_id: p.proposal_id });
    const summary = report.summary as { median_wait_delta: number; cases: number };
    expect(summary.cases).toBe(15);
    expect((report.gate as { pass: boolean }).pass).toBe(true);
    const cut = (report.cases as { delta: { post_signoff_wait_min: number | null } }[]).filter((c) => (c.delta.post_signoff_wait_min ?? 0) <= -30).length;
    expect(cut).toBeGreaterThan(0);
    s.close();
  });
});
