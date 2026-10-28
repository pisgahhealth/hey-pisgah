import { loadWorldParameters } from "@hey-pisgah/hospital";

export type Tag = "observed" | "assumed";
export type Range = { min: number; max: number; tag: Tag; note: string };

// PLAN 4.3 base values come from the hospital's frozen, tagged parameters; the generator never restates them.
export function baseValues(): Record<string, Range> {
  return Object.fromEntries(loadWorldParameters().base.map((b) => [b.name, { min: b.min, max: b.max, tag: b.tag, note: b.note }]));
}

// The generator's own ranges: the shape of each case world, every one assumed and published with the pools.
export const CASE_VALUES = {
  round_entry_offset_min: { min: 0, max: 15, tag: "assumed", note: "Round entry after the round starts." },
  order_after_round_entry_min: { min: 5, max: 20, tag: "assumed", note: "Take-home order after the round entry." },
  nurse_free_window_min: { min: 75, max: 120, tag: "assumed", note: "Usual free time after sign-off before the medicine round." },
  nurse_busy_block_min: { min: 60, max: 100, tag: "assumed", note: "Usual medicine round." },
  accounts_backlog_jobs: { min: 0, max: 2, tag: "assumed", note: "Other payers ahead at the pay point." },
  accounts_backlog_job_min: { min: 10, max: 20, tag: "assumed", note: "Each other payer." },
  insurer_response_min: { min: 40, max: 90, tag: "assumed", note: "Usual insurer response after submission." },
  claim_draft_min: { min: 10, max: 20, tag: "assumed", note: "Claim cover draft by the claims clerk." },
  on_account_after_bill_min: { min: 30, max: 90, tag: "assumed", note: "Company authorisation after the bill." },
  walk_out_min: { min: 0, max: 5, tag: "assumed", note: "From clearance to leaving the ward." },
  late_doc_free_window_min: { min: 20, max: 30, tag: "assumed", note: "Short free window right after sign-off (DESIGN world rule; 31 and above gives a tie)." },
  late_doc_busy_block_min: { min: 90, max: 140, tag: "assumed", note: "Long medicine round after the short window." },
  late_doc_sponsor_after_signoff_min: { min: 20, max: 40, tag: "assumed", note: "Sponsor already near the ward when only the paperwork waits." },
  late_doc_pharmacy_backlog_jobs: { min: 0, max: 1, tag: "assumed", note: "Pharmacy clear before sign-off when only the paperwork waits." },
  queue_dispense_after_signoff_min: { min: 150, max: 240, tag: "assumed", note: "Dispensing completes this long after sign-off in a queue world." },
  queue_backlog_jobs: { min: 10, max: 16, tag: "assumed", note: "Pharmacy backlog in a queue world." },
  late_entry_round_lag_min: { min: 180, max: 360, tag: "assumed", note: "Round entry typed in from paper." },
  late_entry_departure_lag_min: { min: 240, max: 360, tag: "assumed", note: "Departure typed in from paper; the top of 180 to 360 so the recorded wait clears the p90." },
  late_signoff_at: { min: 840, max: 1050, tag: "assumed", note: "Late clinical discharge, 14:00 to 17:30, after a 09:00 expectation." },
  waiver_after_bill_min: { min: 240, max: 240, tag: "assumed", note: "Waiver approval after the bill." },
  insurer_wait_response_min: { min: 150, max: 300, tag: "assumed", note: "Slow insurer response after submission." },
  mixed_free_window_min: { min: 20, max: 30, tag: "assumed", note: "Short window in a mixed world." },
  mixed_busy_block_min: { min: 45, max: 80, tag: "assumed", note: "Moderate medicine round in a mixed world." },
  mixed_dispense_after_signoff_min: { min: 60, max: 120, tag: "assumed", note: "Moderate pharmacy delay in a mixed world." },
  mixed_backlog_jobs: { min: 4, max: 8, tag: "assumed", note: "Moderate pharmacy backlog in a mixed world." },
  morning_signoff_at: { min: 570, max: 630, tag: "assumed", note: "Morning-shift sign-off where a nurse drafts unprompted." },
  morning_free_window_min: { min: 45, max: 75, tag: "assumed", note: "Free time after sign-off on the morning shift." },
  morning_busy_block_min: { min: 30, max: 60, tag: "assumed", note: "Lighter block on the morning shift." },
  amendment_before_signoff_min: { min: 10, max: 60, tag: "assumed", note: "Take-home list amended before sign-off." },
  review_change_after_order_min: { min: 20, max: 50, tag: "assumed", note: "Pharmacist changes the list at review." },
  next_day_signoff_at: { min: 510, max: 660, tag: "assumed", note: "Sign-off slips to the next morning (minute of day)." }
} as const satisfies Record<string, Range>;
