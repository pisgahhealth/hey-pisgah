import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPool } from "@hey-pisgah/cases";
import { openStream } from "@hey-pisgah/store";
import { twoClockClaim } from "../src/two-clock.js";

const MANIFESTS = JSON.parse(readFileSync(new URL("../data/manifests/discovery.json", import.meta.url), "utf8")) as { case_id: string; family: string }[];
const f3 = MANIFESTS.find((m) => m.family === "F3")!.case_id;
const other = MANIFESTS.find((m) => m.family !== "F3")!.case_id;
const events = (id: string) => loadPool("discovery").find((f) => f.case_id === id)!.history!.events;
const late = events(f3).find((e) => e.late_entry_reason)!;
const plain = events(f3).find((e) => !e.late_entry_reason)!;
const pred = { metric: "post_signoff_wait_min", comparison: "intervention_lt_control", tolerance_min: 10, scope: { cases: [f3] } };

function store(evidence: { event_id: string; case_id: string; stance: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), "two-clock-"));
  const s = openStream(root, "learning/hypotheses", { writer: true });
  s.append("hypothesis.recorded", { hypothesis_id: "h-00000001", session_id: "run-tc000001", evidence: evidence.map((x) => ({ ...x, note: "" })), if_true: pred, if_false: { ...pred, comparison: "no_difference" } }, { recorded_at: 0, occurred_at: 0 });
  s.close();
  return root;
}

describe("C-16: late entry read as delay", () => {
  it("counts a delay hypothesis that cites a late entry on the late-entry case in support, and says when none touched one", () => {
    const o = events(other)[0]!;
    const bad = twoClockClaim([{ storeRoot: store([{ event_id: late.event_id, case_id: f3, stance: "supports" }, { event_id: o.event_id, case_id: other, stance: "context" }]), runId: "run-tc000001" }]);
    expect(bad).toMatchObject({ recorded_clock_delay_hypotheses_on_f3: 1, late_entries_cited: 1, delay_hypotheses_on_f3: 1 });
    const untouched = twoClockClaim([{ storeRoot: store([{ event_id: plain.event_id, case_id: f3, stance: "supports" }, { event_id: o.event_id, case_id: other, stance: "context" }]), runId: "run-tc000001" }]);
    expect(untouched).toMatchObject({ recorded_clock_delay_hypotheses_on_f3: 0, late_entries_cited: 0 });
    const none = twoClockClaim([{ storeRoot: store([{ event_id: o.event_id, case_id: other, stance: "supports" }]), runId: "run-tc000001" }]);
    expect(none.recorded_clock_delay_hypotheses_on_f3).toBeNull();
  });
});
