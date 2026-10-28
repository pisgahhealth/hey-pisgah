import { describe, expect, it } from "vitest";
import { fixtureDefinition } from "../../workflow/test/fixture.js";
import { RULES_HASH, runDefinition, type ServiceQuery } from "../src/index.js";
import { fixtureSchedule } from "./schedule-fixture.js";

const def = fixtureDefinition();
const sched = fixtureSchedule(3, { takeHome: false });

describe("world service-time hook", () => {
  it("is consulted before the schedule and folds its hash into rules_hash", () => {
    const seen: ServiceQuery[] = [];
    const plain = runDefinition(def, sched, { use_agent: false });
    const hooked = runDefinition(def, sched, { use_agent: false, world: { rules_hash: "a".repeat(64), service_min: (q) => { seen.push(q); return q.action_kind === "check_document" ? 40 : undefined; } } });
    if (plain.outcome !== "ok" || hooked.outcome !== "ok") throw new Error("run aborted");
    expect(plain.rules_hash).toBe(RULES_HASH);
    expect(hooked.rules_hash).not.toBe(RULES_HASH);
    expect(seen.some((q) => q.action_kind === "check_document" && q.events.length > 0)).toBe(true);
    const started = (r: typeof plain) => Object.values(r.step_times).filter((t) => t.started_occ !== null).length;
    expect(started(hooked)).toBe(started(plain));
    expect(hooked.metrics.staff_min_by_role["nurse"]! - plain.metrics.staff_min_by_role["nurse"]!).toBe(35);
  });
  it("falls back to the schedule when the hook returns undefined", () => {
    const a = runDefinition(def, sched, { use_agent: false });
    const b = runDefinition(def, sched, { use_agent: false, world: { rules_hash: "b".repeat(64), service_min: () => undefined } });
    if (a.outcome !== "ok" || b.outcome !== "ok") throw new Error("run aborted");
    expect(b.events.map((e) => [e.kind, e.occurred_at])).toEqual(a.events.map((e) => [e.kind, e.occurred_at]));
  });
});

describe("world fact changes", () => {
  it("applies a fact at its minute, so a step that stops being required is never started after it", () => {
    const plain = runDefinition(def, sched, { use_agent: false });
    if (plain.outcome !== "ok") throw new Error("run aborted");
    const summary = (r: typeof plain) => r.events.filter((e) => e.kind === "step.started" && (e.payload as { step_id?: string }).step_id === "st06");
    expect(summary(plain).length).toBe(1);
    // The first world event is the earliest a change can land; everything before it must stay as it was.
    const at = Math.min(...plain.events.filter((e) => e.kind.startsWith("world.") || e.kind === "step.completed").map((e) => e.occurred_at)) + 1;
    const keep = (sched.facts["ward_requires"] as string[]).filter((d) => d !== "discharge_summary");
    const changed = runDefinition(def, sched, { use_agent: false, fact_changes: [{ at, facts: { ward_requires: keep } }] });
    if (changed.outcome !== "ok") throw new Error("run aborted");
    expect(changed.events.some((e) => e.kind === "world.facts_changed" && e.occurred_at === at)).toBe(true);
    expect(summary(changed).length).toBe(0);
    expect(changed.events.filter((e) => e.occurred_at < at).map((e) => e.event_id)).toEqual(plain.events.filter((e) => e.occurred_at < at).map((e) => e.event_id));
  });
});
