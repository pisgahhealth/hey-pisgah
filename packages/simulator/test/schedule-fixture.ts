import type { ExternalSchedule } from "../src/schedule.js";
import { rng } from "../../workflow/test/fixture.js";

// Builds a test schedule for the fixture definition from a seed; the case generator owns real schedules.
export function fixtureSchedule(seed: number, over: { busyAfterSignoff?: number; busyLen?: number; payer?: "self_pay" | "hmo"; takeHome?: boolean; amendAt?: number | null } = {}): ExternalSchedule {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const round = int(480, 540);
  const signoff = int(570, 690);
  const takeHome = over.takeHome ?? r() < 0.7;
  const payer = over.payer ?? "self_pay";
  const busyFrom = signoff + (over.busyAfterSignoff ?? int(0, 10));
  const busyLen = over.busyLen ?? int(90, 140);
  const docLag = int(0, 30);
  const s: ExternalSchedule = {
    schedule_version: 1,
    case_id: `c-${(seed >>> 0).toString(16).padStart(8, "0").slice(-8)}`,
    facts: { ward_id: "A", payer_type: payer, has_take_home_order: takeHome ? "true" : "false", ward_requires: ["discharge_summary"] },
    actors: { doctor: "doctor-7", nurse: "nurse-3" },
    steps: {
      st01: { due: { at: round }, sets_facts: { expected_discharge_recorded: "true" } },
      st02: { due: { at: round + int(5, 20) }, payload: { items: int(1, 4) } },
      st05: { due: { at: signoff }, sets_facts: { signoff_recorded: "true", final_bill_issued: "true" }, payload: { follow_up: "clinic" } },
      st11: { due: { after: "st10", delay_min: int(60, 120) } },
      st12a: { not_before: signoff + int(20, 60), sets_facts: { payment_status: "paid" } }
    },
    alternatives: { settle: "st12a" },
    resources: {
      nurse: { kind: "single", busy_blocks: [{ from: busyFrom, to: busyFrom + busyLen }], backlog: [] },
      pharmacist: { kind: "fifo", busy_blocks: [], backlog: Array.from({ length: int(0, 3) }, (_, i) => ({ job_id: `p${i}`, arrive_at: round - 30 + i * 5, service_min: int(10, 20) })) },
      accounts_clerk: { kind: "fifo", busy_blocks: [], backlog: [{ job_id: "a0", arrive_at: signoff + 10, service_min: int(10, 20) }] },
      claims_clerk: { kind: "fifo", busy_blocks: [], backlog: [] }
    },
    record_updates: over.amendAt === null || over.amendAt === undefined ? [] : [{ update_id: "amend1", at: over.amendAt, record_kind: "take_home_order", actor_role: "doctor", payload: { items: 2 } }],
    service_min: {},
    service_default_min: {
      pharmacy_review: int(10, 20), dispense: int(10, 15), prepare_document: int(20, 30), revise_document: 6, check_document: 5,
      submit_claim: 5, receive_payment: int(10, 20), approve_waiver: 10, financial_clearance: 5, hand_over_document: 5, hand_over_take_home: 5, record_departure: 2
    },
    entry_lag: {
      "step.completed|st01|doctor-7|1": { lag_min: docLag, reason: docLag > 15 ? "entered after the round" : null },
      "step.completed|st16|nurse-3|1": { lag_min: 3, reason: null }
    },
    draws: {}
  };
  return s;
}
