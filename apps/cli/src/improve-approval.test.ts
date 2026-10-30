import { describe, expect, it } from "vitest";
import { adoptionApproval } from "./approval.js";

const adopted = (approver: Record<string, unknown>, wall_at: string | null = "2026-10-31T09:00:00.000Z") => ({ record_type: "version.adopted", payload: { version: 2, approver, at: { occurred_at: 0, recorded_at: 0, wall_at } } });
const LANE = { kind: "person", staff_id: "wm_a_synthetic", role: "ward_manager", display_name: "Synthetic Ward A manager (disclosed; a person's role played on the coordinator's instruction by the E6 build lane)" };
const SAMUEL = { kind: "person", staff_id: "samuel", role: "ward_manager", display_name: "Samuel, clinician and owner" };

describe("human approval is read from the adoption record, never set by the report", () => {
  it("is false for a lane playing the ward manager, true for a person's own adoption, and false again once that person suspends it", () => {
    expect(adoptionApproval([adopted(LANE)], 2)).toMatchObject({ human_approval: false, approval: { approver_id: "wm_a_synthetic", kind: "person", played_by_lane: true } });
    expect(adoptionApproval([adopted(SAMUEL)], 2)).toMatchObject({ human_approval: true, approval: { approver_id: "samuel", kind: "person", at: "2026-10-31T09:00:00.000Z", why: "adopted by a person" } });
    const suspended = { record_type: "version.suspended", payload: { version: 2, by: { kind: "person", staff_id: "samuel" }, reason: "outcomes worse" } };
    expect(adoptionApproval([adopted(SAMUEL), suspended], 2)).toMatchObject({ human_approval: false, approval: { suspended_or_reverted: true, why: "suspended by samuel after its adoption" } });
    expect(adoptionApproval([adopted(SAMUEL, null)], 2).human_approval).toBe(false);
    expect(adoptionApproval([adopted({ ...SAMUEL, kind: "agent" })], 2).human_approval).toBe(false);
    expect(adoptionApproval([], 2)).toMatchObject({ human_approval: false, approval: { why: "no adoption record for this version" } });
  });
});
