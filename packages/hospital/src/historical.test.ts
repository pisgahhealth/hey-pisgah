import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkTwoClock, fencesHash, hashJson } from "@hey-pisgah/contracts";
import { loadV1 } from "./definition.js";
import { loadGoldenHashes, loadGoldenSchedule, loadHandCase } from "./fixtures.js";
import { loadStaff, practiceFor, runHistorical } from "./historical.js";
import { loadWorldParameters } from "./world.js";

const staff = loadStaff();

describe("staff profiles and world parameters", () => {
  it("parse, with every habit value present", () => {
    expect(new Set(staff.profiles.map((p) => p.prep_habit))).toEqual(new Set(["after_signoff", "early_draft", null]));
    expect(new Set(staff.profiles.map((p) => p.entry_habit))).toEqual(new Set(["realtime", "batch_after_round", "paper_then_type"]));
  });
  it("stay out of the main entry", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(/historical|hidden|staff/.test(index.replace(/^\/\/.*$/gm, ""))).toBe(false);
  });
  it("carry the two swept parameters and a tag on every base value", () => {
    const p = loadWorldParameters();
    expect([p.draft_verification_by_nurse.on, p.draft_verification_by_nurse.minutes, p.draft_use_by_staff.p]).toEqual([true, 4, 0.3]);
    expect(p.base.length).toBeGreaterThan(10);
    for (const b of p.base) expect(b.min).toBeLessThanOrEqual(b.max);
  });
});

describe("historical executor", () => {
  it("never removes a fence when it applies a habit", () => {
    for (const p of staff.profiles.filter((x) => x.role === "nurse")) {
      const s = { ...loadHandCase().schedule, staff: { ...loadHandCase().schedule.staff, nurse: p.staff_id } };
      expect(fencesHash(practiceFor(loadV1(), s, staff).def)).toBe(loadV1().metadata.fences_hash);
    }
  });
  it("starts the draft at the round for an early_draft nurse and at the clinical discharge otherwise", () => {
    const late = runHistorical(loadHandCase().schedule);
    const early = runHistorical(loadGoldenSchedule("golden/c-gold0002.json"));
    expect(late.step_times.st06!.started_occ!).toBeGreaterThanOrEqual(late.step_times.st05!.completed_occ!);
    expect(early.step_times.st06!.completed_occ!).toBeLessThan(early.step_times.st05!.completed_occ!);
  });
  it("records paper entries late with a reason and keeps every two-clock rule", () => {
    const r = runHistorical(loadGoldenSchedule("golden/c-gold0005.json"));
    const departed = r.events.find((e) => e.kind === "patient.departed")!;
    expect(departed.recorded_at - departed.occurred_at).toBe(240);
    expect(departed.late_entry_reason).toBeTruthy();
    for (const e of r.events) expect(checkTwoClock(e).ok).toBe(true);
  });
  it("skips the summary in Ward C and for a transfer out", () => {
    for (const f of ["golden/c-gold0004.json", "golden/c-gold0005.json"]) {
      const r = runHistorical(loadGoldenSchedule(f));
      expect(r.events.some((e) => e.subject === "discharge_summary")).toBe(false);
      expect(r.terminal_state).toBe("departed");
    }
  });
  it("blocks on a missing clinical discharge with no departure", () => {
    const s = structuredClone(loadHandCase().schedule);
    s.doctor.signoff_at = null;
    const r = runHistorical(s);
    expect([r.terminal_state, r.post_signoff_wait_min]).toEqual(["blocked_external", null]);
  });
});

describe("golden runs", () => {
  const golden = loadGoldenHashes();
  for (const [caseId, g] of Object.entries(golden.runs)) {
    it(`${caseId} reproduces its committed hash`, () => {
      const s = loadGoldenSchedule(g.fixture);
      const a = runHistorical(s);
      const b = runHistorical(s);
      expect(hashJson(a.events)).toBe(hashJson(b.events));
      expect([hashJson(a.events), a.post_signoff_wait_min, a.terminal_state]).toEqual([g.events_hash, g.post_signoff_wait_min, g.terminal_state]);
      expect(a.invariant_violations).toEqual([]);
    });
  }
  it("has five runs", () => expect(Object.keys(golden.runs).length).toBe(5));
});
