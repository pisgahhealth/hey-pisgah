import { sha256 } from "@hey-pisgah/contracts";
import { ExternalSchedule, entryLagKey, scheduleHash, type ResourceSpec } from "@hey-pisgah/simulator";
import { loadWardRequirements, wardRequiresList, type Facts } from "@hey-pisgah/hospital";
import { drawer, type Drawer } from "./prng.js";
import { CASE_VALUES as V, baseValues, type Range } from "./values.js";
import { ADMISSION_REASONS, BRAND_NOTE, DEV_NAMES, DRUGS, FOLLOW_UPS, INSTRUCTION_NOTES, LATE_ENTRY_REASONS, PHARMACY_WAIT_NOTE, ROUTINE_NOTES, type NamePool } from "./text.js";
import { decisionPoints, shouldApply, trapsFor } from "./manifest.js";
import {
  InitialState, Manifest, type Family, type GeneratedCase, type InfraFault, type Note, type Overlay, type Payer, type Pool, type Ward
} from "./types.js";

export type GenerateOptions = {
  pool?: Pool;
  overlays?: Overlay[];
  names?: NamePool;
  // Reserved cases carry a canary surname; the reserved module passes it in.
  canary_surname?: string;
  infra_fault?: Omit<InfraFault, "from_min" | "to_min"> & { from_after_signoff: number; length_min: number };
};

type Item = { name: string; qty: number; brand: string };

const STAFF = {
  doctor: { A: "d_a1", B: "d_b1", C: "d_c1" },
  // The nurse on shift follows the case's world: a paper-first nurse where entries are typed in late, an early drafter where drafts appear unprompted.
  nurse_paper: { A: "n_a4", B: "n_b1", C: "n_c2" },
  nurse_early: { A: "n_a2", B: "n_b2", C: "n_c2" },
  nurse_usual: { A: ["n_a1", "n_a3"], B: ["n_b1"], C: ["n_c1"] }
} as const;

// One committed id shape for every pool: c- plus eight hex characters of the seed's hash.
export const caseIdFor = (seed: string): string => `c-${sha256(`case|${seed}`).slice(0, 8)}`;

const hhmm = (m: number): string => `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// Splits a total into n positive integer parts with weights from the draws.
function split(d: Drawer, key: string, total: number, n: number): number[] {
  const w = Array.from({ length: n }, (_, i) => 1 + d.u(`${key}.${i}`));
  const sum = w.reduce((a, b) => a + b, 0);
  const parts = w.map((x) => Math.max(1, Math.floor((total * x) / sum)));
  parts[n - 1] = Math.max(1, total - parts.slice(0, -1).reduce((a, b) => a + b, 0));
  return parts;
}

export function generateCase(family: Family, seed: string, ward: Ward, payer: Payer, opts: GenerateOptions = {}): GeneratedCase {
  const d = drawer(seed);
  const B = baseValues();
  const r = (key: string, v: Range) => d.int(key, v.min, v.max);
  const pool = opts.pool ?? "dev";
  const overlays = [...(opts.overlays ?? [])].sort();
  const case_id = caseIdFor(seed);
  if (family === "F5" && payer !== "hmo") throw new Error("the insurer family needs an hmo payer");
  if (family === "FV" && ward !== "B") throw new Error("the variation runs in Ward B");
  if ((family === "F12" || overlays.includes("F12")) && ward === "C") throw new Error("a summary note needs a ward that issues a summary");
  let variant: string | null = null;

  // Doctor's round and the take-home order (base values, all assumed).
  const round = r("round_at", B.round_at!);
  const st01At = round + r("st01.offset", V.round_entry_offset_min);
  const takeHome = ["F2", "F6", "F9", "F12", "FV"].includes(family) || overlays.includes("F12") || d.chance("take_home", B.take_home_share!.min);
  const st02At = st01At + r("st02.offset", V.order_after_round_entry_min);
  const ordered: Item[] = d.sample("take_home.items", DRUGS, r("take_home.count", B.take_home_items!)).map((x) => ({ name: x.name, qty: x.qty, brand: "" }));
  const review = r("pharmacy.review_min", B.pharmacy_review_min!);
  const dispense = r("pharmacy.dispense_min", B.pharmacy_dispense_min!);

  // Sign-off: 09:30 to 11:30 normally; a late sign-off or a next-day slip where the case calls for it.
  const planned = Math.max(r("signoff_at", B.signoff_at!), st02At + 15);
  let signoff = planned;
  if (family === "F4") signoff = r("f4.signoff_at", V.late_signoff_at);
  if (family === "F7") signoff = Math.max(r("f7.signoff_at", V.morning_signoff_at), st02At + 15);
  if (family === "F10") variant = d.chance("f10.variant", 0.5) ? "next_day" : "transfer";
  if (variant === "next_day") signoff = 1440 + r("f10.signoff_at", V.next_day_signoff_at);
  const expectedAt = family === "F4" ? 540 : variant === "next_day" ? planned : signoff;

  // Pharmacy queue: a short backlog normally; a long one sized so dispensing lands well after sign-off where the queue is the story.
  const pharmBacklog: ResourceSpec["backlog"] = [];
  const queueTarget = family === "F2" ? r("f2.dispense_after_signoff", V.queue_dispense_after_signoff_min) : family === "F6" ? r("f6.dispense_after_signoff", V.mixed_dispense_after_signoff_min) : null;
  if (takeHome && queueTarget !== null) {
    const n = family === "F2" ? r("f2.backlog_jobs", V.queue_backlog_jobs) : r("f6.backlog_jobs", V.mixed_backlog_jobs);
    const first = st02At - d.int("pharmacy.first_arrival", 20, 40);
    const total = signoff + queueTarget - review - dispense - first;
    split(d, "pharmacy.backlog_min", total, n).forEach((service_min, i) => pharmBacklog.push({ job_id: `p${i}`, arrive_at: first + Math.min(i, 15), service_min }));
  } else {
    const n = family === "F1" ? r("f1.backlog_jobs", V.late_doc_pharmacy_backlog_jobs) : r("pharmacy.backlog_jobs", B.pharmacy_backlog_jobs!);
    for (let i = 0; i < n; i++) pharmBacklog.push({ job_id: `p${i}`, arrive_at: st02At - d.int(`pharmacy.backlog.${i}.lead`, 0, 30), service_min: r(`pharmacy.backlog.${i}.min`, B.pharmacy_review_min!) });
  }

  // In the late-document world the medicines are ready before the doctor signs, so only the paperwork waits.
  if (family === "F1" && takeHome) signoff = Math.max(signoff, st02At + pharmBacklog.reduce((x, j) => x + j.service_min, 0) + review + dispense + 10);

  // The ward nurse: one busy block, the medicine round; its place and length shape the hour after sign-off.
  let window: number, block: number;
  if (family === "F1") { window = r("f1.free_window", V.late_doc_free_window_min); block = r("f1.busy_block", V.late_doc_busy_block_min); }
  else if (family === "F6") { window = r("f6.free_window", V.mixed_free_window_min); block = r("f6.busy_block", V.mixed_busy_block_min); }
  else if (family === "F7") { window = r("f7.free_window", V.morning_free_window_min); block = r("f7.busy_block", V.morning_busy_block_min); }
  else { window = r("nurse.free_window", V.nurse_free_window_min); block = r("nurse.busy_block", V.nurse_busy_block_min); }
  const nurseBlocks = [{ from: Math.min(signoff + window, 2879), to: Math.min(signoff + window + block, 2880) }];

  // Accounts: the sponsor reaches the pay point 20 to 60 after sign-off; a few other payers may be ahead.
  const sponsor = signoff + (family === "F1" ? r("f1.sponsor_after_signoff", V.late_doc_sponsor_after_signoff_min) : r("sponsor_after_signoff", B.sponsor_arrival_after_signoff_min!));
  const acctBacklog: ResourceSpec["backlog"] = [];
  const acctN = family === "F1" ? 0 : r("accounts.backlog_jobs", V.accounts_backlog_jobs);
  for (let i = 0; i < acctN; i++) acctBacklog.push({ job_id: `a${i}`, arrive_at: Math.max(0, sponsor - d.int(`accounts.backlog.${i}.lead`, 0, 15)), service_min: r(`accounts.backlog.${i}.min`, V.accounts_backlog_job_min) });

  // Disposition and the documents the ward requires at the start.
  const transferAtRound = family === "F8" && ward !== "C";
  const disposition = transferAtRound ? "transfer_out" : "home";
  const startFacts: Facts = {
    ward_id: ward, payer_type: payer, has_take_home_order: takeHome ? "true" : "false", take_home_status: takeHome ? "ordered" : "none",
    expected_disposition: disposition, expected_discharge_recorded: "false", signoff_recorded: "false", final_bill_issued: "false",
    insurer_status: "none", payment_status: "unpaid"
  };
  const reqs = loadWardRequirements();
  const wardRequires = wardRequiresList(reqs, ward, startFacts);

  // Medicines dispensed: as ordered, or with a different brand where the case turns on what pharmacy supplied.
  let current = ordered.map((x) => ({ ...x }));
  const recordUpdates: ExternalSchedule["record_updates"] = [];
  if (family === "F9") {
    variant = d.chance("f9.variant", 0.5) ? "amendment" : "review_change";
    const extra = DRUGS.find((x) => !current.some((c) => c.name === x.name))!;
    const at = variant === "amendment" ? Math.max(signoff - r("f9.amend_before_signoff", V.amendment_before_signoff_min), st02At + 10) : st02At + r("f9.review_change_after_order", V.review_change_after_order_min);
    current = variant === "amendment" ? [...current.slice(0, Math.max(1, current.length - 1)), { name: extra.name, qty: extra.qty, brand: "" }] : current.map((x, i) => (i === 0 ? { ...x, qty: Math.max(7, Math.floor(x.qty / 2)) } : x));
    recordUpdates.push({ update_id: "u1", at: Math.min(at, signoff - 1), record_kind: "take_home_order", actor_role: variant === "amendment" ? "doctor" : "pharmacist", payload: { items: current.map(itemText) } });
  }
  const substituted = family === "FV" || family === "F12" || overlays.includes("F12");
  const dispensed = substituted ? current.map((x, i) => (i === 0 ? { ...x, brand: DRUGS.find((g) => g.name === x.name)!.brand } : x)) : current;

  const steps: ExternalSchedule["steps"] = {
    st01: { due: { at: st01At }, sets_facts: { expected_discharge_recorded: "true" }, payload: { expected_disposition: disposition, expected_time: hhmm(expectedAt) } },
    st05: {
      due: { at: signoff },
      sets_facts: variant === "transfer"
        ? { signoff_recorded: "true", final_bill_issued: "true", expected_disposition: "transfer_out", ward_requires: wardRequiresList(reqs, ward, { ...startFacts, expected_disposition: "transfer_out" }) }
        : { signoff_recorded: "true", final_bill_issued: "true" },
      payload: { follow_up: d.pick("follow_up", FOLLOW_UPS), disposition: variant === "transfer" ? "transfer_out" : disposition }
    },
    st16: { due: { after: "st13", delay_min: r("walk_out_min", V.walk_out_min) } }
  };
  if (takeHome) {
    steps["st02"] = { due: { at: st02At }, payload: { items: ordered.map(itemText) } };
    steps["st04"] = { payload: { items: dispensed.map(itemText) }, sets_facts: { take_home_status: "dispensed" } };
  }

  // Settlement: the sponsor pays, an authoriser waives, or the company is billed on account.
  const alternatives: Record<string, string> = {};
  if (family === "F4" && d.chance("f4.waiver", 0.5)) {
    variant = "waiver";
    alternatives["settlement"] = "st12b";
    steps["st12b"] = { due: { after: "st05", delay_min: V.waiver_after_bill_min.min }, sets_facts: { payment_status: "waived" } };
  } else if (payer === "corporate") {
    alternatives["settlement"] = "st12c";
    steps["st12c"] = { due: { after: "st05", delay_min: r("on_account_after_bill", V.on_account_after_bill_min) }, sets_facts: { payment_status: "on_account" } };
  } else {
    alternatives["settlement"] = "st12a";
    steps["st12a"] = { not_before: sponsor, sets_facts: { payment_status: "paid" } };
  }
  if (payer === "hmo") {
    const response = family === "F5" ? r("f5.insurer_response_min", V.insurer_wait_response_min) : r("insurer_response_min", V.insurer_response_min);
    steps["st10"] = { sets_facts: { insurer_status: "submitted" } };
    steps["st11"] = { due: { after: "st10", delay_min: response }, sets_facts: { insurer_status: "responded" } };
  }

  // Who is on shift, and the entries a paper-first ward types in hours later.
  const nurse = family === "F3" ? STAFF.nurse_paper[ward] : family === "F7" ? STAFF.nurse_early[ward] : d.pick("nurse", STAFF.nurse_usual[ward]);
  const doctor = STAFF.doctor[ward];
  const entryLag: ExternalSchedule["entry_lag"] = {};
  if (family === "F3") {
    entryLag[entryLagKey("step.completed", "st01", doctor, 1)] = { lag_min: r("f3.round_entry_lag", V.late_entry_round_lag_min), reason: LATE_ENTRY_REASONS.doctor };
    entryLag[entryLagKey("step.completed", "st16", nurse, 1)] = { lag_min: r("f3.departure_entry_lag", V.late_entry_departure_lag_min), reason: LATE_ENTRY_REASONS.nurse };
  }

  const schedule = ExternalSchedule.parse({
    schedule_version: 1,
    case_id,
    facts: { ...startFacts, ward_requires: wardRequires },
    actors: { doctor, nurse, pharmacist: "p_01", accounts_clerk: "ac_01", claims_clerk: "cc_01", authoriser: "au_01", insurer: "ins_01" },
    steps,
    alternatives,
    resources: {
      nurse: { kind: "single", busy_blocks: nurseBlocks, backlog: [] },
      pharmacist: { kind: "fifo", busy_blocks: [], backlog: pharmBacklog },
      accounts_clerk: { kind: "fifo", busy_blocks: [], backlog: acctBacklog },
      claims_clerk: { kind: "fifo", busy_blocks: [], backlog: [] }
    },
    record_updates: recordUpdates,
    service_min: {
      "pharmacy_review|-|-|1": review,
      "dispense|-|-|1": dispense,
      "prepare_document|discharge_summary|draft|1": r("summary.draft_min", B.summary_draft_min!),
      "prepare_document|discharge_summary|final|1": r("summary.final_min", B.summary_final_min!),
      "prepare_document|hmo_claim_cover|draft|1": r("claim.draft_min", V.claim_draft_min),
      "prepare_document|hmo_claim_cover|final|1": 5,
      "prepare_document|refund_voucher|draft|1": 10,
      "prepare_document|refund_voucher|final|1": 5,
      "receive_payment|-|-|1": r("payment_min", B.payment_min!)
    },
    service_default_min: {
      pharmacy_review: 15, dispense: 12, prepare_document: 25, revise_document: 6, check_document: B.summary_check_min!.min, submit_claim: 5, receive_payment: 15,
      financial_clearance: B.clearance_min!.min, hand_over_document: B.handover_min!.min, hand_over_take_home: B.handover_min!.min, record_departure: 2, refund_deposit: 5
    },
    entry_lag: entryLag,
    draws: {}
  });

  // Notes on the record: routine ones in every case, and the ones a case turns on.
  const notes: Note[] = [];
  const note = (at: number, author_role: Note["author_role"], author_id: string, untrusted_text: string) =>
    notes.push({ note_id: "n00", occurred_at: at, recorded_at: at, author_role, author_id, untrusted_text });
  note(round + d.int("note.routine.at", 20, 60), "nurse", nurse, d.pick("note.routine", ROUTINE_NOTES));
  if (d.chance("note.second", 0.5)) note(signoff - d.int("note.second.at", 5, 30), "nurse", nurse, d.pick("note.second.text", ROUTINE_NOTES.filter((t) => t !== notes[0]!.untrusted_text)));
  if (family === "F1" && takeHome && d.chance("f1.pharmacy_note", 1 / 3)) {
    const dispensedBy = st02At + pharmBacklog.reduce((a, j) => a + j.service_min, 0) + review + dispense;
    note(Math.max(signoff + d.int("f1.pharmacy_note.at", 10, 25), dispensedBy + 30), "nurse", nurse, PHARMACY_WAIT_NOTE);
  }
  if (overlays.includes("F11")) note(Math.max(st02At + 10, signoff - d.int("f11.at", 20, 80)), "nurse", "n_relief", d.pick("f11.text", INSTRUCTION_NOTES));
  if (substituted && family !== "FV") note(Math.max(st02At + 30, signoff - d.int("f12.at", 10, 40)), "nurse", nurse, BRAND_NOTE(dispensed[0]!.name));
  notes.sort((a, b) => a.occurred_at - b.occurred_at || a.untrusted_text.localeCompare(b.untrusted_text));
  notes.forEach((n, i) => { n.note_id = `n${String(i + 1).padStart(2, "0")}`; });

  const names = opts.names ?? DEV_NAMES;
  const sex = d.chance("patient.sex", 0.5) ? "female" : "male";
  const given = d.pick("patient.given", sex === "female" ? names.given_female : names.given_male);
  const surname = opts.canary_surname ?? d.pick("patient.family", names.family);
  const hospital_no = `${ward}K${String(d.int("patient.number", 100000, 999999))}`;
  const initial_state = InitialState.parse({
    case_id, ward_id: ward, bed: `${ward}-${String(d.int("bed", 1, 24)).padStart(2, "0")}`, payer_type: payer,
    requirement_version: family === "FV" ? "r2" : "r1",
    patient: { name: `${given} ${surname}`, hospital_no, sex, age_years: d.int("patient.age", 18, 88) },
    admission_reason: d.pick("admission_reason", ADMISSION_REASONS),
    deposit_naira: d.int("deposit", 2, 10) * 10000,
    notes
  });

  let infra_fault: InfraFault | null = null;
  if (opts.infra_fault) {
    const from = signoff + opts.infra_fault.from_after_signoff;
    infra_fault = { kind: opts.infra_fault.kind, target: opts.infra_fault.target, from_min: from, to_min: Math.min(2880, from + opts.infra_fault.length_min) };
  }

  const ctx = { family, overlays, variant, ward, payer, takeHome, wardRequires, notes, recordUpdates, infra_fault };
  const manifest = Manifest.parse({
    case_id, pool, family, overlays, seed, ward_id: ward, payer_type: payer, requirement_version: initial_state.requirement_version,
    canary: opts.canary_surname ?? hospital_no, should_apply: shouldApply(ctx), variant, traps: trapsFor(ctx), decision_points: decisionPoints(ctx),
    infra_fault, schedule_hash: scheduleHash(schedule)
  });
  return { schedule, initial_state, manifest, infra_fault };
}

function itemText(x: Item): string {
  return x.brand ? `${x.name}, ${x.qty}, brand supplied ${x.brand}` : `${x.name}, ${x.qty}`;
}

export type CaseContext = {
  family: Family; overlays: Overlay[]; variant: string | null; ward: Ward; payer: Payer; takeHome: boolean;
  wardRequires: string[]; notes: Note[]; recordUpdates: ExternalSchedule["record_updates"]; infra_fault: InfraFault | null;
};
