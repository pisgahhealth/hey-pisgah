import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimStatus, parseClaimPredicate } from "@hey-pisgah/evaluator";
import { Script, claimFields, didBy, percentile, speedTable, stepStatus, writeAccResults, type AccResult, type StepOutcome } from "../src/acceptance.js";

const claims = (JSON.parse(readFileSync(join(__dirname, "../../../evaluation/claims.json"), "utf8")) as { claims: { claim_id: string; acceptance: { predicate: string } }[] }).claims;
const status = (id: string, data: unknown) => claimStatus(parseClaimPredicate(claims.find((c) => c.claim_id === id)!.acceptance.predicate), data).status;
const step = (over: Partial<StepOutcome> = {}): StepOutcome => ({ line: "A01", patient: "A", step: "registration", who: "doctor", mode: "speak", did_by: "doctor", text: "x", heard: "x", line_id: "l1", line_end_at: null, verified: [], checks: [{ expect: { arrival: "A" }, ok: true, optional: false, detail: "" }], status: "verified", confirm: null, touches_during: 0, errors: [], started_at: "2026-10-30T10:00:00.000Z", ended_at: "2026-10-30T10:00:05.000Z", ...over });
function result(over: Partial<AccResult> = {}): AccResult {
  const rows = [{ kind: "record_observation", ms: 4100, owner: "doctor", line_id: "l2", action_id: "a1" }, { kind: "order_test", ms: 6000, owner: "doctor", line_id: "l3", action_id: "a2" }];
  return {
    measured_at: "2026-10-30T10:10:00.000Z", run_id: "t", kind: "rehearsal", driver: "say", browser: "launched", script_sha256: "0", engine_commit: "x", pisgah: "frozen", payment: "simulated",
    steps: [step()], touches: { emr: 1, strip: 1, source: "strip counter read from the browser", by_line: {}, other_people: [] }, touches_allowed: 4, confirmations_spoken: 3,
    speed: { rows, table: speedTable(rows, [], [600]), wake_ms: [600] }, errors: [], error_rows: [], faults: [], unaccounted: [],
    delegations: [{ id: "d1", team: "surgery", acknowledged: true, acknowledged_by_voice: true, completed_from_record: true, acknowledged_counted_as_done: false }],
    speakers: [{ line: "A05", who: "doctor", heard_as: "owner", acted_as_owner: true, order_written: true }, { line: "B07", who: "dr_b", heard_as: "other_clinician", acted_as_owner: false, order_written: false }],
    countersign: { batches: 2, batch_orders: 3, batch_signed_by_voice: true, changed_after_batch_unsigned: true, unmatched_voice_orders: 0 }, model: { calls: 10, usd: 0.1, rate_limited: 0 }, ...over
  };
}

describe("acceptance harness", () => {
  it("parses the private script when it is there, and refuses a spoken line with no words", () => {
    const file = process.env["ACC_SCRIPT"];
    if (file) expect(Script.parse(JSON.parse(readFileSync(file, "utf8"))).lines.length).toBeGreaterThan(10);
    expect(() => Script.parse({ version: 1, title: "t", rules: "r", voices: {}, people: {}, lines: [{ id: "A01", patient: "A", step: "s", who: "doctor", mode: "speak" }] })).toThrow();
  });
  it("takes the nearest-rank percentile and keeps errors beside their group", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 90)).toBe(5);
    expect(percentile([], 50)).toBeNull();
    const t = speedTable([{ kind: "record_observation", ms: 1000, owner: "doctor", line_id: "l", action_id: "a" }, { kind: "complete_task", ms: 9, owner: "doctor", line_id: "rec-x", action_id: "b", from_record: true }], [{ kind: "prescribe", owner: "doctor", action_id: "c", state: "refused", reason: "x" }], [700]);
    expect(t.map((r) => r.group)).toEqual(["wake", "vitals", "order", "complete_task"]);
    expect(t.find((r) => r.group === "order")).toMatchObject({ n: 0, p50_ms: null, errors: 1 });
    expect(t.find((r) => r.group === "complete_task")).toMatchObject({ n: 0, from_record: 1 });
  });
  it("never passes a step without a check", () => {
    expect(stepStatus([], false)).toBe("failed");
    expect(stepStatus([{ expect: { wake: true }, ok: false, optional: true, detail: "" }, { expect: { arrival: "A" }, ok: true, optional: false, detail: "" }], false)).toBe("partial");
    expect(stepStatus([{ expect: { arrival: "A" }, ok: true, optional: false, detail: "" }], true)).toBe("blocked");
  });
  it("names who did each step", () => {
    expect(didBy({ who: "doctor", mode: "speak" }, "human")).toMatch(/Samuel's own voice/);
    expect(didBy({ who: "accounts", mode: "person" }, "human")).toMatch(/simulated/);
    expect(didBy({ who: "surgeon", mode: "remote" }, "say")).toMatch(/stand-in/);
  });
  it("gives the registry's predicates the fields they read: green when met, red on false authority, not measured when touches were not counted", () => {
    const f = claimFields(result());
    for (const id of ["C-20", "C-22", "C-23", "C-24"] as const) expect(status(id, { ...f[id], previews_with_names: 0, privilege_gained: 0 }), id).toBe("green");
    expect(status("C-21", f["C-21"])).toBe("green");
    const liar = claimFields(result({ speakers: [{ line: "B07", who: "dr_b", heard_as: "owner", acted_as_owner: true, order_written: true }] }));
    expect(status("C-23", liar["C-23"])).toBe("red");
    expect(status("C-20", claimFields(result({ touches: { emr: null, strip: null, source: "not counted", by_line: {}, other_people: [] } }))["C-20"])).toBe("not_measured");
    expect(status("C-20", claimFields(result({ touches: { emr: 7, strip: 0, source: "strip counter read from the browser", by_line: {}, other_people: [] } }))["C-20"])).toBe("amber");
    expect(status("C-20", claimFields(result({ unaccounted: [{ owner: "doctor", kind: "record_note", action_id: "z", completed_at: null }] }))["C-20"])).toBe("red");
    const slowRows = [{ kind: "record_observation", ms: 9000, owner: "doctor", line_id: "l", action_id: "a" }, { kind: "prescribe", ms: 5000, owner: "doctor", line_id: "m", action_id: "b" }];
    expect(status("C-21", claimFields(result({ speed: { rows: slowRows, table: speedTable(slowRows, [], [800]), wake_ms: [800] } }))["C-21"])).toBe("amber");
    // A run that never measured a wake leaves the wake field out, so the claim reads not measured rather than a guess.
    expect(status("C-21", claimFields(result({ speed: { rows: slowRows, table: speedTable(slowRows, [], []), wake_ms: [] } }))["C-21"])).toBe("not_measured");
  });
  it("writes the claim files and keeps the lane floor already in speed.json", () => {
    const root = mkdtempSync(join(tmpdir(), "acc-"));
    mkdirSync(join(root, "evaluation", "results"), { recursive: true });
    writeFileSync(join(root, "evaluation", "results", "speed.json"), JSON.stringify({ floor_vitals_p50_ms: 7420, wake_p50_ms: 1 }));
    const files = writeAccResults(root, result(), { previews_with_names: 0, privilege_gained: 0 });
    expect(files.map((x) => x.split("/").at(-1)).sort()).toEqual(["acceptance.json", "countersign.json", "delegation.json", "speaker.json", "speed.json", "touches.json"]);
    const speed = JSON.parse(readFileSync(join(root, "evaluation", "results", "speed.json"), "utf8")) as Record<string, unknown>;
    expect(speed).toMatchObject({ floor_vitals_p50_ms: 7420, wake_p50_ms: 600, vitals_p50_ms: 4100, order_p50_ms: 6000, errors_listed: true });
    expect(JSON.parse(readFileSync(join(root, "evaluation", "results", "touches.json"), "utf8"))).toMatchObject({ touches: 1, touches_allowed: 4, silent_steps: 0 });
  });
});
