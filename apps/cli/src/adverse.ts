import { findCase } from "@hey-pisgah/cases";
import type { WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { runCase } from "@hey-pisgah/evaluator";

type Row = Record<string, unknown>;
type Lag = { lag_min: number; reason: string };

// Why one dev case waited longer under a version: when the round entry happened, when it reached the record, when sign-off came, and when each version started the summary draft.
export function adverseCase(base: WD, def: WD, caseId: string): Row {
  const file = findCase(caseId)?.file;
  if (!file) throw new Error(`no case ${caseId}`);
  const s = file.schedule;
  const b = runCase(base, s), q = runCase(def, s);
  if (b.outcome !== "ok" || q.outcome !== "ok") return { case_id: caseId, outcome: [b.outcome, q.outcome] };
  const st = (r: typeof b, id: string) => r.step_times[id] ?? { started_occ: null, completed_occ: null, completed_rec: null };
  const lagKey = Object.keys((s as { entry_lag?: Record<string, Lag> }).entry_lag ?? {}).find((k) => k.startsWith("step.completed|st01|"));
  const lag = lagKey ? (s as unknown as { entry_lag: Record<string, Lag> }).entry_lag[lagKey]! : null;
  const round = st(b, "st01"), signoff = st(b, "st05");
  const wait = (q.metrics.post_signoff_wait_min ?? 0) - (b.metrics.post_signoff_wait_min ?? 0);
  const late = round.completed_rec !== null && signoff.completed_rec !== null && round.completed_rec > signoff.completed_rec;
  return {
    case_id: caseId, ward_id: s.facts["ward_id"], wait_delta_min: wait, wait_base_min: b.metrics.post_signoff_wait_min, wait_version_min: q.metrics.post_signoff_wait_min,
    round_entry_at: round.completed_occ, round_entry_in_record_at: round.completed_rec, signoff_in_record_at: signoff.completed_rec,
    entry_lag_min: lag?.lag_min ?? null, entry_lag_reason: lag?.reason ?? null,
    draft_start_base: st(b, "st06").started_occ, draft_start_version: st(q, "st06").started_occ,
    family: late ? "round entry in the record after sign-off" : "other",
    why: late
      ? `the round entry happened at minute ${round.completed_occ} but reached the record at minute ${round.completed_rec}${lag ? ` (${lag.reason.replace(/\.$/, "").toLowerCase()}, ${lag.lag_min} minutes late)` : ""}, after sign-off at minute ${signoff.completed_rec}; version ${def.version} starts the draft only after the round entry is in the record, so the draft waited until minute ${st(q, "st06").started_occ}, where version ${base.version} started it at sign-off (minute ${st(b, "st06").started_occ})`
      : `the wait changed by ${wait} minutes for a reason other than a late round entry`
  };
}
