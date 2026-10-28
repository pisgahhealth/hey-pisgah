import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkTwoClock, fencesHash, hashJson, type RunResult } from "@hey-pisgah/contracts";
import { loadV1 } from "./definition.js";
import { loadGoldenHashes, loadGoldenSchedule, loadHandCase } from "./fixtures.js";
import { loadStaff, practiceFor, runHistorical } from "./historical.js";
import { loadWardRequirements, wardRequiresList } from "./requirements.js";
import { loadWorldParameters } from "./world.js";

const staff = loadStaff();
const ok = (r: RunResult) => { if (r.outcome !== "ok") throw new Error(r.invariant_violations.join("; ")); return r; };
const fixtures = ["hand/f1.json", "golden/c-gold0002.json", "golden/c-gold0003.json", "golden/c-gold0004.json", "golden/c-gold0005.json"];

describe("staff profiles and world parameters", () => {
  it("parse, with every habit value present", () => {
    expect(new Set(staff.profiles.map((p) => p.prep_habit))).toEqual(new Set(["after_signoff", "early_draft", null]));
    expect(new Set(staff.profiles.map((p) => p.entry_habit))).toEqual(new Set(["realtime", "batch_after_round", "paper_then_type"]));
  });
  it("stay out of the main entry", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(/historical|hidden|staff/.test(index.replace(/^\/\/.*$/gm, ""))).toBe(false);
  });
  it("carry the swept parameters and both world rules, all tagged", () => {
    const p = loadWorldParameters();
    expect([p.draft_verification_by_nurse.on, p.draft_verification_by_nurse.minutes, p.draft_use_by_staff.p]).toEqual([true, 4, 0.3]);
    expect([p.world_rules.summary_check.min_unseen, p.world_rules.summary_check.min_seen, p.world_rules.summary_check.tag, p.world_rules.nurse_window.tag]).toEqual([20, 5, "assumed", "assumed"]);
    for (const b of p.base) expect(b.min).toBeLessThanOrEqual(b.max);
  });
  it("give every fixture the ward_requires list its ward's r1 implies", () => {
    const set = loadWardRequirements();
    for (const f of fixtures) {
      const s = loadGoldenSchedule(f);
      const facts = { ...s.facts } as Record<string, string>;
      expect(s.facts["ward_requires"], f).toEqual(wardRequiresList(set, String(s.facts["ward_id"]), facts));
    }
  });
});

describe("historical executor", () => {
  it("never removes a fence when it applies a habit", () => {
    for (const p of staff.profiles.filter((x) => x.role === "nurse")) {
      const s = { ...loadHandCase().schedule, actors: { ...loadHandCase().schedule.actors, nurse: p.staff_id } };
      expect(fencesHash(practiceFor(loadV1(), s, staff).def)).toBe(loadV1().metadata.fences_hash);
    }
  });
  it("starts the draft at the round for an early_draft nurse and at the clinical discharge otherwise", () => {
    const late = ok(runHistorical(loadHandCase().schedule));
    const early = ok(runHistorical(loadGoldenSchedule("golden/c-gold0002.json")));
    expect(late.step_times["st06"]!.started_occ!).toBeGreaterThanOrEqual(late.step_times["st05"]!.completed_occ!);
    expect(early.step_times["st06"]!.completed_occ!).toBeLessThan(early.step_times["st05"]!.completed_occ!);
  });
  it("records a paper departure late with a reason and keeps every two-clock rule", () => {
    const r = ok(runHistorical(loadGoldenSchedule("golden/c-gold0005.json")));
    const left = r.events.find((e) => e.kind === "step.completed" && e.subject === "st16")!;
    expect(left.recorded_at - left.occurred_at).toBe(240);
    expect(left.late_entry_reason).toBeTruthy();
    for (const e of r.events) expect(checkTwoClock(e).ok).toBe(true);
  });
  it("skips the summary in Ward C and for a transfer out", () => {
    for (const f of ["golden/c-gold0004.json", "golden/c-gold0005.json"]) {
      const r = ok(runHistorical(loadGoldenSchedule(f)));
      expect(r.events.some((e) => (e.payload as Record<string, unknown> | null)?.["document_id"] === "discharge_summary")).toBe(false);
      expect(r.metrics.terminal_state).toBe("departed");
    }
  });
  it("blocks on a missing clinical discharge with no departure", () => {
    const s = structuredClone(loadHandCase().schedule);
    s.steps["st05"] = { due: "never" };
    const r = ok(runHistorical(s));
    expect([r.metrics.terminal_state, r.metrics.post_signoff_wait_min]).toEqual(["blocked_external", null]);
  });
});

describe("golden runs", () => {
  const golden = loadGoldenHashes();
  for (const [caseId, g] of Object.entries(golden.runs)) {
    it(`${caseId} reproduces its committed hash`, () => {
      const s = loadGoldenSchedule(g.fixture);
      const a = ok(runHistorical(s));
      const b = ok(runHistorical(s));
      expect(hashJson(a.events)).toBe(hashJson(b.events));
      expect([hashJson(a.events), a.metrics.post_signoff_wait_min, a.metrics.terminal_state]).toEqual([g.events_hash, g.post_signoff_wait_min, g.terminal_state]);
    });
  }
  it("has five runs", () => expect(Object.keys(golden.runs).length).toBe(5));
});
