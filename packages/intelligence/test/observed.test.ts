import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DiscoveryPool, loadObserved } from "../src/pool.js";
import { listCases, timeline } from "../src/views.js";

const OBSERVED = new URL("../../../evaluation/results/observed-cases.json", import.meta.url).pathname;

describe("observed EMR journeys in the investigation pool", () => {
  it("lists them beside the synthetic pool as observed, readable on both clocks, and never as experiment cases", () => {
    const file = JSON.parse(readFileSync(OBSERVED, "utf8")) as { cases: { case_id: string }[] };
    const pool = new DiscoveryPool(undefined, [], loadObserved(OBSERVED));
    const rows = (listCases(pool).cases as { case_id: string; source: string }[]);
    expect(rows.filter((r) => r.source === "observed").map((r) => r.case_id).sort()).toEqual(file.cases.map((c) => c.case_id).sort());
    expect(rows.filter((r) => r.source === "history").length).toBe(new DiscoveryPool().ids().length);
    const id = file.cases[0]!.case_id;
    expect(pool.experimentable(id)).toBeNull();
    const byRecorded = timeline(pool.get(id)!, { case_id: id, order: "recorded", kinds: ["record.written"] }).items as { occurred_at: number; recorded_at: number }[];
    expect(byRecorded.length).toBeGreaterThan(0);
    expect(byRecorded.every((e) => e.recorded_at >= e.occurred_at)).toBe(true);
  });

  it("refuses an observed file whose events break the frozen event shape", () => {
    const bad = { cases: [{ case_id: "c-00000000", ward_id: "A", payer_type: "self_pay", requirement_version: "r1", facts: {}, events: [{ event_id: "not-an-id" }] }] };
    const f = new URL("./.observed-bad.json", import.meta.url).pathname;
    writeFileSync(f, JSON.stringify(bad));
    try { expect(() => loadObserved(f)).toThrow(); } finally { rmSync(f); }
  });
});
