import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimStatus, parseClaimPredicate } from "@hey-pisgah/evaluator";
import { Script, bindLine, claimFields, completion, didBy, fakeRealign, percentile, speedTable, stepStatus, writeAccResults, type AccResult, type HeardRow, type StepOutcome } from "../src/acceptance.js";

const claims = (JSON.parse(readFileSync(join(__dirname, "../../../evaluation/claims.json"), "utf8")) as { claims: { claim_id: string; acceptance: { predicate: string } }[] }).claims;
const status = (id: string, data: unknown) => claimStatus(parseClaimPredicate(claims.find((c) => c.claim_id === id)!.acceptance.predicate), data).status;
const step = (over: Partial<StepOutcome> = {}): StepOutcome => ({ line: "A01", patient: "A", step: "registration", who: "doctor", mode: "speak", did_by: "doctor", text: "x", heard: "x", line_id: "l1", line_end_at: null, verified: [], checks: [{ expect: { arrival: "A" }, ok: true, optional: false, detail: "" }], status: "verified", confirm: null, touches_during: 0, errors: [], started_at: "2026-10-30T10:00:00.000Z", ended_at: "2026-10-30T10:00:05.000Z", ...over });
function result(over: Partial<AccResult> = {}): AccResult {
  const rows = [{ kind: "record_observation", ms: 4100, owner: "doctor", line_id: "l2", action_id: "a1" }, { kind: "order_test", ms: 6000, owner: "doctor", line_id: "l3", action_id: "a2" }];
  return {
    measured_at: "2026-10-30T10:10:00.000Z", run_id: "t", kind: "rehearsal", driver: "say", browser: "launched", script_sha256: "0", engine_commit: "x", pisgah: "frozen", payment: "simulated", presence: "heartbeat",
    steps: [step()], touches: { emr: 1, strip: 1, source: "strip counter read from the browser", by_line: {}, other_people: [] }, touches_allowed: 4, confirmations_spoken: 3,
    speed: { rows, table: speedTable(rows, [], [600]), wake_ms: [600] }, errors: [], error_rows: [], faults: [], unaccounted: [],
    delegations: [{ id: "d1", team: "surgery", acknowledged: true, acknowledged_by_voice: true, completed_from_record: true, acknowledged_counted_as_done: false }],
    speakers: [{ line: "A05", who: "doctor", heard_as: "owner", acted_as_owner: true, order_written: true }, { line: "B07", who: "dr_b", heard_as: "other_clinician", acted_as_owner: false, order_written: false }],
    countersign: { batches: 2, batch_orders: 3, batch_signed_by_voice: true, changed_after_batch_unsigned: true, unmatched_voice_orders: 0 }, model: { calls: 10, usd: 0.1, rate_limited: 0 }, harness_errors: [], completion: { complete: true, reasons: [] }, ...over
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
    // Review 4: a name heard with another spelling is held, never passed, and a held step keeps the run from completing.
    const heldName = { expect: { identity: "A" as const, name: "Emeka Nwosu" }, ok: false, optional: false, detail: "held, uncertain: Amika Emikonvosu", held: true };
    expect(stepStatus([heldName, { expect: { arrival: "A" }, ok: true, optional: false, detail: "" }], false)).toBe("held");
    expect(stepStatus([heldName, { expect: { arrival: "A" }, ok: false, optional: false, detail: "" }], false)).toBe("failed");
    expect(completion(result({ steps: [step({ line: "B02", status: "held" })] }), 0).reasons).toEqual(["B02 held"]);
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
  it("calls a run complete only when every mandatory step verified and every fault ran and recovered", () => {
    const r = result({ faults: [{ kind: "restart", line: "R1", at: "", killed_during: null, restarted_in_ms: 600, outcome: "ok", ok: true }] });
    expect(completion(r, 1)).toEqual({ complete: true, reasons: [] });
    expect(completion(r, 2).reasons).toEqual(["1 of 2 faults never ran"]);
    expect(completion(result({ steps: [step(), step({ line: "A09", status: "failed" })] }), 0).reasons).toEqual(["A09 failed"]);
    expect(completion(result({ faults: [{ kind: "interrupt", line: "A11", at: "", killed_during: "sent", restarted_in_ms: 600, outcome: "write gone", ok: false }] }), 1).complete).toBe(false);
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
  it("binds a step to its heard line when the ear wrote the numbers as digits or the line was withheld (pass 9: A06, A13, B07)", () => {
    const at = (s: number) => new Date(Date.parse("2026-10-31T01:19:00.000Z") + s * 1000).toISOString();
    const rows: HeardRow[] = [
      { line_id: "u-a06", text: "blood pressure is 90 over 60, pulse 112. Tammed is 38.9", at: at(8), kept: true, ambient: { raw_text: "BP is ninety over sixty, pulse one hundred and twelve. Tammed is thirty eight point nine" } },
      { line_id: "u-a14", text: "", at: at(111), kept: false, decided: false },
      { line_id: "u-a13", text: "", at: at(118), kept: false, decided: true },
      { line_id: "u-a07", text: "Suffs 96 on room air. Respirate 22", at: at(40), kept: true, ambient: { raw_text: "Suffs ninety six on room air. Respirate twenty two" } }
    ];
    const claimed = new Set<string>();
    expect(bindLine("BP is ninety over sixty, pulse one hundred and twelve, temp is thirty eight point nine.", at(0), rows, claimed)?.line_id).toBe("u-a06");
    expect(bindLine("Sats ninety six on room air, resp rate twenty two.", at(30), rows, claimed)?.line_id).toBe("u-a07");
    // A refused or unacted line keeps no words in the store, so the step takes the first decided, withheld line heard after it began; one still being decided may yet show its words.
    expect(bindLine("Let's cancel the urinalysis for now, we'll do it on the ward later.", at(110), rows, claimed)?.line_id).toBe("u-a13");
    // Nothing heard after the step began is nothing bound, and a claimed line is never bound twice.
    expect(bindLine("When the malaria result comes back, let me know.", at(200), rows, claimed)).toBeNull();
    expect(bindLine("Sats ninety six on room air, resp rate twenty two.", at(30), rows, claimed)).toBeNull();
  });
  it("plays a reloaded page's fake microphone on from the reload, with the file's zero moved by the time listening took to return", () => {
    // Pass 9: listening started at t0, the page reloaded 1370 s later and listened again 12 s after that.
    const r = fakeRealign(1_000_000, 1_000_000 + 1_370_000, 1_000_000 + 1_382_000);
    expect(r.cutMs).toBe(1_370_000);
    // A line due at 1400 s into the original file now plays 12 s later on the wall clock.
    expect(r.fakeT0 + 1_400_000).toBe(1_000_000 + 1_412_000);
    expect(fakeRealign(5000, 1000, 2000).cutMs).toBe(0);
  });
});
