import { readFileSync } from "node:fs";
import { loadPool } from "@hey-pisgah/cases";
import type { HypothesisRecord } from "@hey-pisgah/contracts";
import { readStream } from "@hey-pisgah/store";

type Row = Record<string, unknown>;
const MANIFESTS = new URL("../data/manifests/discovery.json", import.meta.url).pathname;
const MINUTE_METRICS = new Set(["post_signoff_wait_min", "bed_release_delay_min", "unnecessary_min", "rework_min"]);
const HYPOTHESES_STREAM = "learning/hypotheses";

// C-16: a delay hypothesis on an F3 case mistakes late entry for delay when it cites a late-entered event in support; null when no delay hypothesis cites an F3 case.
export function twoClockClaim(runs: readonly { storeRoot: string; runId: string }[]): Row {
  const files = loadPool("discovery");
  // Families are the evaluator's data and never reach the investigator; this measurement runs after the session.
  const manifests = JSON.parse(readFileSync(MANIFESTS, "utf8")) as { case_id: string; family: string }[];
  const f3 = new Set(manifests.filter((m) => m.family === "F3").map((m) => m.case_id));
  const late = new Set(files.flatMap((f) => (f.history?.events ?? []).filter((e) => e.late_entry_reason).map((e) => e.event_id)));
  let delay = 0, onF3 = 0, mistaken = 0;
  const lateCited = new Set<string>();
  const perRun: Row[] = [];
  for (const r of runs) {
    const hyps = readStream(r.storeRoot, HYPOTHESES_STREAM).filter((e) => e.record_type === "hypothesis.recorded" && (e.payload as Row)["session_id"] === r.runId).map((e) => e.payload as HypothesisRecord);
    const d = hyps.filter((h) => MINUTE_METRICS.has(h.if_true.metric));
    const f = d.filter((h) => h.evidence.some((x) => f3.has(x.case_id)));
    const m = f.filter((h) => h.evidence.some((x) => f3.has(x.case_id) && x.stance === "supports" && late.has(x.event_id)));
    const cited = new Set(f.flatMap((h) => h.evidence.filter((x) => late.has(x.event_id)).map((x) => x.event_id)));
    delay += d.length; onF3 += f.length; mistaken += m.length;
    for (const id of cited) lateCited.add(id);
    perRun.push({ run_id: r.runId, hypotheses: hyps.length, delay_hypotheses: d.length, delay_hypotheses_on_f3: f.length, late_entries_cited: cited.size, mistaken: m.map((h) => h.hypothesis_id) });
  }
  return { delay_hypotheses: delay, delay_hypotheses_on_f3: onF3, recorded_clock_delay_hypotheses_on_f3: onF3 > 0 ? mistaken : null, n: onF3 > 0 ? mistaken : null, late_entries_cited: lateCited.size, f3_cases: f3.size, late_entry_events: late.size, runs: perRun };
}

