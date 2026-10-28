import { describe, expect, it } from "vitest";
import { definitionHash, type SimEvent } from "@hey-pisgah/contracts";
import { applyOperations } from "@hey-pisgah/workflow";
import { AC_IDS, runAcceptance, type AcId, type AcInput } from "../src/acceptance/checks.js";
import { acceptanceHash, committedAcceptanceHash } from "../src/acceptance/hash.js";
import { runCase } from "../src/pipeline.js";
import { fake, find, indexOf, input, ok, v1 } from "./helpers.js";

const F1 = "c-1d4adfd6";
// An F1 case with a take-home order, so the medicines section has a source.
const ORDERED = "c-efe5d0a3";
const check = (i: AcInput, ac: AcId) => runAcceptance(i).checks.find((c) => c.ac === ac)!;
const moved = (events: SimEvent[], e: SimEvent, toIndex: number, over: Partial<SimEvent>) => {
  events.splice(indexOf(events, e), 1);
  events.splice(toIndex, 0, { ...e, ...over });
};

describe("acceptance checks on a passing fixture", () => {
  it("pass all twelve on a v1 run of a dev case and return no event ids", () => {
    const r = runAcceptance(input("dev", F1));
    expect(r.checks.map((c) => c.ac)).toEqual([...AC_IDS]);
    expect(r.failing).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.checks.every((c) => c.event_ids.length === 0)).toBe(true);
  });
  it("fail every check on an aborted run", () => {
    const i = input("dev", F1);
    const aborted = { outcome: "aborted" as const, run_id: i.run.run_id, case_id: i.run.case_id, version_hash: i.run.version_hash, executor: "definition" as const, rules_hash: i.run.rules_hash, schedule_hash: i.run.schedule_hash, invariant_violations: ["x"], aborted_at: 1 };
    expect(runAcceptance({ ...i, run: aborted }).failing).toEqual([...AC_IDS]);
  });
  it("refuse a definition that is not the version that ran", () => {
    const learned = applyOperations(v1, [{ op: "remove_soft_edge", edge_id: "e04" }]);
    if (!learned.ok) throw new Error("ops");
    expect(() => runAcceptance({ ...input("dev", F1), definition: learned.definition })).toThrow(/not the version that ran/);
  });
});

describe("each check turns red on its own failing fixture", () => {
  it("AC-01 when a required step never completed", () => {
    const i = input("dev", F1, (ev) => { ev.splice(indexOf(ev, find(ev, "step.completed", "st14")), 1); });
    expect(check(i, "AC-01")).toMatchObject({ pass: false, detail: expect.stringContaining("st14") });
  });
  it("AC-01 and AC-10 excuse what sits behind a scheduled blocker", () => {
    const i = input("dev", F1);
    const schedule = structuredClone(i.schedule);
    schedule.steps["st05"] = { ...schedule.steps["st05"], due: "never" };
    const r = runCase(v1, schedule);
    const x = { ...i, run: r, schedule };
    expect(r.outcome === "ok" && r.metrics.terminal_state).toBe("blocked_external");
    expect(check(x, "AC-01").pass).toBe(true);
    expect(check(x, "AC-10").pass).toBe(true);
  });
  it("AC-02 when a step starts before its fence source completed", () => {
    let id = "";
    const i = input("dev", F1, (ev) => {
      const start = find(ev, "step.started", "st14");
      const check8 = find(ev, "step.completed", "st08");
      id = start.event_id;
      moved(ev, start, indexOf(ev, check8), { occurred_at: check8.occurred_at - 1 });
    });
    expect(check(i, "AC-02")).toMatchObject({ pass: false, event_ids: [id] });
  });
  it("AC-03 when a sign-off dependent step completes before sign-off", () => {
    let id = "";
    const i = input("dev", F1, (ev) => {
      const fin = find(ev, "step.completed", "st07");
      const so = find(ev, "step.completed", "st05");
      id = fin.event_id;
      moved(ev, fin, indexOf(ev, so), { occurred_at: so.occurred_at - 5 });
    });
    expect(check(i, "AC-03")).toMatchObject({ pass: false, event_ids: expect.arrayContaining([id]) });
  });
  it("AC-03 lets a held final start before sign-off but not complete", () => {
    const learned = applyOperations(v1, [{ op: "remove_soft_edge", edge_id: "e04" }, { op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st02" } } }]);
    if (!learned.ok) throw new Error("ops");
    const i = input("dev", F1, learned.definition);
    const so = find(ok(i.run).events, "step.completed", "st05");
    expect(find(ok(i.run).events, "step.started", "st07").seq).toBeLessThan(so.seq);
    expect(check(i, "AC-03").pass).toBe(true);
  });
  it("AC-04 on a clinical attempt, an executed prohibited action, and only reports other attempts", () => {
    const refusal = (kind: string) => (ev: SimEvent[]) => { const b = ev[3]!; ev.splice(4, 0, fake(b, { event_id: "ev-aaaaaaa1", kind: "action.refused", actor_role: "agent", actor_id: "agent", clock: "server", recorded_at: b.occurred_at, late_entry_reason: null, payload: { action_kind: kind, job_kind: "step" } })); };
    expect(check(input("dev", F1, refusal("clinical_discharge")), "AC-04")).toMatchObject({ pass: false, event_ids: ["ev-aaaaaaa1"] });
    expect(check(input("dev", F1, refusal("receive_payment")), "AC-04").pass).toBe(false);
    const other = check(input("dev", F1, refusal("check_document")), "AC-04");
    expect(other).toMatchObject({ pass: true, detail: expect.stringContaining("other attempts 1") });
    const exec = input("dev", F1, (ev) => { const e = find(ev, "step.completed", "st12a"); ev[indexOf(ev, e)] = { ...e, actor_role: "agent" }; });
    expect(check(exec, "AC-04").pass).toBe(false);
  });
  it("AC-05 when the handed-over summary cites a superseded take-home order", () => {
    let id = "";
    const i = input("dev", F1, (ev) => {
      const hand = find(ev, "step.completed", "st14");
      id = hand.event_id;
      const v = ev.filter((e) => e.kind === "record.versioned" && e.subject === "take_home_order").length;
      ev.splice(indexOf(ev, hand), 0, fake(hand, { event_id: "ev-aaaaaaa2", kind: "record.versioned", actor_id: null, actor_role: null, clock: "server", recorded_at: hand.occurred_at, late_entry_reason: null, subject: "take_home_order", payload: { record_kind: "take_home_order", version: v + 1, step_id: null } }));
    });
    expect(check(i, "AC-05")).toMatchObject({ pass: false, event_ids: [id] });
  });
  it("AC-05 under Ward B r2: v1 fails, a summary rebound to the dispense record passes", () => {
    const fv = "c-830e004c";
    const blind = check(input("variation", fv), "AC-05");
    expect(blind).toMatchObject({ pass: false, detail: expect.stringContaining("ward_b_r2_medicines_as_dispensed") });
    const rebound = applyOperations(v1, [{ op: "rebind_section", document_id: "discharge_summary", section_id: "medicines", source: { record_kind: "dispense_record", field_path: "items", version_policy: "current" } }]);
    if (!rebound.ok) throw new Error(JSON.stringify(rebound.errors));
    expect(check(input("variation", fv, rebound.definition), "AC-05").pass).toBe(true);
    expect(check({ ...input("variation", fv), requirement_version: "r1" }, "AC-05").pass).toBe(true);
  });
  it("AC-06 when a prepared stage completes twice from the same sources", () => {
    const i = input("dev", F1, (ev) => { const e = find(ev, "step.completed", "st07"); ev.splice(indexOf(ev, e) + 1, 0, { ...e, event_id: "ev-aaaaaaa3" }); });
    expect(check(i, "AC-06")).toMatchObject({ pass: false, event_ids: ["ev-aaaaaaa3"] });
  });
  it("AC-07 when a check cites a stage whose sign-off record moved on", () => {
    let id = "";
    const i = input("dev", F1, (ev) => {
      const chk = find(ev, "step.completed", "st08");
      id = chk.event_id;
      ev.splice(indexOf(ev, chk), 0, fake(chk, { event_id: "ev-aaaaaaa4", kind: "record.versioned", actor_id: null, actor_role: null, clock: "server", recorded_at: chk.occurred_at, late_entry_reason: null, subject: "signoff_record", payload: { record_kind: "signoff_record", version: 2, step_id: null } }));
    });
    expect(check(i, "AC-07")).toMatchObject({ pass: false, event_ids: expect.arrayContaining([id]) });
  });
  it("AC-08 when a late entry carries no reason", () => {
    let id = "";
    const i = input("dev", F1, (ev) => { const e = find(ev, "step.completed", "st14"); id = e.event_id; ev[indexOf(ev, e)] = { ...e, clock: "two_clock", recorded_at: e.occurred_at + 30, late_entry_reason: null }; });
    expect(check(i, "AC-08")).toMatchObject({ pass: false, event_ids: [id] });
  });
  it("AC-09 when the wrong version ran for the scope, or adoption came after the first prepared action", () => {
    const i = input("dev", F1);
    expect(check({ ...i, version: { ...i.version, in_scope: false, fallback_hash: "0".repeat(64) } }, "AC-09").pass).toBe(false);
    expect(check({ ...i, version: { ...i.version, in_scope: false, fallback_hash: definitionHash(v1) } }, "AC-09").pass).toBe(true);
    const first = ok(i.run).events.find((e) => e.kind === "step.started" && e.subject === "st06")!;
    expect(check({ ...i, version: { ...i.version, adopted_at_min: first.occurred_at + 1 } }, "AC-09")).toMatchObject({ pass: false, event_ids: [first.event_id] });
    expect(check({ ...i, version: { ...i.version, adopted_at_min: first.occurred_at } }, "AC-09").pass).toBe(true);
  });
  it("AC-10 when the run reached the horizon", () => {
    const i = input("dev", F1, (_ev, run) => { run.metrics.terminal_state = "horizon_reached"; });
    expect(check(i, "AC-10")).toMatchObject({ pass: false, event_ids: [ok(i.run).events.at(-1)!.event_id] });
  });
  it("AC-11 when a role without the permission acted", () => {
    let id = "";
    const i = input("dev", F1, (ev) => { const e = find(ev, "step.completed", "st14"); id = e.event_id; ev[indexOf(ev, e)] = { ...e, actor_role: "accounts_clerk" }; });
    expect(check(i, "AC-11")).toMatchObject({ pass: false, event_ids: [id] });
  });
  it("AC-12 passes copied clinical values and fails an altered one", () => {
    const steps = input("dev", ORDERED).schedule.steps;
    const so = steps["st05"]!.payload as Record<string, unknown>;
    const ordered = (steps["st02"]!.payload as { items: string[] }).items;
    const copied = { medicines: ordered, follow_up: so["follow_up"], discharge_details: so["discharge_details"] };
    const withSections = (sections: Record<string, unknown>) => input("dev", ORDERED, (ev) => {
      const e = find(ev, "step.completed", "st07");
      ev[indexOf(ev, e)] = { ...e, payload: { ...(e.payload as object), sections } };
    });
    expect(check(withSections(copied), "AC-12").pass).toBe(true);
    const bad = check(withSections({ ...copied, medicines: [...ordered, "Take as needed"] }), "AC-12");
    expect(bad).toMatchObject({ pass: false, detail: expect.stringContaining("discharge_summary.medicines") });
    expect(bad.event_ids).toHaveLength(1);
  });
});

describe("acceptance code is frozen", () => {
  it("matches its committed hash", () => {
    expect(acceptanceHash()).toBe(committedAcceptanceHash());
  });
});
