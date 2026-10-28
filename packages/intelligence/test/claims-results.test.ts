import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openStream } from "@hey-pisgah/store";
import { adoptionClaims, cycle2Result, discoveryClaims } from "../src/claims-results.js";
import { DiscoveryPool } from "../src/pool.js";
import { STREAMS, sessionStreamId } from "../src/session.js";

const run = (id: string, revision: number, hyps: number, exps: number) => ({
  run_id: id, commitment: { revision }, hypotheses: Array.from({ length: hyps }, (_, i) => ({ competing: i ? ["h-00000000"] : { none_identified_reason: "x" } })),
  experiments: Array.from({ length: exps }, () => ({ prediction_check: { after: { per_hypothesis: { "h-00000001": { landed: "if_false" } } } } }))
});
const Z = { recorded_at: 0, occurred_at: 0 };

describe("learning claims read from the published runs", () => {
  it("C-04 and C-05 read only the newest revision, and k of n still counts every run", () => {
    const d = discoveryClaims({ adaptive_runs: { runs: [run("run-a", 2, 3, 2), run("run-b", 7, 21, 0), run("run-c", 6, 0, 0)] } });
    expect(d).toMatchObject({ current_revision: 7, hypotheses: 21, experiments: 0, sublog_hashes_equal: null, k_of_n: { n: 3, current_revision_runs: 1, runs_with_hypotheses: 2, runs_with_experiments: 1 } });
    const e = discoveryClaims({ adaptive_runs: { runs: [run("run-a", 2, 3, 2)] } });
    expect(e).toMatchObject({ experiments: 2, sublog_hashes_equal: true, prediction_check_after_present: true, contradicted: 2, confirmed: 0 });
  });

  it("C-07 says the change was not exercised when every fresh patient lacks its condition, and C-08 reads the ward B run", () => {
    const demo = { runs: [{ step: "5", case_id: "c-5", acceptance_checks: { total: 12, failed: [] } }, { step: "6", case_id: "c-6", acceptance_checks: { total: 12, failed: [] }, path: "adapt", reported_flags: { conflict_before_first_non_compliant_action: true } }] };
    const emr = { version: 2, mode: "live", lines: ["Nothing to offer under version 2 for a self-pay patient."], offers_made: 0, readings: [{ step_id: "st09a", changed: true, status: "not_applicable", reason: "needs hmo" }] };
    const person = { kind: "person", display_name: "Ward manager" };
    const a = adoptionClaims(demo, emr, person, () => ({ payer_type: "self_pay" }));
    expect(a).toMatchObject({ adopted_by_person: true, ac09_pass: true, order_differs_where_diff_says: false, path: "adapted", conflict_before_noncompliant: true, wardB_demo: { ac05_pass: true } });
    expect(String(a["reason"])).toContain("self-pay");
    expect(adoptionClaims(demo, emr, { kind: "person", display_name: "Synthetic ward manager (issued by a build lane)" }, () => ({ payer_type: "hmo" }))).toMatchObject({ adopted_by_person: false, order_differs_where_diff_says: true });
  });

  it("C-10 records no result for a cycle that stops on its budget, and flags a proposal citing a hypothesis from elsewhere", () => {
    const root = mkdtempSync(join(tmpdir(), "cycle2-"));
    const runId = "run-cyc00001";
    const ev = new DiscoveryPool().event(new DiscoveryPool().get(new DiscoveryPool().ids()[0]!)!.events[0]!.event_id)!;
    const log = openStream(root, sessionStreamId(runId), { writer: true });
    log.append("session.opened", { commitment: { revision: 7, hash: "x" }, settings: { effort: "xhigh" }, model: "m" }, Z);
    log.append("session.stopped", { stop: "budget_calls", detail: "60 calls" }, Z);
    log.close();
    let r = cycle2Result(root, runId, { observed: [], outcomes: [] });
    expect(r).toMatchObject({ result: "no_result", cycle2_result_recorded: false, no_hypothesis_cited_as_evidence: true, stop: "budget_calls (60 calls)" });
    const l2 = openStream(root, sessionStreamId(runId), { writer: true });
    l2.append("proposal.linked", { proposal_id: "p-00000001" }, Z);
    l2.append("session.result", { result: "no_change_warranted", note: "n", evidence_event_ids: [ev.event.event_id] }, Z);
    l2.close();
    const p = openStream(root, STREAMS.proposals, { writer: true });
    p.append("proposal.submitted", { proposal_id: "p-00000001", parent_proposal_id: null, evidence: { hypothesis_ids: ["h-0ld00001"], experiment_ids: [], event_ids: [] } }, Z);
    p.close();
    r = cycle2Result(root, runId, { observed: [], outcomes: [] });
    expect(r).toMatchObject({ result: "no_change_warranted", cycle2_result_recorded: true, no_hypothesis_cited_as_evidence: false, cited_foreign_hypotheses: 1 });
  });
});
