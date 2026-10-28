import { RunResult, hashJson, type SimEvent } from "@hey-pisgah/contracts";
import { applyOperations, findCycle, allPrecedences } from "@hey-pisgah/workflow";
import { describe, expect, it } from "vitest";
import { fixtureDefinition, rng } from "../../workflow/test/fixture.js";
import { randomOp } from "../../workflow/test/random-op.js";
import {
  Engine, PermissionGate, PriorityQueue, RULES_HASH, SimInvariantViolation, externalSubLog, externalSubLogHash, installRunInvariants,
  runDefinition, visibleAt
} from "../src/index.js";
import { fixtureSchedule } from "./schedule-fixture.js";

const def = fixtureDefinition();
const early = (() => { const a = applyOperations(def, [{ op: "remove_soft_edge", edge_id: "e04" }]); if (!a.ok) throw new Error("refused"); return a.definition; })();
const okRun = (d = def, s = fixtureSchedule(1)) => {
  const r = runDefinition(d, s);
  if (r.outcome !== "ok") throw new Error(r.invariant_violations.join("; "));
  return r;
};
const ofKind = (es: readonly SimEvent[], kind: string, subject?: string) => es.filter((e) => e.kind === kind && (subject === undefined || e.subject === subject));

describe("definition executor", () => {
  it("returns a RunResult that parses, departs and carries the exported rules hash", () => {
    const r = okRun();
    expect(RunResult.safeParse(r).success).toBe(true);
    expect(r.metrics.terminal_state).toBe("departed");
    expect(r.rules_hash).toBe(RULES_HASH);
    expect(r.metrics.required_steps_done).toBe(r.metrics.required_steps_total);
    expect(r.decided_by_counts.model).toBe(0);
    expect(r.decided_by_counts.runtime).toBe(r.metrics.agent_actions);
    expect(r.events.map((e) => e.seq)).toEqual(r.events.map((_, i) => i + 1));
  });

  it("an agent-prepared stage costs one minute and an agent draft waits for the checker's verification", () => {
    const r = okRun();
    const start = ofKind(r.events, "step.started", "st06")[0]!;
    const verified = ofKind(r.events, "check.verified", "st06")[0]!;
    const done = ofKind(r.events, "step.completed", "st06")[0]!;
    expect(start.actor_role).toBe("agent");
    expect(verified.occurred_at - start.occurred_at).toBe(1 + 4);
    expect(done.occurred_at).toBe(verified.occurred_at);
  });

  it("matched control and intervention share the external sub-log but not the full log", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = fixtureSchedule(seed, { amendAt: 600, takeHome: true });
      const c = okRun(def, s), i = okRun(early, s);
      expect(externalSubLog(c.events).length).toBeGreaterThan(3);
      expect(externalSubLogHash(i.events)).toBe(externalSubLogHash(c.events));
      expect(hashJson(i.events)).not.toBe(hashJson(c.events));
      expect(i.schedule_hash).toBe(c.schedule_hash);
    }
  });

  it("an early draft goes stale when the take-home order is amended and is revised as rework", () => {
    const s = fixtureSchedule(4, { amendAt: 560, takeHome: true });
    const c = okRun(def, s), i = okRun(early, s);
    expect(ofKind(i.events, "step.completed", "st06")[0]!.occurred_at).toBeLessThan(ofKind(c.events, "step.completed", "st06")[0]!.occurred_at);
    expect(ofKind(i.events, "document.revised").length).toBeGreaterThan(0);
    expect(i.metrics.rework_events).toBeGreaterThan(c.metrics.rework_events);
    expect(i.metrics.rework_min).toBeGreaterThan(0);
  });

  it("a stage prepared and then no longer required counts as unnecessary work", () => {
    const s = fixtureSchedule(2, { takeHome: false });
    s.steps["st05"] = { ...s.steps["st05"], sets_facts: { ward_requires: [] } };
    expect(okRun(def, s).metrics.unnecessary_docs).toBe(0);
    const i = okRun(early, s);
    expect(i.metrics.unnecessary_docs).toBeGreaterThan(0);
    expect(i.metrics.unnecessary_min).toBeGreaterThan(0);
  });

  it("a sign-off that never comes ends blocked on a scheduled blocker", () => {
    const s = fixtureSchedule(3);
    s.steps["st05"] = { due: "never" };
    const r = okRun(def, s);
    expect(r.metrics.terminal_state).toBe("blocked_external");
    expect(r.metrics.post_signoff_wait_min).toBeNull();
  });

  it("an entry later than the grace with no reason aborts with no metrics", () => {
    const s = fixtureSchedule(1);
    s.entry_lag["step.completed|st01|doctor-7|1"] = { lag_min: 30, reason: null };
    const r = runDefinition(def, s);
    expect(r.outcome).toBe("aborted");
    if (r.outcome !== "aborted") return;
    expect("metrics" in r).toBe(false);
    expect("events" in r).toBe(false);
    expect(r.invariant_violations.join(" ")).toContain("late_without_reason");
    expect(RunResult.safeParse(r).success).toBe(true);
  });

  it("the fence, permission and data-integrity invariants fire on a forged log", () => {
    const forge = (kind: string, step_id: string, role: string, action_kind: string) => {
      const eng = new Engine("c-0000abcd", "run-0000abcd");
      installRunInvariants(eng, def, new PermissionGate(def.permissions), () => true);
      eng.at(5, 0, "forge", 0, () => { eng.emit({ kind, actor_id: "x", actor_role: role, subject: step_id, payload: { step_id, action_kind } }); });
      try { eng.run(); return []; } catch (e) { return e instanceof SimInvariantViolation ? e.violations : [String(e)]; }
    };
    expect(forge("step.started", "st13", "accounts_clerk", "financial_clearance").join(" ")).toContain("fence e16");
    expect(forge("step.started", "st06", "agent", "clinical_discharge").join(" ")).toContain("permission agent on clinical_discharge");
    expect(forge("step.completed", "st07", "agent", "prepare_document").join(" ")).toContain("data_integrity");
  });

  it("the permission gate refuses and counts every prohibited agent kind", () => {
    const g = new PermissionGate(def.permissions);
    for (const k of ["clinical_discharge", "dispense", "receive_payment", "financial_clearance", "adopt_version"]) expect(g.attempt("agent", k)).toBe(false);
    expect(g.attempt("agent", "prepare_document")).toBe(true);
    expect(g.attempted).toBe(5);
    expect(g.executed).toBe(0);
  });

  it("visibleAt hides events recorded after t", () => {
    const s = fixtureSchedule(1);
    s.entry_lag["step.completed|st01|doctor-7|1"] = { lag_min: 40, reason: "entered after the round" };
    const r = okRun(def, s);
    const st01 = ofKind(r.events, "step.completed", "st01")[0]!;
    expect(st01.recorded_at - st01.occurred_at).toBe(40);
    expect(visibleAt(r.events, st01.occurred_at)).not.toContainEqual(st01);
    expect(visibleAt(r.events, st01.recorded_at)).toContainEqual(st01);
    for (const t of [0, 300, st01.occurred_at + 10, 900, 2880]) expect(visibleAt(r.events, t).every((e) => e.recorded_at <= t)).toBe(true);
  });

  it("random accepted operation sequences never trip an invariant", () => {
    const r = rng(42);
    let runs = 0;
    for (let i = 0; runs < 40 && i < 2000; i++) {
      const res = applyOperations(def, Array.from({ length: 1 + Math.floor(r() * 3) }, () => randomOp(r, def)));
      if (!res.ok) continue;
      expect(findCycle(allPrecedences(res.definition))).toBeNull();
      for (const seed of [11, 12]) {
        const out = runDefinition(res.definition, fixtureSchedule(seed, { payer: seed === 12 ? "hmo" : "self_pay", amendAt: 590 }));
        expect(out.outcome, out.outcome === "aborted" ? out.invariant_violations.join("; ") : "").toBe("ok");
      }
      runs += 1;
    }
    expect(runs).toBe(40);
  });

  it("orders the queue by time, then phase, then stable key", () => {
    const q = new PriorityQueue();
    const seen: string[] = [];
    q.push({ time: 5, phase: 3, key: "a", run: () => seen.push("t5p3") });
    q.push({ time: 5, phase: 0, key: "z", run: () => seen.push("t5p0z") });
    q.push({ time: 5, phase: 0, key: "b", run: () => seen.push("t5p0b") });
    q.push({ time: 1, phase: 3, key: "x", run: () => seen.push("t1") });
    while (q.size) q.pop()!.run();
    expect(seen).toEqual(["t1", "t5p0b", "t5p0z", "t5p3"]);
  });
});
