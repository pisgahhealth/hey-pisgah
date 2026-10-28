import { describe, expect, it } from "vitest";
import { AGENT_ALLOWED_KINDS, ActionKind, DocumentId, SOFT_EDGE_NOTE, WorkflowDefinition, fencesHash, permissionsHash, structureHash } from "@hey-pisgah/contracts";
import { RULES_HASH_PENDING, loadV1, stampHashes } from "./definition.js";

const v1 = loadV1();
const stepIds = ["st01", "st02", "st03", "st04", "st05", "st06", "st07", "st08", "st09a", "st09b", "st10", "st11", "st12a", "st12b", "st12c", "st13", "st14", "st15", "st16", "st17a", "st17b", "st17c"];

describe("discharge v1 definition", () => {
  it("parses with the contracts schema", () => {
    expect(WorkflowDefinition.safeParse(v1).success).toBe(true);
  });
  it("stores the hashes its content implies", () => {
    expect(stampHashes(v1)).toEqual(v1);
    expect(v1.metadata.rules_hash).toBe(RULES_HASH_PENDING);
  });
  it("has the split v1 step list with one kind per step", () => {
    expect(v1.steps.map((s) => s.step_id)).toEqual(stepIds);
    expect(v1.steps.filter((s) => s.alternative_group === "settlement").map((s) => s.step_id)).toEqual(["st12a", "st12b", "st12c"]);
    expect(v1.steps.filter((s) => s.external).map((s) => s.step_id)).toEqual(["st01", "st02", "st03", "st04", "st05", "st11", "st12a", "st12b", "st12c"]);
  });
  it("has e04 to e07 as the only soft edges, each with the shared note", () => {
    const soft = v1.edges.filter((e) => e.kind === "soft");
    expect(soft.map((e) => [e.edge_id, e.from.step, e.to.step])).toEqual([["e04", "st05", "st06"], ["e05", "st15", "st14"], ["e06", "st07", "st09a"], ["e07", "st16", "st17a"]]);
    for (const e of soft) expect([e.note, e.origin, e.immutable]).toEqual([SOFT_EDGE_NOTE, "ward_procedure", false]);
  });
  it("marks every fence immutable and stores no derived fence", () => {
    const fences = v1.edges.filter((e) => e.kind === "fence");
    expect(fences.length).toBe(23);
    for (const e of fences) {
      expect(e.immutable).toBe(true);
      expect(["platform", "permission", "ward_requirement"]).toContain(e.origin);
    }
  });
  it("holds every fence the plan lists", () => {
    const has = (from: string, to: string) => v1.edges.some((e) => e.kind === "fence" && e.from.step === from && e.to.step === to);
    const required: [string, string][] = [
      ["st02", "st03"], ["st03", "st04"], ["st05", "st10"], ["st05", "st12a"], ["st05", "st12b"], ["st05", "st12c"],
      ["st12a", "st13"], ["st12b", "st13"], ["st12c", "st13"], ["st11", "st13"], ["st13", "st16"], ["st13", "st17c"],
      ["st08", "st14"], ["st14", "st16"], ["st15", "st16"], ["st04", "st15"]
    ];
    for (const [f, t] of required) expect(has(f, t), `${f} -> ${t}`).toBe(true);
  });
  it("fires one v1 trigger after the from-step of each soft edge", () => {
    expect(v1.triggers.map((t) => [t.target.step, "after" in t.when ? t.when.after.step : null])).toEqual([["st06", "st05"], ["st14", "st15"], ["st09a", "st07"], ["st17a", "st16"]]);
  });
  it("gives the agent only the seven allowed kinds, all of them", () => {
    const agentKinds = Object.entries(v1.permissions).filter(([, r]) => r?.includes("agent")).map(([k]) => k).sort();
    expect(agentKinds).toEqual([...AGENT_ALLOWED_KINDS].sort());
    for (const s of v1.steps) if (s.actor_roles.includes("agent")) expect(AGENT_ALLOWED_KINDS.has(s.action_kind)).toBe(true);
    expect(Object.keys(v1.permissions).sort()).toEqual([...ActionKind.options].sort());
  });
  it("has the nine templates with the summary bindings", () => {
    expect(v1.documents.map((d) => d.document_id).sort()).toEqual([...DocumentId.options].sort());
    const summary = v1.documents.find((d) => d.document_id === "discharge_summary")!;
    expect(summary.sections.map((s) => [s.section_id, s.binding.record_kind])).toEqual([
      ["patient_and_stay", "admission_record"], ["medicines", "take_home_order"], ["follow_up", "signoff_record"], ["discharge_details", "signoff_record"], ["ward_contact", "ward_settings"]
    ]);
    expect(summary.check).toEqual({ role: "nurse", before: "st14" });
    const prep = (id: string) => v1.documents.find((d) => d.document_id === id)!.preparable_by;
    expect([prep("referral_letter"), prep("sick_note")]).toEqual([["doctor"], ["doctor"]]);
    expect(v1.documents.find((d) => d.document_id === "hmo_claim_cover")!.sections.some((s) => s.binding.record_kind === "stay_bill" && s.needed_for === "final")).toBe(true);
  });
  it("keeps the frozen hashes when only soft structure changes", () => {
    const changed = structuredClone(v1);
    changed.edges = changed.edges.filter((e) => e.edge_id !== "e04");
    changed.triggers[0] = { target: { step: "st06" }, when: { on: "discharge.expected_recorded" }, condition: null };
    changed.steps.find((s) => s.step_id === "st06")!.required_when = null;
    expect([fencesHash(changed), permissionsHash(changed), structureHash(changed)]).toEqual([v1.metadata.fences_hash, v1.metadata.permissions_hash, v1.metadata.structure_hash]);
  });
});
