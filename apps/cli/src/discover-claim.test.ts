import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { devDistribution } from "./dev-distribution.js";
import { discoverSummary, exactInterval } from "./discover-claim.js";

const repo = join(import.meta.dirname, "..", "..", "..");
const commitments = JSON.parse(readFileSync(join(repo, "evaluation", "commitments", "intelligence.json"), "utf8")) as { revisions: { revision: number }[] };
const read = (f: string) => JSON.parse(readFileSync(join(repo, "evaluation", "results", f), "utf8")) as Record<string, unknown>;

describe("discovery counts", () => {
  it("gives the exact 95% interval for k of n", () => {
    const a = exactInterval(2, 3);
    expect(a.lower).toBeCloseTo(0.0943, 3);
    expect(a.upper).toBeCloseTo(0.9916, 3);
    expect(exactInterval(0, 3)).toMatchObject({ lower: 0 });
    expect(exactInterval(0, 3).upper).toBeCloseTo(0.7076, 3);
    expect(exactInterval(3, 3)).toMatchObject({ upper: 1 });
  });

  it("reconciles 10 of 33 with 10 of 31, reads the latest configuration's rate, and matches the committed file", () => {
    const d = read("discovery.json");
    const s = discoverSummary(d, { invariancePass: true, adopted: "p-a563fe32", tradeOffs: [{ metric: "rework_events", sum_delta: 4 }, { metric: "rework_min", sum_delta: 4 }], currentRevision: commitments.revisions.at(-1)!.revision });
    expect([s["discover_history_dev_valid"], s["discover_history_runs"]]).toEqual([10, 33]);
    expect([s["discover_dev_valid_any"], s["discover_runs_listed"]]).toEqual([10, 31]);
    expect([s["discover_dev_valid"], s["discover_runs"]]).toEqual([8, 17]);
    expect([s["discover_config_revision"], s["discover_config_dev_valid"], s["discover_config_runs"], s["discover_config_lower"], s["discover_config_upper"]]).toEqual([12, 6, 8, 0.35, 0.97]);
    const byRev = s["discover_history_by_revision"] as { runs: number; dev_valid: number }[];
    expect(byRev.reduce((n, r) => n + r.runs, 0)).toBe(33);
    expect(byRev.reduce((n, r) => n + r.dev_valid, 0)).toBe(10);
    const f = (s["discover_findings"] as string[]).join(" ");
    expect(f).toContain("high effort was 0 of 3 dev-valid against medium 2 of 3");
    expect(f).toContain("the pair variant at revision 10 was 0 of 2");
    for (const k of Object.keys(s)) expect(d[k], `${k} in the committed file`).toEqual(s[k]);
  });
});

describe("the adopted change's dev cases", () => {
  it("carries the distribution beside the fresh-case figure and says simulator", () => {
    const m = read("improve.json");
    expect(m["measured_in"]).toBe("simulator");
    expect([m["dev_cases"], m["dev_median_wait_delta_min"], m["dev_moved"], m["dev_shorter"], m["dev_longer"]]).toEqual([15, 0, 5, 4, 1]);
    const d = m["dev_distribution"] as { wait_deltas_min: { case_id: string; in_scope: boolean; wait: number; rework: number }[] };
    const again = devDistribution({ proposal_id: "p", status: "dev_validated", cases: d.wait_deltas_min.map((c) => ({ case_id: c.case_id, in_scope: c.in_scope, delta: { post_signoff_wait_min: c.wait, rework_min: c.rework } })) });
    expect([again["median_wait_delta_min"], again["moved"], again["shorter"], again["longer"]]).toEqual([0, 5, 4, 1]);
  });
});
