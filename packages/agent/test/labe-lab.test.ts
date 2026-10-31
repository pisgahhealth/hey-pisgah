import { describe, expect, it } from "vitest";
import { ACK_KIND, CANCEL_TEST_KIND, DELEGATE_KIND, DELEGATION_RULE_KINDS, NUDGE_KIND, RECEIVE_KIND, cancelReason, labAsked, type DelegationRead, type DelegationTeam } from "../src/emr/delegate.js";
import type { EmrCommit, Orderables, Provenance, WorkArgs } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { CLERK_KINDS, ClerkFake, DOC, PAT, VISIT, clerkBoot, ins } from "./clerking-helpers.js";

// Lane LABE, RECONCILE 4.1: the lab scientist's agent receives and cancels a test handed to the lab, by rule, on her own voice.
const LAB = "lab-1";
const ORDER: Record<string, string> = { fbc: "f0000001-2222-4333-8444-555555555555", urinalysis: "f0000002-2222-4333-8444-555555555555" };
const STATE: Record<string, string> = { fbc: "e0000001-2222-4333-8444-555555555555", urinalysis: "e0000002-2222-4333-8444-555555555555" };
const TEAMS: Record<string, DelegationTeam> = { lab: { words: ["lab"], task_kind: "lab_order", title: "Receive the lab order", label: "Laboratory" } };
const vp = (n: number): Voiceprint => ({ vector: [n], ms: 20, model: "nemo_en_titanet_small" });
const DOC_V = vp(5), LAB_V = vp(6), DRB_V = vp(4);
let n = 0;
const uuid = () => `${(++n).toString(16).padStart(8, "0")}-3333-4333-8444-555555555555`;

type Row = DelegationRead & { assignee_owner: string };
// A hospital where the doctor's sent test names its lab order, the lab reads its hand-offs with their instruction, and the lab door can answer 409.
class LabFake extends ClerkFake {
  readonly rows = new Map<string, Row>();
  conflict = false;
  private t = 0;
  override kindsFor(owner?: string): readonly string[] { return owner === LAB ? [NUDGE_KIND, ACK_KIND, RECEIVE_KIND, CANCEL_TEST_KIND] : [...CLERK_KINDS, "order_test", DELEGATE_KIND]; }
  orderables(): Orderables { return { tests: { fbc: ["full blood count", "FBC"], urinalysis: ["urinalysis", "urine test"] }, drugs: {} }; }
  delegationHandoffs(owner: string) { return owner === DOC ? { order_test: { team: "lab", subject_table: "diagnostic_orders" } } : {}; }
  delegationSide(owner: string) { return owner === DOC ? ("delegator" as const) : ("assignee" as const); }
  delegationOwners(): readonly string[] { return [DOC, LAB]; }
  delegationTeams(owner: string): Record<string, DelegationTeam> { return owner === DOC ? TEAMS : {}; }
  async delegations(owner: string, as: "assignee" | "delegator" = "assignee"): Promise<DelegationRead[]> { return as === "assignee" ? [...this.rows.values()].filter((r) => r.assignee_owner === owner) : []; }
  async delegation(_o: string, id: string): Promise<DelegationRead | null> { return this.rows.get(id) ?? null; }
  readonly speaker = async (owner: string, v: readonly number[]): Promise<SpeakerVerdict> => {
    this.t += 1;
    if ((owner === DOC && v[0] === 5) || (owner === LAB && v[0] === 6)) return { speaker: "owner", token: `v1.${String(1_761_700_000_000 + this.t)}.${"A".repeat(43)}` };
    return v[0] === 4 ? { speaker: "other_clinician", label: "Dr B", role: "doctor" } : { speaker: "unverified", reason: "no_match" };
  };
  override async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    const again = this.writes.find((w) => w.key === key);
    if (again) return { ok: true, record_id: again.id, record_version: 1, event_ids: [], replayed: true };
    if (kind === "order_test") {
      const test = String(args["test"]);
      this.writes.push({ kind, args, key, prov, id: STATE[test]! });
      return { ok: true, record_id: STATE[test]!, record_version: 1, event_ids: [`voice_order:${STATE[test]}`, `diagnostic_orders:${ORDER[test]}`], replayed: false };
    }
    if (kind === DELEGATE_KIND) {
      const id = uuid();
      this.rows.set(id, {
        id, kind: String(args["task_kind"]), title: String(args["title"]), patient_id: String(args["patient_id"]), admission_id: null, visit_id: VISIT, state: "assigned", assignee: null, rule: "on_duty",
        acknowledged_at: null, completed_at: null, completion_record_id: null, due_at: null, overdue: false, escalated_at: null, record: { status: "unsupported_or_incomplete", record_id: null, reason: null },
        instruction: String(args["instruction"]), nudged: [], subject_id: String(args["subject_id"]), subject_prepared: null, order_received: null, consult_finished: null, assignee_owner: LAB
      });
      this.writes.push({ kind, args, key, prov, id });
      return { ok: true, record_id: id, record_version: 1, event_ids: [`delegation:${id}`], replayed: false };
    }
    if (kind === RECEIVE_KIND && this.conflict) {
      this.writes.push({ kind: "refused_receive", args, key, prov, id: "" });
      return { ok: false, reason: "door_409_conflict", status: 409, retryable: false, counted: false };
    }
    if (kind === ACK_KIND) { const r = this.rows.get(String(args["delegation_id"])); if (r) r.acknowledged_at = new Date().toISOString(); }
    const id = kind === RECEIVE_KIND || kind === CANCEL_TEST_KIND ? uuid() : String(args["delegation_id"] ?? uuid());
    this.writes.push({ kind, args, key, prov, id });
    return { ok: true, record_id: id, record_version: 1, event_ids: [`${kind}:${id}`], replayed: false };
  }
}

const gate = (s: string) => (/full blood count/i.test(s) && /^Send/.test(s) ? [ins("order_test", { test: "fbc" })] : /urinalysis/i.test(s) && /^Send/.test(s) ? [ins("order_test", { test: "urinalysis" })] : [{ class: "aside" as const, confidence: 0.9 }]);
async function handed(tests: string[]) {
  const port = new LabFake();
  const b = clerkBoot(gate, { port });
  for (const t of tests) await b.rt.say({ owner: DOC, target: { patient_id: PAT }, text: `Send a ${t === "fbc" ? "full blood count" : "urinalysis"}.`, source: "audio", voiceprint: DOC_V });
  await b.rt.settled();
  await b.rt.pollOnce();
  await b.rt.settled();
  return { ...b, port };
}
const labSay = (b: Awaited<ReturnType<typeof handed>>, text: string, v: Voiceprint = LAB_V) => b.rt.say({ owner: LAB, target: { patient_id: PAT }, text, source: "audio", voiceprint: v });
const lab = (port: LabFake, kind: string) => port.writes.filter((w) => w.kind === kind && w.prov.owner === LAB);
const labNotes = (b: Awaited<ReturnType<typeof handed>>) => b.rt.views(LAB).flatMap((v) => v.notes.map((x) => x.text));
const labAsks = (b: Awaited<ReturnType<typeof handed>>) => b.rt.views(LAB).flatMap((v) => v.questions.map((x) => x.text));

describe("LABE 4.1: the lab hand-off names the lab order", () => {
  it("hands the sent test to the lab about its diagnostic order, not the order's voice state", async () => {
    const b = await handed(["fbc"]);
    expect(b.port.writes.find((w) => w.kind === DELEGATE_KIND)!.args).toMatchObject({ task_kind: "lab_order", subject_table: "diagnostic_orders", subject_id: ORDER["fbc"] });
    await b.rt.stop();
  });
});

describe("LABE 4.1: the lab scientist receives and cancels by voice", () => {
  it("receives the FBC the line names, on the lab order, once, and takes the task", async () => {
    const b = await handed(["urinalysis", "fbc"]);
    const s = await labSay(b, "Received the FBC for Emeka, running it.");
    await b.rt.settled();
    expect(lab(b.port, RECEIVE_KIND).map((w) => w.args)).toEqual([expect.objectContaining({ order_id: ORDER["fbc"], test: "fbc", evidence: `transcript:${s.line_id}` })]);
    expect(lab(b.port, ACK_KIND)).toHaveLength(1);
    const act = b.rt.views(LAB).flatMap((v) => v.actions).find((a) => a.kind === RECEIVE_KIND)!;
    expect(act.screen).toMatchObject({ page: "lab_board", section: "worklist" });
    await b.rt.stop();
  });

  it("reports a 409 and never sends it again", async () => {
    const b = await handed(["fbc"]);
    b.port.conflict = true;
    await labSay(b, "FBC is in, running it.");
    await b.rt.settled();
    await b.rt.pollOnce();
    await b.rt.settled();
    expect(b.port.writes.filter((w) => w.kind === "refused_receive")).toHaveLength(1);
    expect(labNotes(b).some((x) => /not done\. The lab record changed or the test has started, so I did not try again/.test(x))).toBe(true);
    await b.rt.stop();
  });

  it("asks why when a cancel states no reason, and cancels with the reason said", async () => {
    const b = await handed(["urinalysis"]);
    await labSay(b, "Cancel the urinalysis.");
    await b.rt.settled();
    expect(lab(b.port, CANCEL_TEST_KIND)).toHaveLength(0);
    expect(labAsks(b).some((q) => /^Why is the urinalysis cancelled\?/.test(q))).toBe(true);
    await labSay(b, "Cancel the urinalysis, the doctor cancelled it.");
    await b.rt.settled();
    expect(lab(b.port, CANCEL_TEST_KIND).map((w) => w.args)).toEqual([expect.objectContaining({ order_id: ORDER["urinalysis"], reason: "requester_cancelled" })]);
    await b.rt.stop();
  });

  it("asks which test when the line names none, and never acts on Dr B's voice", async () => {
    const b = await handed(["fbc"]);
    await labSay(b, "Received it, running it.");
    await b.rt.settled();
    expect(labAsks(b).some((q) => /^Which test\? Waiting: full blood count/.test(q))).toBe(true);
    await labSay(b, "Received the FBC, running it.", DRB_V);
    await b.rt.settled();
    expect(lab(b.port, RECEIVE_KIND)).toHaveLength(0);
    expect(labNotes(b)).toContain("Dr B said that, so I did not act on it. Say it yourself.");
    await b.rt.stop();
  });

  it("a doctor's agent never proposes the lab kinds", async () => {
    const b = await handed(["fbc"]);
    await b.rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Received the FBC, running it.", source: "audio", voiceprint: DOC_V });
    await b.rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Cancel the FBC, the patient declined.", source: "audio", voiceprint: DOC_V });
    await b.rt.settled();
    expect(b.port.writes.filter((w) => w.kind === RECEIVE_KIND || w.kind === CANCEL_TEST_KIND)).toHaveLength(0);
    expect(DELEGATION_RULE_KINDS.has(RECEIVE_KIND) && DELEGATION_RULE_KINDS.has(CANCEL_TEST_KIND)).toBe(true);
    await b.rt.stop();
  });

  it("reads the ask and the reason from the words, never from a model", () => {
    expect(labAsked("Received the FBC for Emeka, running it.")).toBe("receive");
    expect(labAsked("Cancel the urinalysis, the doctor cancelled it.")).toBe("cancel");
    expect(labAsked("The FBC looks fine.")).toBeNull();
    expect(cancelReason("the doctor cancelled it")).toBe("requester_cancelled");
    expect(cancelReason("the patient declined")).toBe("patient_declined");
    expect(cancelReason("she did not come")).toBe("patient_no_show");
    expect(cancelReason("we could not reach him")).toBe("unable_to_contact");
    expect(cancelReason("it is a duplicate")).toBe("duplicate_order");
    expect(cancelReason("it was entered in error")).toBe("entered_in_error");
    expect(cancelReason("cancel it")).toBeNull();
  });
});
