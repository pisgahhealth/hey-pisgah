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
