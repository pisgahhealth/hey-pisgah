import { describe, expect, it } from "vitest";
import { AGENT_ALLOWED_KINDS, ActionKind } from "@hey-pisgah/contracts";
import { loadV1 } from "./definition.js";
import { stubEngine, type DispatchState } from "./engine-seam.js";

const v1 = loadV1();
const prohibited = ActionKind.options.filter((k) => !AGENT_ALLOWED_KINDS.has(k));
const fresh = (): DispatchState => ({ prohibited_attempted: 0, prohibited_executed: 0, events: [] });

describe("agent permission fence", () => {
  it("refuses one action per prohibited kind and counts each attempt", () => {
    const st = fresh();
    prohibited.forEach((kind, i) => {
      expect(stubEngine.dispatch(v1, st, { actor_role: "agent", action_kind: kind }, 600, "c-hand0001")).toEqual({ ok: false, reason: "not_permitted" });
      expect(st.prohibited_attempted).toBe(i + 1);
    });
    expect(st.prohibited_executed).toBe(0);
    expect(st.events.map((e) => e.kind)).toEqual(prohibited.map(() => "agent.refused"));
    expect(prohibited).toContain("clinical_discharge");
    expect(prohibited).toContain("refund_deposit");
  });
  it("refuses the agent on every non-agent step even with a crafted kind", () => {
    const st = fresh();
    const targets = v1.steps.filter((s) => !s.actor_roles.includes("agent"));
    for (const s of targets) expect(stubEngine.dispatch(v1, st, { actor_role: "agent", action_kind: s.action_kind, step_id: s.step_id }, 600, "c-hand0001").ok).toBe(false);
    expect(st.prohibited_attempted).toBe(targets.length);
  });
  it("refuses an unknown kind and accepts the seven allowed kinds", () => {
    const st = fresh();
    expect(stubEngine.dispatch(v1, st, { actor_role: "agent", action_kind: "sign_discharge" }, 0, "c-hand0001")).toEqual({ ok: false, reason: "unknown_kind" });
    for (const k of AGENT_ALLOWED_KINDS) expect(stubEngine.dispatch(v1, st, { actor_role: "agent", action_kind: k }, 0, "c-hand0001").ok).toBe(true);
    expect(st.prohibited_attempted).toBe(1);
  });
  it("refuses every prohibited pick in a seeded random fuzz of 300 actions", () => {
    let x = 12345;
    const next = () => (x = (x * 1103515245 + 12345) % 2147483648);
    const st = fresh();
    let expected = 0;
    for (let i = 0; i < 300; i++) {
      const kind = ActionKind.options[next() % ActionKind.options.length]!;
      const step = v1.steps[next() % v1.steps.length]!;
      const r = stubEngine.dispatch(v1, st, { actor_role: "agent", action_kind: kind, step_id: step.step_id }, 0, "c-hand0001");
      const allowed = AGENT_ALLOWED_KINDS.has(kind) && step.action_kind === kind && step.actor_roles.includes("agent");
      expect(r.ok).toBe(allowed);
      if (!allowed) expected += 1;
    }
    expect(st.prohibited_attempted).toBe(expected);
  });
});
