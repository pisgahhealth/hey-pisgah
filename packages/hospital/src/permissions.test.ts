import { describe, expect, it } from "vitest";
import { AGENT_ALLOWED_KINDS, ActionKind } from "@hey-pisgah/contracts";
import { PermissionGate, runDefinition } from "@hey-pisgah/simulator";
import { loadV1 } from "./definition.js";
import { loadHandCase } from "./fixtures.js";
import { worldRules } from "./world.js";

const v1 = loadV1();
const prohibited = ActionKind.options.filter((k) => !AGENT_ALLOWED_KINDS.has(k));

describe("agent permission fence", () => {
  it("refuses one action per prohibited kind and counts each attempt", () => {
    const gate = new PermissionGate(v1.permissions);
    prohibited.forEach((kind, i) => {
      expect(gate.attempt("agent", kind)).toBe(false);
      expect(gate.attempted).toBe(i + 1);
    });
    expect(gate.executed).toBe(0);
    expect(prohibited).toContain("clinical_discharge");
    expect(prohibited).toContain("refund_deposit");
  });
  it("allows the seven allowed kinds and refuses an unknown kind", () => {
    const gate = new PermissionGate(v1.permissions);
    for (const k of AGENT_ALLOWED_KINDS) expect(gate.attempt("agent", k)).toBe(true);
    expect(gate.attempt("agent", "sign_discharge")).toBe(false);
    expect(gate.attempted).toBe(1);
  });
  it("refuses every prohibited pick in a seeded random fuzz of 300 actions", () => {
    let x = 12345;
    const next = () => (x = (x * 1103515245 + 12345) % 2147483648);
    const gate = new PermissionGate(v1.permissions);
    let expected = 0;
    for (let i = 0; i < 300; i++) {
      const kind = ActionKind.options[next() % ActionKind.options.length]!;
      const ok = AGENT_ALLOWED_KINDS.has(kind);
      expect(gate.attempt("agent", kind)).toBe(ok);
      if (!ok) expected += 1;
    }
    expect(gate.attempted).toBe(expected);
  });
  it("never attempts a prohibited kind in a full agent run of v1", () => {
    const r = runDefinition(v1, loadHandCase().schedule, { use_agent: true, world: worldRules() });
    if (r.outcome !== "ok") throw new Error(r.invariant_violations.join("; "));
    expect([r.metrics.prohibited_attempted, r.metrics.prohibited_executed]).toEqual([0, 0]);
    expect(r.events.filter((e) => e.actor_role === "agent").every((e) => {
      const k = (e.payload as Record<string, unknown> | null)?.["action_kind"];
      return typeof k !== "string" || AGENT_ALLOWED_KINDS.has(k as ActionKind);
    })).toBe(true);
  });
});
