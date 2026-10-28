import { eventLogHash } from "@hey-pisgah/simulator";
import type { ExternalSchedule } from "@hey-pisgah/simulator";
import { runHistorical } from "@hey-pisgah/hospital/historical";
import type { History } from "./types.js";

// Discovery histories come from the historical executor with the hidden staff profiles; only the event log is kept, never a metric.
export function historyFor(schedule: ExternalSchedule): History {
  const r = runHistorical(schedule);
  if (r.outcome !== "ok") throw new Error(`historical run aborted for ${schedule.case_id}: ${r.invariant_violations.join("; ")}`);
  return { executor: "historical", version_hash: r.version_hash, rules_hash: r.rules_hash, events_hash: eventLogHash(r.events), events: r.events };
}
