import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findCase } from "@hey-pisgah/cases";
import { hashJson, type Clocks } from "@hey-pisgah/contracts";
import { loadV1, worldRules } from "@hey-pisgah/hospital";
import { openStream } from "@hey-pisgah/store";
import { Registry, type PersonApprover } from "@hey-pisgah/workflow";
import { caseWorldFile, parseCaseFile, type WorldSpec } from "../src/cases.js";
import { scriptedAgent } from "../src/mock.js";
import { HospitalPort } from "../src/port.js";
import { startServe } from "../src/serve.js";
import { VersionDesk, VersionError } from "../src/versions.js";
import type { CaseWorld } from "../src/world.js";
import { GOAL, OWNER, baseCase, harness, ofType, r2, tempRoot, variant } from "./helpers.js";

const A_PRIOR = (JSON.parse(readFileSync(new URL("../fixtures/proposals/a-prior.json", import.meta.url), "utf8")) as { proposal: { ops: unknown[]; scope: { wards: "all"; condition: null } } }).proposal;
const MANAGER: PersonApprover = { kind: "person", staff_id: "wm_test", role: "ward_manager", display_name: "Synthetic ward manager (test)" };
const AT: Clocks = { occurred_at: 0, recorded_at: 0, wall_at: "2026-10-28T12:00:00Z" };
const meta = { author: { kind: "model_session" as const, id: "p-test0001" }, proposal_id: "p-test0001", source_evidence: { event_ids: [], hypothesis_ids: [], experiment_ids: [], validation_report_id: null }, model_provenance: null };

// The registry with the A-prior change adopted as version 2, falling back to v1.
function adoptedRegistry(): Registry {
  const r = Registry.load([loadV1()]);
  r.propose(1, A_PRIOR.ops, meta, { scope: A_PRIOR.scope, fallback: 1 });
  r.setValidation(2, "dev_validated");
  r.adopt(2, MANAGER, AT);
  return r;
}
const poolWorld = (id: string, spec: WorldSpec): CaseWorld => parseCaseFile(JSON.stringify(caseWorldFile(findCase(id)!.file, spec)));
const doc = (document_id: string, stage: string, case_id = "c-agent001") => ({ case_id, document_id, stage });

describe("runtime guards on conflicts and questions", () => {
  it("refuses and counts an uncited conflict, a non-question and a fourth question", () => {
    const port = HospitalPort.open(tempRoot(), baseCase(), Registry.load([loadV1()]), worldRules());
    port.advanceTo(600);
    const ev = port.events()[0]!.event_id;
    const conflict = (o: Record<string, unknown>) => ({ case_id: "c-agent001", version: 1, requirement_version: "r1", explanation: "The procedure text and the edge disagree.", evidence: [ev], definition_element: { kind: "edge", id: "e04" }, ...o });
    expect(port.commit("raise_workflow_conflict", conflict({ requirement_version: "r2" }), "k1")).toMatchObject({ ok: false, reason: "conflict_uncited", counted: true });
    expect(port.commit("raise_workflow_conflict", conflict({ definition_element: { kind: "edge", id: "e99" } }), "k2")).toMatchObject({ reason: "conflict_uncited" });
    expect(port.commit("raise_workflow_conflict", conflict({ evidence: ["ev-00000000"] }), "k3")).toMatchObject({ reason: "conflict_uncited" });
    expect(port.commit("raise_workflow_conflict", conflict({ definition_element: { kind: "step", id: "st06" } }), "k4").ok).toBe(true);
    const ask = (question: string) => ({ case_id: "c-agent001", role: "nurse", question });
    expect(port.commit("ask_staff", ask("Call me back."), "k5")).toMatchObject({ reason: "not_a_question", counted: true });
    for (let i = 0; i < 3; i++) expect(port.commit("ask_staff", ask(`Is the take-home order final, item ${i}?`), `k${6 + i}`).ok).toBe(true);
    expect(port.commit("ask_staff", ask("Is the order final now?"), "k9")).toMatchObject({ reason: "ask_limit_reached", counted: true });
    expect(port.commit("ask_staff", { case_id: "c-agent001", question: "Who signs?" }, "k10")).toMatchObject({ reason: "invalid_arguments", counted: false });
    expect(port.refusedCount()).toBe(5);
  });

  it("counts the same refusals in the task when the model makes them", async () => {
    const root = tempRoot();
    const forbidden = [
      { name: "ask_staff", args: { case_id: "c-agent001", role: "doctor", question: "Sign now" } },
      { name: "raise_workflow_conflict", args: { case_id: "c-agent001", version: 1, requirement_version: "r1", explanation: "x", evidence: [], definition_element: { kind: "step", id: "st99" } } },
      { name: "revise_document", args: doc("discharge_summary", "draft") }
    ];
    const h = harness(root, { mock: scriptedAgent({ forbidden }), runtime: { maxTurnsPerTick: 40 } });
    h.rt.start();
    const id = h.rt.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER });
    await h.rt.settled();
    const refused = ofType(root, id, "agent.refused").map((e) => (e.payload as { reason: string }).reason);
    expect(refused).toEqual(["not_a_question", "conflict_uncited", "no_such_tool"]);
    expect(h.rt.projection(id).state).toBe("done");
    await h.close();
  });
});

describe("adoption, suspension and revert", () => {
  // A planted proposal and a planted dev_validated report, so the desk's own checks are what is under test.
  function planted(root: string, hashOverride?: string, gate: Record<string, unknown> | null = { rework_budget_min_per_case: 10, rework_max_added_min: 2, rework_within_budget: true }): string {
    const r = Registry.load([loadV1()]);
    const built = r.propose(1, A_PRIOR.ops, meta, { scope: A_PRIOR.scope, fallback: 1 }).version!;
    const body = { proposal_id: "p-aaaa0001", parent_proposal_id: null, base_version: 1, ops: A_PRIOR.ops, scope: A_PRIOR.scope, rationale: "r", evidence: { hypothesis_ids: [], experiment_ids: [], event_ids: [] }, expected_effects: [], known_exceptions: [], viewed_case_ids: [], status: "submitted" };
    const ps = openStream(root, "learning/proposals", { writer: true });
    const e = ps.append("proposal.submitted", { ...body, hash: hashJson(body) }, { recorded_at: 0, occurred_at: 0 });
    ps.close();
    const vs = openStream(root, "learning/validations", { writer: true });
    vs.append("validation.completed", { proposal_ref: { stream_id: e.stream_id, seq: e.seq }, report: { status: "dev_validated", hashes: { proposal: hashOverride ?? built.definition_hash }, gate } }, { recorded_at: 0, occurred_at: 0 });
    vs.close();
    return "p-aaaa0001";
  }

  it("refuses a non-person, adopts for a person with both clocks, survives a restart and keeps content immutable", () => {
    const root = tempRoot();
    const id = planted(root);
    const desk = new VersionDesk(root, Registry.load([loadV1()]));
    const agent = { kind: "agent", staff_id: "ag-1", role: "ward_manager", display_name: "agent" };
    expect(() => desk.adopt(id, agent)).toThrow(VersionError);
    expect(() => desk.adopt(id, { ...MANAGER, role: "nurse" })).toThrow(/person's decision/);
    expect(desk.refusedCount()).toBe(2);
    const v = desk.adopt(id, MANAGER, 0, "2026-10-28T12:00:00.000Z");
    expect([v.version, v.status, v.fallback_version, v.metadata.approver?.staff_id, v.metadata.adopted_at]).toEqual([2, "adopted", 1, "wm_test", { occurred_at: 0, recorded_at: 0, wall_at: "2026-10-28T12:00:00.000Z" }]);
    expect(desk.registry.current({ ward_id: "B" } as never).version).toBe(2);
    v.steps.length = 0;
    expect(desk.registry.get(2).steps.length).toBeGreaterThan(0);
    expect(() => desk.adopt(id, MANAGER)).toThrow();
    desk.close();
    const again = new VersionDesk(root, Registry.load([loadV1()]));
    expect(again.registry.get(2).definition_hash).toBe(v.definition_hash);
    expect(again.registry.get(2).status).toBe("adopted");
    expect(again.refusedCount()).toBe(2);
    expect(() => again.suspend(2, agent, "x")).toThrow(VersionError);
    expect(again.suspend(2, MANAGER, "a check failed").status).toBe("suspended");
    expect(again.registry.current({ ward_id: "B" } as never).version).toBe(1);
    expect(again.revert(2, MANAGER, "back to v1").status).toBe("reverted");
    expect(again.records().map((r) => r.record_type)).toEqual(["version.change_refused", "version.change_refused", "version.created", "version.adopted", "version.change_refused", "version.suspended", "version.reverted"]);
    again.close();
  });

  it("records the rework budget the person approved, and refuses a validation that never assessed it or found it exceeded", () => {
    const root = tempRoot();
    const desk = new VersionDesk(root, Registry.load([loadV1()]));
    desk.adopt(planted(root), MANAGER);
    const adopted = desk.records().find((r) => r.record_type === "version.adopted")!.payload as { rework_budget: unknown };
    expect(adopted.rework_budget).toEqual({ min_per_case: 10, max_added_min: 2, approved_by: "wm_test" });
    desk.close();
    for (const [gate, why] of [[null, /before the rework budget/], [{ rework_budget_min_per_case: 1, rework_max_added_min: 2, rework_within_budget: false }, /over the 1-minute budget/]] as const) {
      const r = tempRoot();
      const id = planted(r, undefined, gate);
      const d = new VersionDesk(r, Registry.load([loadV1()]));
      expect(() => d.adopt(id, MANAGER)).toThrow(why);
      expect(d.records().some((x) => x.record_type === "version.adopted")).toBe(false);
      d.close();
    }
  });

  it("refuses a proposal whose rebuilt version differs from the validated one", () => {
    const root = tempRoot();
    const id = planted(root, "0".repeat(64));
    const desk = new VersionDesk(root, Registry.load([loadV1()]));
    expect(() => desk.adopt(id, MANAGER)).toThrow(/differs/);
    desk.close();
  });

  it("serves adopt, suspend and revert as person-only routes", async () => {
    const root = tempRoot();
    const id = planted(root);
    const s = await startServe({ storeRoot: root, port: 0, mode: "mock", pollMs: 3 });
    const post = async (path: string, body: unknown) => { const r = await fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return [r.status, await r.json()] as const; };
    expect((await post("/versions/adopt", { proposal_id: id, approver: { ...MANAGER, kind: "agent" } }))[0]).toBe(403);
    const [st, out] = await post("/versions/adopt", { proposal_id: id, approver: MANAGER });
    expect([st, (out as { version: number }).version]).toEqual([201, 2]);
    expect((await post("/versions/2/suspend", { by: { ...MANAGER, kind: "model_session" }, reason: "x" }))[0]).toBe(403);
    expect((await post("/versions/2/suspend", { by: MANAGER, reason: "x", proposal: { task_id: "t-00000000", proposal_id: "vs-00000000" } }))[0]).toBe(404);
    expect((await post("/versions/2/suspend", { by: MANAGER, reason: "x" }))[0]).toBe(200);
    expect((await post("/versions/2/revert", { by: MANAGER, reason: "y" }))).toEqual([200, { version: 2, status: "reverted" }]);
    const list = await (await fetch(`${s.url}/versions`)).json() as { refused: number; versions: { status: string }[] };
    expect([list.refused, list.versions.map((v) => v.status)]).toEqual([2, ["adopted", "reverted"]]);
    await s.close();
  });
});

describe("the version monitor", () => {
  it("a planted requirement failure blocks only the affected actions, raises proposals, and only a person suspends", async () => {
    const root = tempRoot();
    const hmo = poolWorld("c-830e004c", { opened_at: 480, requirements: [{ at: 0, set: r2() }] });
    const reg = adoptedRegistry();
    const h = harness(root, { cases: [hmo], runtime: { registry: reg, maxTurnsPerTick: 16 } });
    h.rt.start();
    const t1 = h.rt.openTask({ case_id: hmo.case_id, goal: GOAL, owner: OWNER });
    const t2 = h.rt.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER });
    await h.rt.settled(120_000);
    expect(h.rt.portFor(hmo.case_id).def.version).toBe(2);
    expect(h.rt.projection(t2).state).toBe("done");
    const p = h.rt.projection(t1);
    expect([p.state, p.reason]).toEqual(["needs_input", "version_check_failed"]);
    const failed = ofType(root, t1, "version.check_failed").map((e) => e.payload as { check: string; version: number; requirement_version: string; action: { document_id: string }; evidence_event_ids: string[] });
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((f) => f.check === "commit" && f.version === 2 && f.requirement_version === "r2" && f.action.document_id === "discharge_summary" && f.evidence_event_ids.length > 0)).toBe(true);
    const st = h.rt.status(t1) as { conditions: { condition_id: string; met: boolean }[] };
    expect(st.conditions.filter((c) => c.met).map((c) => c.condition_id)).toEqual(["hmo_claim_cover.draft", "hmo_claim_cover.final"]);
    const sus = ofType(root, t1, "version.suspension_proposed").map((e) => e.payload as { proposal_id: string; version: number; fallback_version: number; fallback_passes: boolean });
    expect(sus.length).toBe(1);
    expect([sus[0]!.version, sus[0]!.fallback_version, sus[0]!.fallback_passes]).toEqual([2, 1, false]);
    const rev = ofType(root, t1, "version.revision_proposed").map((e) => e.payload as { ops: unknown[]; scope: unknown });
    expect(rev.length).toBe(1);
    expect(rev[0]!.ops).toEqual([{ op: "rebind_section", document_id: "discharge_summary", section_id: "medicines", source: { record_kind: "dispense_record", field_path: "items", version_policy: "current" } }]);
    expect(reg.get(2).status).toBe("adopted");
    const desk = new VersionDesk(root, reg);
    desk.suspend(2, MANAGER, "Ward B r2 check failed", 0, { task_id: t1, proposal_id: sus[0]!.proposal_id });
    expect(reg.current({ ward_id: "A" } as never).version).toBe(1);
    const later = variant("c-agent002", () => undefined);
    const h2 = harness(tempRoot(), { cases: [later], runtime: { registry: reg } });
    expect(h2.rt.portFor("c-agent002").def.version).toBe(1);
    desk.close();
    await h2.close();
    await h.close();
  }, 180_000);

  it("never lets a confirmation rewrite a stage already prepared, and only a person in the named role confirms", () => {
    const port = HospitalPort.open(tempRoot(), { ...baseCase(), exception_confirm_after_min: 10 }, Registry.load([loadV1()]), worldRules());
    port.advanceTo(600);
    const ex = { case_id: "c-agent001", op: { document_id: "discharge_summary", section_id: "medicines", source: { record_kind: "dispense_record", field_path: "items" }, note: "Copy from the dispense record." }, reason: "Asked by the ward.", confirm_by_role: "nurse" };
    const w = port.commit("apply_case_exception", ex, "k1");
    if (!w.ok) throw new Error("exception refused");
    expect(port.confirmException(w.write.record_id, { kind: "agent", staff_id: "ag", role: "nurse" })).toEqual({ ok: false, reason: "confirmation_requires_person" });
    expect(port.confirmException(w.write.record_id, { kind: "person", staff_id: "d_a1", role: "doctor" })).toEqual({ ok: false, reason: "wrong_role" });
    expect(port.commit("prepare_document", doc("discharge_summary", "draft"), "k2").ok).toBe(true);
    expect(port.commit("apply_case_exception", ex, "k3")).toMatchObject({ reason: "document_already_started", counted: true });
    port.advanceTo(611);
    expect(port.record(w.write.record_id)!.status).toBe("not_confirmed");
    expect(port.caseDef).toBe(port.def);
  });

  it("the outcome check fires on a planted record change after the hand-over and blocks the task", async () => {
    const probe = harness(tempRoot());
    probe.rt.start();
    probe.rt.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER });
    await probe.rt.settled();
    const handed = probe.rt.portFor("c-agent001").events().find((e) => e.kind === "step.completed" && (e.payload as { step_id?: string }).step_id === "st14")!.recorded_at;
    await probe.close();
    const w = variant("c-agent003", (x) => { x.schedule.record_updates = [{ update_id: "u-late", at: handed + 1, record_kind: "take_home_order", actor_role: "doctor", payload: { items: ["Paracetamol 500 mg tablets, 20"] } }]; });
    const root = tempRoot();
    const h = harness(root, { cases: [w] });
    h.rt.start();
    const id = h.rt.openTask({ case_id: "c-agent003", goal: GOAL, owner: OWNER });
    await h.rt.settled();
    const failed = ofType(root, id, "version.check_failed").map((e) => e.payload as { check: string; status: string; action: { document_id: string; stage: string }; evidence_event_ids: string[] });
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]).toMatchObject({ check: "outcome", status: "stale_after_handover", action: { document_id: "discharge_summary", stage: "final" } });
    expect(failed[0]!.evidence_event_ids.length).toBeGreaterThan(0);
    expect([h.rt.projection(id).state, h.rt.projection(id).reason]).toEqual(["needs_input", "version_check_failed"]);
    expect(ofType(root, id, "version.suspension_proposed").length).toBe(1);
    await h.close();
  }, 120_000);
});
