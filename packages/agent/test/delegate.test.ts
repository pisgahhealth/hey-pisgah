import { describe, expect, it } from "vitest";
import { ACK_KIND, COMPLETE_KIND, DELEGATE_KIND, DELEGATION_RULE_KINDS, DISPENSE_KIND, ESCALATE_KIND, NUDGE_KIND, PREPARE_KIND, REGISTER_KIND, WARD_REVIEW_KIND, acceptedTask, orderAsked, consentSaid, phoneSaid, registrationFrom, registrationInstruction, teamSaid, type DelegationRead, type DelegationTeam } from "../src/emr/delegate.js";
import type { EmrCommit, Provenance, WorkArgs } from "../src/emr/port.js";
import { ADMIT, CLERK_KINDS, ClerkFake, DOC, PAT, clerkBoot, ins } from "./clerking-helpers.js";

const SURG = "surg-1", DESK = "desk-1", PHARM = "pharm-1";
const UNNAMED = "dddddddd-1111-4222-8333-444444444444";
const REVIEW_REQ = "eeeeeeee-1111-4222-8333-444444444444";
const TEAMS: Record<string, DelegationTeam> = {
  surgery: { words: ["surgical", "surgery", "surgeon"], task_kind: "review", title: "Surgical review", label: "Surgery" },
  front_desk: { words: ["front desk", "reception"], task_kind: "registration", title: "Register the emergency arrival", label: "Front desk" },
  pharmacy: { words: ["pharmacy"], task_kind: "dispense", title: "Dispense the voice order", label: "Pharmacy" }
};
const KINDS = [...DELEGATION_RULE_KINDS];
let n = 0;
const uuid = () => `${(++n).toString(16).padStart(8, "0")}-2222-4333-8444-555555555555`;

type Row = DelegationRead & { delegator: string; assignee_owner: string; subject_id: string | null };
// The clerking hospital plus a delegation record each side reads, with the record's own checks for a finished review and a named patient.
class DelegationFake extends ClerkFake {
  readonly rows = new Map<string, Row>();
  reviewDone = false;
  named = false;
  overdue = false;
  dispensed = false;
  prepared = false;
  consultDone = false;
  paid = false;
  handoffs: Record<string, { team: string; subject_table: string }> = {};
  refusals = 0;
  delegationHandoffs(owner: string) { return owner === DOC ? this.handoffs : {}; }
  override async resolve(target: { admission_id?: string; patient_id?: string }) {
    if (target.patient_id === UNNAMED) return { admission_id: "", patient_id: UNNAMED, visit_id: null, label: "Unknown arrival 10:00", facts: {}, keywords: [] };
    return super.resolve(target);
  }
  override kindsFor(owner?: string): readonly string[] {
    if (owner === DOC) return [...CLERK_KINDS, "open_unnamed_encounter", ...KINDS];
    return [NUDGE_KIND, ACK_KIND, REGISTER_KIND, PREPARE_KIND, DISPENSE_KIND];
  }
  delegationSide(owner: string) { return owner === DOC ? ("delegator" as const) : ("assignee" as const); }
  delegationOwners(): readonly string[] { return [DOC, SURG, DESK, PHARM]; }
  delegationTeams(owner: string): Record<string, DelegationTeam> { return owner === DOC ? TEAMS : {}; }
  private view(r: Row): DelegationRead {
    const done = r.kind === "review" ? this.reviewDone : r.kind === "dispense" ? this.dispensed : this.named;
    const id = r.kind === "review" ? REVIEW_REQ : r.kind === "dispense" ? r.subject_id! : UNNAMED;
    return { ...r, subject_prepared: r.kind === "dispense" ? this.prepared : null, consult_finished: r.kind === "dispense" ? this.consultDone : null, subject_ready: r.kind === "dispense" ? this.prepared && this.paid : null, awaiting_payment: r.kind === "dispense" ? this.prepared && !this.paid : null, order_received: r.acknowledged_at !== null, overdue: this.overdue && !r.completed_at, record: done ? { status: "verified", record_id: id, reason: null } : { status: "unsupported_or_incomplete", record_id: null, reason: r.kind === "review" ? "review_open" : "still_unnamed" } };
  }
  async delegations(owner: string, as: "assignee" | "delegator" = "assignee"): Promise<DelegationRead[]> { return [...this.rows.values()].filter((r) => (as === "assignee" ? r.assignee_owner : r.delegator) === owner && !r.completed_at).map((r) => ({ ...this.view(r), instruction: null, created_at: new Date().toISOString() })); }
  async delegation(_owner: string, id: string): Promise<DelegationRead | null> { const r = this.rows.get(id); return r ? this.view(r) : null; }
  override async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    if (!DELEGATION_RULE_KINDS.has(kind)) {
      const c = await super.commit(kind, args, key, prov);
      if (kind === "open_unnamed_encounter" && c.ok) return { ...c, record_id: UNNAMED };
      // A write the profile hands on names its record by id, as the EMR does.
      if (this.handoffs[kind] && c.ok) { const w = this.writes.find((x) => x.key === key)!; if (!/^[0-9a-f]{8}-/.test(w.id)) w.id = uuid(); return { ...c, record_id: w.id }; }
      return c;
    }
    if (this.writes.some((w) => w.key === key)) return { ok: true, record_id: this.writes.find((w) => w.key === key)!.id, record_version: 1, event_ids: [], replayed: true };
    let id = String(args["delegation_id"] ?? "");
    const row = this.rows.get(id);
    if (kind === DELEGATE_KIND) {
      id = uuid();
      this.rows.set(id, {
        id, kind: String(args["task_kind"]), title: String(args["title"]), patient_id: String(args["patient_id"]), admission_id: (args["admission_id"] as string) ?? null, visit_id: null, state: "assigned",
        assignee: null, rule: "on_duty", acknowledged_at: null, completed_at: null, completion_record_id: null, due_at: (args["due_at"] as string) ?? null, overdue: false, escalated_at: null,
        record: { status: "unsupported_or_incomplete", record_id: null, reason: null }, instruction: String(args["instruction"]), nudged: [], subject_prepared: null, order_received: null, consult_finished: null,
        delegator: prov.owner, assignee_owner: args["task_kind"] === "review" ? SURG : args["task_kind"] === "dispense" ? PHARM : DESK, subject_id: (args["subject_id"] as string) ?? null
      });
    } else if (!row) { this.refusals += 1; return { ok: false, reason: "door_404", status: 404, retryable: false, counted: false }; }
    else if (kind === ACK_KIND) { row.acknowledged_at = new Date().toISOString(); row.state = "acknowledged"; }
    else if (kind === NUDGE_KIND) row.nudged.push(String(args["nudge_key"]));
    else if (kind === COMPLETE_KIND) {
      // The record decides: a completion the record does not show is refused, as the door refuses it.
      if (!this.view(row).record.record_id || this.view(row).record.record_id !== args["found_record_id"]) { this.refusals += 1; return { ok: false, reason: "door_409_conflict", status: 409, retryable: false, counted: false }; }
      row.completed_at = new Date().toISOString(); row.state = "completed";
    } else if (kind === ESCALATE_KIND) row.escalated_at = new Date().toISOString();
    else if (kind === REGISTER_KIND) { this.named = true; id = UNNAMED; }
    else if (kind === WARD_REVIEW_KIND) id = REVIEW_REQ;
    else if (kind === PREPARE_KIND) { if (!this.consultDone) { this.refusals += 1; return { ok: false, reason: "door_409_conflict", status: 409, retryable: false, counted: false }; } this.prepared = true; id = String(args["prescription_id"]); }
    else if (kind === DISPENSE_KIND) { if (!this.prepared || !this.paid) { this.refusals += 1; return { ok: false, reason: "door_409_conflict", status: 409, retryable: false, counted: false }; } this.dispensed = true; id = String(args["prescription_id"]); }
    this.writes.push({ kind, args, key, prov, id });
    return { ok: true, record_id: id, record_version: 1, event_ids: [`${kind}:${id}`], replayed: false };
  }
  kindsWritten(owner?: string): string[] { return this.writes.filter((w) => !owner || w.prov.owner === owner).map((w) => w.kind); }
}

const boot = (script: Parameters<typeof clerkBoot>[0], port: DelegationFake) => clerkBoot(script, { port });

describe("delegation by rule between agents", () => {
  it("reads acceptance, phone and consent from the words, never from a model", () => {
    const open = [{ title: "Surgical review" }, { title: "Register the emergency arrival" }];
    expect(acceptedTask("Accepted surgical review.", open)).toEqual({ hit: open[0] });
    expect(acceptedTask("okay, I accept the registration", [{ title: "Register the emergency arrival" }])).toEqual({ hit: { title: "Register the emergency arrival" } });
    expect(acceptedTask("accepted", open)).toEqual({ ambiguous: open });
    expect(acceptedTask("accepted the bloods", open)).toEqual({ none: true });
    expect(acceptedTask("Review her in one hour", open)).toBeNull();
    expect(phoneSaid("her phone is zero eight zero three one two three four five six seven")).toBe("08031234567");
    expect(phoneSaid("the number is 0803 123 4567")).toBe("08031234567");
    expect(consentSaid("She consents to registration.")).toBe(true);
    expect(consentSaid("Verbal consent given.")).toBe(true);
    expect(consentSaid("She does not consent yet.")).toBe(false);
    expect(consentSaid("Consent refused.")).toBe(false);
    expect(consentSaid("She is in pain.")).toBe(false);
    expect(registrationFrom(registrationInstruction("Grace Okafor", null))).toEqual({ name: "Grace Okafor", phone: null });
    expect(teamSaid("surgical review of the abdomen", TEAMS, "review")).toBe("surgery");
    expect(teamSaid("review her abdomen", TEAMS, "review")).toBeNull();
  });

  it("hands a timed surgical review to the surgery team, asks the clinic once she is on a bed, takes a spoken acceptance as acknowledgement only, and closes it from the record", async () => {
    const port = new DelegationFake();
    port.admitted = true;
    const a = boot((said) => (/surgical/i.test(said) ? [ins("schedule_review", { title: "surgical review", in_minutes: 60 })] : /bed/i.test(said) ? [ins("assign_bed", { ward: "a_and_e" })] : []), port);
    const asked = await a.rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Surgical review in one hour." });
    await a.rt.settled();
    expect(port.kindsWritten(DOC)).toEqual(["schedule_review", DELEGATE_KIND]);
    const handed = port.writes.find((w) => w.kind === DELEGATE_KIND)!;
    expect(handed.args).toMatchObject({ task_kind: "review", team: "surgery", title: "Surgical review", admission_id: ADMIT, evidence: `transcript:${asked.line_id}` });
    expect(handed.prov.evidence).toBe(`transcript:${asked.line_id}`);
    // No ward review request before a bed: the EMR takes one only for a patient on a bed.
    await new Promise((r) => setTimeout(r, 60));
    expect(port.kindsWritten()).not.toContain(WARD_REVIEW_KIND);
    await a.rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Put her on a bed in A and E." });
    await a.rt.settled();
    await new Promise((r) => setTimeout(r, 80));
    await a.rt.settled();
    expect(port.kindsWritten(DOC).filter((k) => k === WARD_REVIEW_KIND)).toHaveLength(1);

    // The surgeon's agent finds the task and tells the surgeon on the bell, with no model call.
    await a.rt.pollOnce();
    await a.rt.settled();
    expect(port.kindsWritten(SURG)).toEqual([NUDGE_KIND]);
    const surgTask = a.rt.views(SURG)[0]!;
    expect(surgTask.notes.at(-1)!.text).toMatch(/^New task for you: Surgical review, due .* Say accepted surgical review to take it\.$/);
    expect(port.writes.find((w) => w.kind === NUDGE_KIND)!.prov.evidence).toMatch(/^record:/);

    // A spoken acceptance names one task and acknowledges it; nothing is completed by it.
    const acc = await a.rt.say({ owner: SURG, target: { admission_id: ADMIT }, text: "Accepted surgical review." });
    await a.rt.settled();
    expect(port.kindsWritten(SURG)).toEqual([NUDGE_KIND, ACK_KIND]);
    expect(port.writes.find((w) => w.kind === ACK_KIND)!.prov.evidence).toBe(`transcript:${acc.line_id}`);
    await a.rt.pollOnce();
    await a.rt.settled();
    expect(port.kindsWritten(DOC)).not.toContain(COMPLETE_KIND);
    // Not even an attempt: acknowledgement alone never leads the agent to try closing the task.
    expect(a.rt.view(asked.task_id)!.actions.filter((x) => x.kind === COMPLETE_KIND)).toEqual([]);
    expect(port.refusals).toBe(0);
    const docTask = a.rt.view(asked.task_id)!;
    expect(docTask.notes.map((x) => x.text)).toContain("Accepted by the surgery team: Surgical review. Not done yet; I am watching the record.");
    expect(docTask.delegations[0]).toMatchObject({ side: "delegator", completed_at: null });
    expect(docTask.delegations[0]!.acknowledged_at).not.toBeNull();

    // The surgeon writes the review note as a person; the doctor's agent closes the task from the record and reports back.
    port.reviewDone = true;
    await a.rt.pollOnce();
    await a.rt.settled();
    expect(port.kindsWritten(DOC).filter((k) => k === COMPLETE_KIND)).toHaveLength(1);
    const back = a.rt.view(asked.task_id)!;
    expect(back.notes.at(-1)!.text).toBe(`Done: Surgical review. The record shows it (record ${REVIEW_REQ}).`);
    expect(back.delegations[0]).toMatchObject({ record_id: REVIEW_REQ });
    expect(port.refusals).toBe(0);
    await a.rt.pollOnce();
    await a.rt.settled();
    expect(port.kindsWritten(DOC).filter((k) => k === COMPLETE_KIND)).toHaveLength(1);
    await a.rt.stop();
  });

  it("hands the spoken identity to the front desk, which completes it only with a phone and the patient's consent, and closes the identity on the doctor's side", async () => {
    const port = new DelegationFake();
    const a = boot(() => [], port);
    const er = await a.rt.emergency(DOC, { text: "hey Pisgah, emergency", spoken_at: new Date().toISOString(), args: { unidentified_ref: "Unknown arrival 10:00", reason: "Emergency arrival" } });
    await a.rt.settled();
    const named = await a.rt.say({ owner: DOC, target: { patient_id: UNNAMED }, text: "Her name is Grace Okafor." }, er.task_id);
    await a.rt.settled();
    const handed = port.writes.find((w) => w.kind === DELEGATE_KIND)!;
    expect(handed.args).toMatchObject({ task_kind: "registration", team: "front_desk", subject_table: "patients", subject_id: UNNAMED, evidence: `transcript:${named.line_id}` });
    expect(String(handed.args["title"])).not.toMatch(/Grace|Okafor/);

    await a.rt.pollOnce();
    await a.rt.settled();
    expect(port.writes.find((w) => w.kind === NUDGE_KIND)!.args).toMatchObject({ needs: ["phone", "consent"], nudge_key: "nudge:consent+phone" });
    await a.rt.say({ owner: DESK, target: { patient_id: UNNAMED }, text: "Her phone is 0803 123 4567." });
    await a.rt.settled();
    expect(port.kindsWritten(DESK)).not.toContain(REGISTER_KIND);
    expect(a.rt.views(DESK)[0]!.notes.at(-1)!.text).toBe("Still needed before I register: the patient's consent, said by you.");
    // Negative control: a refusal of consent never completes the record.
    await a.rt.say({ owner: DESK, target: { patient_id: UNNAMED }, text: "She does not consent yet." });
    await a.rt.settled();
    expect(port.kindsWritten(DESK)).not.toContain(REGISTER_KIND);
    const consent = await a.rt.say({ owner: DESK, target: { patient_id: UNNAMED }, text: "She consents to registration." });
    await a.rt.settled();
    const reg = port.writes.find((w) => w.kind === REGISTER_KIND)!;
    expect(reg.args).toMatchObject({ patient_id: UNNAMED, surname: "Okafor", other_names: "Grace", phone: "08031234567", evidence: `transcript:${consent.line_id}` });

    await a.rt.pollOnce();
    await a.rt.settled();
    const doc = a.rt.view(er.task_id)!;
    expect(port.kindsWritten(DOC)).toContain(COMPLETE_KIND);
    expect(doc.identities[0]).toMatchObject({ state: "done" });
    await a.rt.stop();
  });

  it("rings the bell once when a handed task is overdue, and never closes it on a record that does not show it", async () => {
    const port = new DelegationFake();
    port.admitted = true;
    const a = boot(() => [ins("schedule_review", { title: "surgical review", in_minutes: 30 })], port);
    await a.rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Surgical review in thirty minutes." });
    await a.rt.settled();
    port.overdue = true;
    await a.rt.pollOnce();
    await a.rt.settled();
    await a.rt.pollOnce();
    await a.rt.settled();
    expect(port.kindsWritten(DOC).filter((k) => k === ESCALATE_KIND)).toHaveLength(1);
    expect(port.kindsWritten(DOC)).not.toContain(COMPLETE_KIND);
    await a.rt.stop();
  });

  it("hands a verified order on to the pharmacy, where the pharmacist's acceptance is acknowledgement and only the record's dispense closes it", async () => {
    // A care-plan item stands in for the sent voice order, whose kind and record arrive with the voice-order lane; the hand-off is the same.
    const port = new DelegationFake();
    port.admitted = true;
    port.handoffs = { add_care_plan_item: { team: "pharmacy", subject_table: "prescriptions" } };
    const a = boot(() => [ins("add_care_plan_item", { title: "IV paracetamol one gram", item_kind: "medication", cadence: "q6h" })], port);
    const said = await a.rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "IV paracetamol one gram six hourly." });
    await a.rt.settled();
    const order = port.writes.find((w) => w.kind === "add_care_plan_item")!;
    const handed = port.writes.find((w) => w.kind === DELEGATE_KIND)!;
    expect(handed.args).toMatchObject({ task_kind: "dispense", team: "pharmacy", subject_table: "prescriptions", subject_id: order.id, evidence: `transcript:${said.line_id}` });
    await a.rt.pollOnce();
    await a.rt.settled();
    expect(port.kindsWritten(PHARM)).toEqual([NUDGE_KIND]);
    await a.rt.say({ owner: PHARM, target: { admission_id: ADMIT }, text: "Accepted the voice order." });
    await a.rt.settled();
    expect(port.kindsWritten(PHARM)).toEqual([NUDGE_KIND, ACK_KIND]);
    await a.rt.pollOnce();
    await a.rt.settled();
    expect(port.kindsWritten(DOC)).not.toContain(COMPLETE_KIND);
    // The pharmacist asks for it to be prepared and dispensed; the agent waits for the consultation to finish, then reviews, then dispenses.
    const ask = await a.rt.say({ owner: PHARM, target: { admission_id: ADMIT }, text: "Prepare and dispense it." });
    await a.rt.settled();
    expect(port.kindsWritten(PHARM)).toEqual([NUDGE_KIND, ACK_KIND]);
    expect(a.rt.views(PHARM)[0]!.notes.at(-1)!.text).toMatch(/^Held: Dispense the voice order\. The pharmacy reviews it once the doctor finishes the consultation/);
    port.consultDone = true;
    await a.rt.pollOnce();
    await a.rt.settled();
    // Prepared, then held for payment with no dispense tried; the doctor's strip shows the milestone.
    expect(port.kindsWritten(PHARM)).toEqual([NUDGE_KIND, ACK_KIND, PREPARE_KIND]);
    expect(a.rt.views(PHARM)[0]!.notes.at(-1)!.text).toBe("Held: Dispense the voice order is prepared and waits for its payment. I will dispense it when the record shows it ready.");
    await a.rt.pollOnce();
    await a.rt.settled();
    expect(a.rt.view(said.task_id)!.notes.map((n) => n.text)).toContain("Prepared by the pharmacy: Dispense the voice order. It waits for payment before it is dispensed. Not done yet; I am watching the record.");
    port.paid = true;
    await a.rt.pollOnce();
    await a.rt.settled();
    expect(port.kindsWritten(PHARM)).toEqual([NUDGE_KIND, ACK_KIND, PREPARE_KIND, DISPENSE_KIND]);
    expect(port.writes.find((w) => w.kind === DISPENSE_KIND)!.args).toMatchObject({ prescription_id: order.id, evidence: `transcript:${ask.line_id}` });
    expect(port.refusals).toBe(0);
    await a.rt.pollOnce();
    await a.rt.settled();
    expect(a.rt.view(said.task_id)!.notes.at(-1)!.text).toBe(`Done: Dispense the voice order. The record shows it (record ${order.id}).`);
    await a.rt.stop();
  });

  it("reads what the pharmacist asks for a sent order from the words, never from a model", () => {
    expect(orderAsked("Prepare and dispense it.")).toBe("dispense");
    expect(orderAsked("prepare the paracetamol")).toBe("prepare");
    expect(orderAsked("Don't dispense it yet.")).toBeNull();
    expect(orderAsked("She is in pain.")).toBeNull();
  });
});

