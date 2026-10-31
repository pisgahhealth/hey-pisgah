import { describe, expect, it } from "vitest";
import { loadV1 } from "@hey-pisgah/hospital";
import { Registry } from "@hey-pisgah/workflow";
import { adverseCase } from "./adverse.js";

const meta = { author: { kind: "model_session" as const, id: "p-test0007" }, proposal_id: "p-test0007", source_evidence: { event_ids: [], hypothesis_ids: [], experiment_ids: [], validation_report_id: null }, model_provenance: null };
const e04 = { op: "remove_soft_edge", edge_id: "e04" };
const versionWith = (when: unknown) => Registry.load([loadV1()]).propose(1, [e04, { op: "set_prep_trigger", target: { step: "st06" }, when }] as never, meta, { scope: { wards: ["A"], condition: null }, fallback: 1 }).version!;

describe("the dev case the adopted change made slower", () => {
  it("is c-ad742d69: its round entry reached the record after sign-off, so the draft waited for it", () => {
    const r = adverseCase(loadV1(), versionWith({ after: { step: "st01" } }), "c-ad742d69");
    expect(r).toMatchObject({ wait_delta_min: 167, round_entry_at: 516, round_entry_in_record_at: 742, signoff_in_record_at: 592, entry_lag_min: 226, draft_start_base: 592, draft_start_version: 742, family: "round entry in the record after sign-off" });
  });

  it("waits no longer when the draft starts at the round entry or at sign-off, whichever the record shows first", () => {
    const r = adverseCase(loadV1(), versionWith({ any_of: [{ after: { step: "st01" } }, { after: { step: "st05" } }] }), "c-ad742d69");
    expect(r).toMatchObject({ wait_delta_min: 0, draft_start_version: 592 });
  });
});
