import { definitionHash, type Clocks } from "@hey-pisgah/contracts";
import { describe, expect, it } from "vitest";
import { Registry, RegistryError, applyOperations, hashDefinition, type PersonApprover } from "../src/index.js";
import { fixtureDefinition } from "./fixture.js";

const at: Clocks = { occurred_at: 100, recorded_at: 100, wall_at: "2026-10-28T09:00:00Z" };
const manager: PersonApprover = { kind: "person", staff_id: "s-ward-manager", role: "ward_manager", display_name: "Ward manager" };
const meta = { author: { kind: "model_session" as const, id: "session-1" }, proposal_id: "p-00000001", source_evidence: { event_ids: [], hypothesis_ids: [], experiment_ids: [], validation_report_id: null }, model_provenance: null };
const code = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof RegistryError ? e.code : String(e); } return "no error"; };

describe("registry", () => {
  it("loads, hashes and lists versions and refuses a stored hash that does not match", () => {
    const r = Registry.load([fixtureDefinition()]);
    expect(r.list()).toEqual([{ version: 1, parent_version: null, status: "adopted", definition_hash: fixtureDefinition().definition_hash, adopted_at: null }]);
    expect(hashDefinition(r.get(1)).fences_hash).toBe(fixtureDefinition().metadata.fences_hash);
    const bad = fixtureDefinition(); bad.metadata.fences_hash = "f".repeat(64);
    expect(code(() => Registry.load([bad]))).toBe("hash_mismatch");
    expect(code(() => Registry.load([JSON.stringify(fixtureDefinition()), fixtureDefinition()]))).toBe("duplicate_version");
  });

  it("proposes, validates, adopts by a person only, then suspends and reverts", () => {
    const r = Registry.load([fixtureDefinition()]);
    const { version } = r.propose(1, [{ op: "remove_soft_edge", edge_id: "e04" }], meta);
    expect(version?.version).toBe(2);
    expect(version?.status).toBe("proposed");
    expect(version?.metadata.change_ops).toEqual([{ op: "remove_soft_edge", edge_id: "e04" }]);
    expect(code(() => r.adopt(2, manager, at))).toBe("bad_transition");
    r.setValidation(2, "dev_validated");
    const model = { ...manager, kind: "model_session" } as unknown as PersonApprover;
    expect(code(() => r.adopt(2, model, at))).toBe("adoption_requires_person");
    const adopted = r.adopt(2, manager, at, 120);
    expect(adopted.metadata.adopted_at).toEqual(at);
    expect(adopted.metadata.approver?.staff_id).toBe("s-ward-manager");
    expect(adopted.metadata.supersedes).toBe(1);
    expect(adopted.definition_hash).toBe(version?.definition_hash);
    expect(r.current({ ward_id: "A" }).version).toBe(2);
    expect(code(() => r.suspend(2, model, "x", at))).toBe("adoption_requires_person");
    expect(r.suspend(2, manager, "check failed", at).status).toBe("suspended");
    expect(r.current({ ward_id: "A" }).version).toBe(1);
    expect(r.revert(2, manager, "back to v1", at).metadata.reverted?.reason).toBe("back to v1");
  });

  it("a no-op proposal creates no version and stored versions are frozen copies", () => {
    const r = Registry.load([fixtureDefinition()]);
    const out = r.propose(1, [{ op: "add_soft_edge", from: { step: "st05" }, to: { step: "st06" }, gate: "start" }], meta);
    expect(out.version).toBeNull();
    const copy = r.get(1);
    copy.edges = [];
    expect(r.get(1).edges.length).toBeGreaterThan(0);
  });

  it("current falls back when a scoped version does not cover the case", () => {
    const r = Registry.load([fixtureDefinition()]);
    r.propose(1, [{ op: "add_condition", target: "scope", condition: { fact: "ward_id", eq: "A" } }], meta);
    r.setValidation(2, "dev_validated");
    r.adopt(2, manager, { ...at, occurred_at: 200, recorded_at: 200 });
    expect(r.current({ ward_id: "A" }).version).toBe(2);
    expect(r.current({ ward_id: "B" }).version).toBe(1);
  });

  it("a scoped proposal stores its scope, falls back to its base and hashes like the evaluator's build of it", () => {
    const r = Registry.load([fixtureDefinition()]);
    const ops = [{ op: "remove_soft_edge", edge_id: "e04" }];
    const scope = { wards: ["B"], condition: null };
    const v = r.propose(1, ops, meta, { scope }).version!;
    expect([v.scope, v.fallback_version]).toEqual([scope, 1]);
    const applied = applyOperations(fixtureDefinition(), ops);
    if (!applied.ok) throw new Error("ops refused");
    const expected = definitionHash({ ...applied.definition, version: 2, parent_version: 1, status: "proposed", scope, fallback_version: 1 });
    expect(v.definition_hash).toBe(expected);
    expect(hashDefinition(r.get(2)).definition_hash).toBe(expected);
    expect(r.propose(1, ops, meta, { scope: { wards: "all", condition: null }, fallback: null }).version!.fallback_version).toBeNull();
  });
});
