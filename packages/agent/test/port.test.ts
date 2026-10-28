import { describe, expect, it } from "vitest";
import { AGENT_ALLOWED_KINDS, ActionKind, DocumentId } from "@hey-pisgah/contracts";
import { readStream } from "@hey-pisgah/store";
import { scriptedAgent } from "../src/mock.js";
import { HospitalPort } from "../src/port.js";
import { GOAL, OWNER, baseCase, harness, ofType, registry, tempRoot, variant } from "./helpers.js";

const C = "c-agent001";
const open = (root = tempRoot(), world = baseCase()) => HospitalPort.open(root, world, registry());
const doc = (document_id: string, stage: string, case_id = C) => ({ case_id, document_id, stage });

// A small seeded generator so the fuzz is repeatable.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe("hospital port over the definition executor", () => {
  it("shows only what was recorded by now, and keeps visible event ids stable as writes arrive", () => {
    const port = open();
    const at480 = port.caseState() as { events: { items: { at: number }[] }; steps: { status: string; step_id: string }[] };
    expect(at480.events.items.every((e) => e.at <= 480)).toBe(true);
    expect(at480.steps.find((s) => s.step_id === "st05")!.status).toBe("not_started");
    expect(port.record(port.recordKindId("signoff_record"))).toBeNull();
    port.advanceTo(600);
    const before = port.events().map((e) => e.event_id);
    expect(port.commit("prepare_document", doc("discharge_summary", "draft"), "k1").ok).toBe(true);
    for (let t = port.nextEventTime(); t !== null && t <= 760; t = port.nextEventTime()) {
      port.advanceTo(t);
      expect(port.events().every((e) => e.recorded_at <= t)).toBe(true);
    }
    expect(port.events().slice(0, before.length).map((e) => e.event_id)).toEqual(before);
    expect(port.record(port.recordKindId("signoff_record"))!.version).toBe(1);
  });

  it("re-checks prerequisites at commit time under the adopted version", () => {
    const port = open();
    const r1 = port.commit("prepare_document", doc("discharge_summary", "draft"), "k1");
    expect(r1).toMatchObject({ ok: false, reason: "prerequisite_unmet", counted: false });
    const kinds = (r1 as unknown as { detail: { waiting_for: { kind: string; step_id: string | null }[] } }).detail.waiting_for.map((w) => `${w.kind}:${w.step_id}`);
    expect(kinds).toContain("soft_edge:st05");
    expect(kinds).toContain("trigger:null");
    expect(port.commit("prepare_document", doc("discharge_summary", "final"), "k2")).toMatchObject({ reason: "prerequisite_unmet" });
    expect(port.commit("prepare_document", doc("hmo_claim_cover", "draft"), "k3")).toMatchObject({ reason: "not_required" });
    expect(port.commit("prepare_document", doc("discharge_summary", "draft", "c-other001"), "k4")).toMatchObject({ reason: "unknown_id" });
    port.advanceTo(600);
    const ok = port.commit("prepare_document", doc("discharge_summary", "draft"), "k5");
    expect(ok.ok && ok.write.effect_at).toBe(601);
    expect(port.commit("prepare_document", doc("discharge_summary", "draft"), "k6")).toMatchObject({ reason: "already_prepared" });
    expect(port.commit("revise_document", doc("discharge_summary", "draft"), "k7")).toMatchObject({ reason: "not_stale" });
    expect(port.commit("request_check", doc("discharge_summary", "final"), "k8")).toMatchObject({ reason: "prerequisite_unmet" });
    expect(port.allWrites().length).toBe(1);
  });

  it("an accepted preparation always starts in the engine at its effect minute", async () => {
    const root = tempRoot();
    const h = harness(root, { mock: scriptedAgent({ notify: true }) });
    h.rt.start();
    h.rt.openTask({ case_id: C, goal: GOAL, owner: OWNER });
    await h.rt.settled();
    const port = h.rt.portFor(C);
    const prepares = port.allWrites().filter((w) => w.action_kind === "prepare_document");
    expect(prepares.length).toBe(4);
    for (const w of prepares) {
      const started = port.run().events.find((e) => e.kind === "step.started" && (e.payload as { step_id: string }).step_id === w.step_id);
      expect(started?.occurred_at).toBe(w.effect_at);
    }
    await h.close();
  });

  it("refuses and counts every person-only kind and every document the agent may not prepare (fuzz)", () => {
    const root = tempRoot();
    const port = open(root);
    port.advanceTo(600);
    const prohibited = ActionKind.options.filter((k) => !AGENT_ALLOWED_KINDS.has(k));
    expect(prohibited.length).toBe(21);
    let expected = 0;
    for (const k of prohibited) {
      const r = port.commit(k, { case_id: C }, `p-${k}`);
      expect(r).toMatchObject({ ok: false, reason: "person_only", counted: true });
      expected += 1;
    }
    const notMine = DocumentId.options.filter((d) => !["discharge_summary", "refund_voucher", "hmo_claim_cover"].includes(d));
    for (const d of notMine) for (const stage of ["draft", "final"]) {
      expect(port.commit("prepare_document", doc(d, stage), `d-${d}-${stage}`)).toMatchObject({ reason: "not_permitted", counted: true });
      expected += 1;
    }
    const rand = rng(7);
    const names = [...ActionKind.options, "discharge_patient", "approve", "clear_bill", "adopt", "dispense_now"];
    for (let i = 0; i < 300; i++) {
      const name = names[Math.floor(rand() * names.length)]!;
      const args = rand() < 0.5 ? { case_id: C } : { case_id: C, document_id: DocumentId.options[Math.floor(rand() * DocumentId.options.length)], stage: rand() < 0.5 ? "draft" : "final", note: "x".repeat(Math.floor(rand() * 20)) };
      const before = port.refusedCount();
      const r = port.commit(name, args, `f-${i}`);
      if (!AGENT_ALLOWED_KINDS.has(name as never)) {
        expect(r.ok).toBe(false);
        expect(port.refusedCount()).toBe(before + 1);
        expected += 1;
      } else if (!r.ok && r.counted) expected += 1;
    }
    expect(port.refusedCount()).toBe(expected);
    expect(readStream(root, `world/${C}`).filter((e) => e.record_type === "agent.refused").length).toBe(expected);
    expect(port.allWrites().every((w) => AGENT_ALLOWED_KINDS.has(w.action_kind))).toBe(true);
    expect(port.run().metrics.prohibited_executed).toBe(0);
  });

  it("wraps text from people and systems as untrusted_text", () => {
    const port = open();
    port.advanceTo(600);
    const signoff = port.record(port.recordKindId("signoff_record"))!;
    expect((signoff.content["data"] as Record<string, unknown>)["follow_up"]).toEqual({ untrusted_text: "Medical outpatient clinic in two weeks." });
    expect(port.wardRequirements()["procedure_text"]).toHaveProperty("untrusted_text");
  });

  it("a source change after a proof is caught: the stage goes stale, is revised, and the proof is refreshed", async () => {
    const root = tempRoot();
    const c = variant("c-agent004", (w) => {
      w.schedule.record_updates.push({ update_id: "amend-1", at: 620, record_kind: "take_home_order", actor_role: "doctor", payload: { items: ["Amlodipine 10 mg tablets, 28"] } });
    });
    const port = open(tempRoot(), c);
    port.advanceTo(600);
    expect(port.commit("prepare_document", doc("discharge_summary", "draft", c.case_id), "k1").ok).toBe(true);
    port.advanceTo(620);
    const stale = port.record(port.stageRecordId("discharge_summary", "draft"))!;
    expect(stale.status === "stale" || stale.version === 2).toBe(true);
    const h = harness(root, { cases: [c] });
    h.rt.start();
    const id = h.rt.openTask({ case_id: c.case_id, goal: GOAL, owner: OWNER });
    await h.rt.settled();
    expect(h.rt.projection(id).state).toBe("done");
    expect(ofType(root, id, "proof.refreshed").length).toBeGreaterThan(0);
    await h.close();
  });

  it("two independent runs give the same effect_set_hash", async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const root = tempRoot();
      const h = harness(root, { mock: scriptedAgent({ notify: true }) });
      h.rt.start();
      const id = h.rt.openTask({ case_id: C, goal: GOAL, owner: OWNER });
      await h.rt.settled();
      hashes.push(String((h.rt.status(id) as { closed: { effect_set_hash: string } }).closed.effect_set_hash));
      await h.close();
    }
    expect(hashes[0]).toBe(hashes[1]);
  });
});
