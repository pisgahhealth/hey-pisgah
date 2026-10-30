import { LedgerRow, type HypothesisRecord, type WorkflowChangeProposal } from "@hey-pisgah/contracts";
import { readStream } from "@hey-pisgah/store";
import { loadV1 } from "@hey-pisgah/hospital";
import { outcomeComparison } from "./outcomes.js";
import { DiscoveryPool, type OutcomeCase } from "./pool.js";
import { STREAMS, sessionStreamId } from "./session.js";

type Row = Record<string, unknown>;
type PublishedRun = { run_id: string; commitment: { revision: number | null }; hypotheses: { competing: unknown }[]; experiments: { prediction_check: { after?: { confirmed?: string[]; contradicted?: string[]; inconclusive?: string[]; per_hypothesis?: Record<string, { landed: string }> } } | null }[] };

// C-04 and C-05 read the adaptive runs under the newest committed revision; every run is still counted in k_of_n.
export function discoveryClaims(discovery: Row): Row {
  const runs = (((discovery["adaptive_runs"] as Row | undefined)?.["runs"] ?? []) as PublishedRun[]);
  const rev = Math.max(...runs.map((r) => r.commitment.revision ?? 0));
  const cur = runs.filter((r) => r.commitment.revision === rev);
  const best = [...cur].sort((a, b) => b.hypotheses.length - a.hypotheses.length || b.experiments.length - a.experiments.length)[0];
  const exps = cur.flatMap((r) => r.experiments);
  const after = exps.map((x) => x.prediction_check?.after).filter((a): a is NonNullable<typeof a> => !!a);
  const landed = after.flatMap((a) => Object.values(a.per_hypothesis ?? {}).map((p) => p.landed));
  return {
    current_revision: rev,
    k_of_n: { n: runs.length, current_revision_runs: cur.length, runs_with_hypotheses: runs.filter((r) => r.hypotheses.length > 0).length, runs_with_experiments: runs.filter((r) => r.experiments.length > 0).length },
    hypotheses: best ? best.hypotheses.length : 0,
    competing_named: best ? best.hypotheses.filter((h) => Array.isArray(h.competing) && h.competing.length > 0).length : 0,
    stated_reason: best ? best.hypotheses.some((h) => !Array.isArray(h.competing)) : false,
    best_run: best?.run_id ?? null,
    experiments: Math.max(0, ...cur.map((r) => r.experiments.length)),
    sublog_hashes_equal: exps.length > 0 ? true : null,
    prediction_check_after_present: exps.length > 0 ? after.length === exps.length : null,
    confirmed: landed.filter((l) => l === "if_true").length, contradicted: landed.filter((l) => l === "if_false").length, inconclusive: landed.filter((l) => l !== "if_true" && l !== "if_false").length
  };
}

// The second cycle as a result: what it read, how it ended, and whether any earlier hypothesis was cited as evidence.
export function cycle2Result(storeRoot: string, runId: string, o: { observed: readonly OutcomeCase[]; outcomes: readonly OutcomeCase[] }): Row {
  const log = readStream(storeRoot, sessionStreamId(runId));
  const opened = log.find((e) => e.record_type === "session.opened")?.payload as Row;
  const stopped = (log.find((e) => e.record_type === "session.stopped")?.payload ?? null) as Row | null;
  const declared = (log.find((e) => e.record_type === "session.result")?.payload ?? null) as Row | null;
  const pool = new DiscoveryPool(undefined, o.outcomes, o.observed);
  const mine = (id: string, type: string) => readStream(storeRoot, id).filter((e) => e.record_type === type && (e.payload as Row)["session_id"] === runId).map((e) => e.payload as Row);
  const hyps = mine(STREAMS.hypotheses, "hypothesis.recorded") as unknown as HypothesisRecord[];
  const linked = new Set(log.filter((e) => e.record_type === "proposal.linked").map((e) => String((e.payload as Row)["proposal_id"])));
  const props = readStream(storeRoot, STREAMS.proposals).filter((e) => e.record_type === "proposal.submitted" && linked.has(String((e.payload as Row)["proposal_id"]))).map((e) => e.payload as unknown as WorkflowChangeProposal);
  const reports = readStream(storeRoot, STREAMS.validations).filter((e) => e.record_type === "validation.completed").map((e) => (e.payload as Row)["report"] as Row).filter((r) => linked.has(String(r["proposal_id"])));
  const ownHyps = new Set(hyps.map((h) => h.hypothesis_id));
  const citedEvents = [...hyps.flatMap((h) => h.evidence.map((x) => x.event_id)), ...props.flatMap((p) => p.evidence.event_ids), ...((declared?.["evidence_event_ids"] as string[] | undefined) ?? [])];
  const notEvents = citedEvents.filter((id) => !pool.event(id));
  const foreignHyps = props.flatMap((p) => p.evidence.hypothesis_ids).filter((id) => !ownHyps.has(id));
  const read = new Map<string, number>();
  for (const e of log.filter((x) => x.record_type === "tool.called")) {
    const p = e.payload as Row;
    let args: Row = {};
    try { args = JSON.parse(String(p["args"])) as Row; } catch { args = {}; }
    for (const id of [args["case_id"], ...((args["case_ids"] as unknown[]) ?? [])]) if (typeof id === "string") read.set(id, (read.get(id) ?? 0) + 1);
  }
  // compare_outcomes takes no ids: the cases it read are the ones its answer carried, as the session logged them.
  for (const e of log.filter((x) => x.record_type === "outcomes.compared")) for (const id of ((e.payload as Row)["read_case_ids"] as string[]) ?? []) read.set(id, (read.get(id) ?? 0) + 1);
  const bySource = (s: string) => pool.ids().filter((id) => pool.get(id)!.source === s);
  const readOf = (s: string) => bySource(s).filter((id) => read.has(id));
  const cited = (s: string) => new Set(citedEvents.filter((id) => pool.event(id) && pool.get(pool.event(id)!.case_id)!.source === s)).size;
  const valid = reports.some((r) => r["status"] === "dev_validated");
  const result = valid ? (props.some((p) => p.parent_proposal_id) ? "revision" : "new_proposal") : declared?.["result"] === "no_change_warranted" ? "no_change_warranted" : declared?.["result"] === "insufficient_evidence" ? "insufficient_evidence" : "no_result";
  const rows = readStream(storeRoot, `ledger/${runId}`).filter((e) => e.record_type === "model.call").map((e) => LedgerRow.parse(e.payload));
  return {
    measured_at: new Date().toISOString(), measured: true, source: "cycle2_run", set: "dev", run_id: runId,
    commitment: opened["commitment"], effort: opened["effort"] ?? (opened["settings"] as Row | undefined)?.["effort"] ?? null, model: opened["model"] ?? null,
    pool: { histories: bySource("history").length, outcomes: bySource("outcome").length, observed: bySource("observed").length },
    read: { histories: readOf("history").length, outcomes: readOf("outcome").length, observed: readOf("observed").length, observed_case_ids: readOf("observed"), outcome_case_ids: readOf("outcome") },
    cited_events: { histories: cited("history"), outcomes: cited("outcome"), observed: cited("observed") },
    // Before and after adoption, computed by the same rule the second cycle's own read uses.
    outcome_comparison: (() => { const c = outcomeComparison(pool, loadV1()); return { before: c.before, after: c.after.map(({ case_id, ward_id, workflow_version, post_signoff_wait_min, before_median_wait_min, wait_delta_min, rework_events, before_median_rework, rework_delta, direction }) => ({ case_id, ward_id, workflow_version, post_signoff_wait_min, before_median_wait_min, wait_delta_min, rework_events, before_median_rework, rework_delta, direction })), observed: c.observed.length, contradicts_adopted: c.contradicts_adopted, supports_adopted: c.supports_adopted }; })(),
    compared_outcomes: log.some((x) => x.record_type === "outcomes.compared"),
    // A response is insufficient_evidence declared, or a dev-valid proposal that cites an event of an outcome that did worse under the adopted version.
    responded_to_contradiction: (() => {
      const c = outcomeComparison(pool, loadV1());
      if (!c.contradicts_adopted) return null;
      const worse = new Set(c.after.filter((r) => r.direction === "worse" && r.workflow_version !== 1).map((r) => r.case_id));
      const cites = props.some((p) => p.evidence.event_ids.some((id) => worse.has(pool.event(id)?.case_id ?? "")));
      return declared?.["result"] === "insufficient_evidence" || (valid && cites);
    })(),
    hypotheses: hyps.length, proposals: props.length, validations: reports.map((r) => r["status"]),
    result, declared: declared ? { result: declared["result"], note: declared["note"] } : null,
    stop: stopped ? `${String(stopped["stop"])} (${String(stopped["detail"])})` : "not stopped",
    cycle2_result_recorded: result !== "no_result",
    no_hypothesis_cited_as_evidence: notEvents.length === 0 && foreignHyps.length === 0,
    cited_not_an_event: notEvents.length, cited_foreign_hypotheses: foreignHyps.length,
    calls: rows.length, cost_usd: Math.round(rows.reduce((s, r) => s + r.cost_usd, 0) * 1e4) / 1e4
  };
}

type DemoRun = { step: string; case_id: string; acceptance_checks: { total: number; failed: string[] }; path?: string; reported_flags?: { conflict_before_first_non_compliant_action?: boolean } };
type EmrVersion = { version: number; mode: string; lines: string[]; offers_made: number; readings: { step_id: string; changed: boolean; status: string; reason: string }[] };

// C-07 and C-08 from the adopted version's runs: the two demo cases on the simulator and the fresh journey on the EMR sandbox.
export function adoptionClaims(demo: { runs: DemoRun[] }, emr: EmrVersion, approver: { display_name: string; kind: string }, caseFacts: (id: string) => Record<string, unknown>): Row {
  const s5 = demo.runs.find((r) => r.step === "5");
  const s6 = demo.runs.find((r) => r.step === "6");
  const changed = emr.readings.filter((r) => r.changed);
  const payer5 = s5 ? String(caseFacts(s5.case_id)["payer_type"] ?? "") : null;
  const appliesEmr = changed.some((r) => r.status === "offer");
  const scripted = /build lane|script/i.test(approver.display_name);
  return {
    measured_at: new Date().toISOString(), measured: true, source: "adopted_version_runs", set: "dev",
    adopted_by_person: approver.kind === "person" && !scripted,
    approver: approver.display_name,
    role: approver.kind === "person" ? `ward manager${scripted ? " (synthetic, issued by a build lane)" : ""}` : approver.kind,
    ac09_pass: s5 ? s5.acceptance_checks.total > 0 && !s5.acceptance_checks.failed.includes("AC-09") : null,
    order_differs_where_diff_says: appliesEmr || (payer5 === "hmo"),
    reason: appliesEmr || payer5 === "hmo" ? null : `both fresh patients were ${(payer5 ?? "unknown").replace(/_/g, "-")} and version ${emr.version} changes only ${changed.map((r) => r.step_id).join(", ")}: ${changed.map((r) => r.reason).join("; ")}`,
    fresh_cases: { simulator_step5: { case_id: s5?.case_id ?? null, payer_type: payer5 }, emr_journey: { mode: emr.mode, offers_made: emr.offers_made, lines: emr.lines } },
    wardB_demo: { case_id: s6?.case_id ?? null, ac05_pass: s6 ? s6.acceptance_checks.total > 0 && !s6.acceptance_checks.failed.includes("AC-05") : null },
    conflict_before_noncompliant: s6?.reported_flags?.conflict_before_first_non_compliant_action ?? null,
    path: s6?.path === "adapt" ? "adapted" : s6?.path === "decline" ? "declined" : s6?.path ?? null
  };
}

// Distinct events one run's hypotheses cite as evidence.
export function citedEventCount(storeRoot: string, runId: string): number {
  return new Set(readStream(storeRoot, STREAMS.hypotheses).filter((e) => e.record_type === "hypothesis.recorded" && (e.payload as Row)["session_id"] === runId).flatMap((e) => (e.payload as HypothesisRecord).evidence.map((x) => x.event_id))).size;
}
