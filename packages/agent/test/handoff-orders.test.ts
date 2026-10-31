import { describe, expect, it } from "vitest";
import { DELEGATE_KIND, type DelegationHandoff, type DelegationTeam } from "../src/emr/delegate.js";
import { ORDER_REFERENCE_KINDS } from "../src/emr/gate.js";
import type { EmrCommit, EmrTarget, OrderResult, Orderables, Provenance, WatchRead, WorkArgs } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { ClerkFake, DOC, PAT, VISIT, clerkBoot, ins } from "./clerking-helpers.js";

const KINDS = [...new Set([...ORDER_REFERENCE_KINDS, "record_note", DELEGATE_KIND])];
const RESULTED = ["resulted", "reported"];
const OWNER: Voiceprint = { vector: [5], ms: 20, model: "nemo_en_titanet_small" };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const uuid = () => `${(++n).toString(16).padStart(8, "0")}-3333-4444-8555-666666666666`;

// The clerking hospital with voice orders handed on to the lab, and each sent order's result state read by its id.
class LabFake extends ClerkFake {
  readonly states = new Map<string, { test: string; state: string }>();
  failDelegateOnce = false;
  override admitted = true;
  private t = 0;
  override kindsFor(): readonly string[] { return KINDS; }
  orderables(): Orderables { return { tests: { fbc: ["full blood count", "FBC", "blood count"], malaria: ["malaria test", "malaria"] }, drugs: {} }; }
  delegationTeams(): Record<string, DelegationTeam> { return { lab: { words: ["lab"], task_kind: "lab_order", title: "Receive the lab order", label: "Lab" } }; }
  delegationHandoffs(): Record<string, DelegationHandoff> { return { order_test: { team: "lab", subject_table: "orders" } }; }
  resultStates(): readonly string[] { return RESULTED; }
  async orderResults(_owner: string, _subject: EmrTarget & { visit_id?: string | null }): Promise<OrderResult[]> { return [...this.states].map(([id, s]) => ({ id, test: s.test, state: s.state })); }
  readonly speaker = async (): Promise<SpeakerVerdict> => { this.t += 1; return { speaker: "owner", token: `v1.${String(1_761_700_000_000 + this.t)}.${"A".repeat(43)}` }; };
  override async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    const hit = this.writes.find((w) => w.key === key);
    if (hit) return { ok: true, record_id: hit.id, record_version: 1, event_ids: [], replayed: true };
    if (kind === DELEGATE_KIND && this.failDelegateOnce) { this.failDelegateOnce = false; return { ok: false, reason: "door_503", status: 503, retryable: true, counted: false }; }
    const id = uuid();
    this.writes.push({ kind, args, key, prov, id });
    if (kind === "order_test") this.states.set(id, { test: String(args["test"]), state: "SENT" });
    return { ok: true, record_id: id, record_version: 1, event_ids: [`${kind}:${id}`], replayed: false };
  }
  // The visit's test list as a screen shows it, which changes on any result or any new test.
  override async watch(_owner: string, subject: EmrTarget & { visit_id?: string | null }): Promise<WatchRead | null> {
    return subject.visit_id ? { facts: { "orders.tests": `${this.tests}${JSON.stringify([...this.states.values()])}` }, labels: { "orders.tests": "Tests on the visit" } } : null;
  }
  of(kind: string) { return this.writes.filter((w) => w.kind === kind); }
  resultFor(test: string, state: string) { for (const [id, s] of this.states) if (s.test === test) this.states.set(id, { ...s, state }); }
}

const script = (s: string) => {
  const out = [];
  if (/blood count/i.test(s) && /send/i.test(s)) out.push(ins("order_test", { test: "fbc" }));
  if (/malaria/i.test(s) && /send/i.test(s)) out.push(ins("order_test", { test: "malaria" }));
  if (/let me know|tell me/i.test(s)) out.push({ ...ins("record_note", { after: "result" }), kind: null, asked_for: "notify when malaria result available" });
  else if (/comes? back|is back/i.test(s)) out.push(ins("record_note", { note_type: "progress", text: "result back, reviewed", after: "result" }));
  return out;
};
const say = (rt: ReturnType<typeof clerkBoot>["rt"], text: string, task?: string) => rt.say({ owner: DOC, target: { patient_id: PAT }, text, source: "audio", voiceprint: OWNER }, task);

describe("hand-offs keyed by the order, conditions keyed by the result", () => {
  it("hands both tests of one sentence to the lab, one task per order, and a retried hand-off makes no second task", async () => {
    const port = new LabFake();
    port.failDelegateOnce = true;
    const a = clerkBoot(script, { port });
    const said = await say(a.rt, "Send a full blood count and a malaria test.");
    await a.rt.settled();
    await wait(50);
    await a.rt.settled();
    const orders = port.of("order_test");
    expect(orders.map((w) => w.args["test"])).toEqual(["fbc", "malaria"]);
    const handed = port.of(DELEGATE_KIND);
    // Reproduced: the second test's hand-off was dropped because both shared the line and the team.
    expect(handed.map((w) => w.args["subject_id"]).sort()).toEqual(orders.map((w) => w.id).sort());
    expect(handed.every((w) => w.prov.evidence === `transcript:${said.line_id}`)).toBe(true);
    const v = a.rt.view(said.task_id)!;
    expect(v.delegations.filter((d) => d.side === "delegator").map((d) => d.subject_id).sort()).toEqual(orders.map((w) => w.id).sort());
    await a.rt.stop();
  });

  it("fires 'when the blood count comes back' only on that order's result, never on an unrelated result or a new test on the list", async () => {
    const port = new LabFake();
    const a = clerkBoot(script, { port, watchMs: 20 });
    const sent = await say(a.rt, "Send a full blood count and a malaria test.");
    await a.rt.settled();
    await say(a.rt, "When the blood count comes back, write a progress note.", sent.task_id);
    await a.rt.settled();
    const o = a.rt.view(sent.task_id)!.obligations[0]!;
    const fbc = port.of("order_test").find((w) => w.args["test"] === "fbc")!;
    expect(o).toMatchObject({ after: "result", state: "held", condition: { order_actions: [expect.any(String)], states: RESULTED } });
    // Negative controls: the malaria result and a third test added to the visit change nothing.
    port.resultFor("malaria", "resulted");
    port.states.set(uuid(), { test: "fbc", state: "SENT" });
    await wait(150);
    await a.rt.settled();
    expect(port.of("record_note")).toHaveLength(0);
    expect(a.rt.view(sent.task_id)!.obligations[0]).toMatchObject({ state: "held", condition: { orders: [fbc.id] } });
    port.resultFor("fbc", "resulted");
    for (let i = 0; i < 100 && !port.of("record_note").length; i++) await wait(20);
    await a.rt.settled();
    expect(port.of("record_note")).toHaveLength(1);
    expect(a.rt.view(sent.task_id)!.obligations[0]).toMatchObject({ state: "done", fired_by: "condition" });
    await a.rt.stop();
  });

  // Acceptance rehearsal, 31 Oct: "When the malaria result comes back, let me know" names no work, and the gate refusal left it as "Not mine to do".
  it("holds 'let me know when the malaria result comes back' on that order and tells the clinician once, writing nothing", async () => {
    const port = new LabFake();
    const a = clerkBoot(script, { port, watchMs: 20 });
    const sent = await say(a.rt, "Send a full blood count and a malaria test.");
    await a.rt.settled();
    await say(a.rt, "When the malaria result comes back, let me know.", sent.task_id);
    await a.rt.settled();
    expect(a.rt.view(sent.task_id)!.notes.some((x) => x.text.startsWith("Not mine to do"))).toBe(false);
    expect(a.rt.view(sent.task_id)!.obligations[0]).toMatchObject({ kind: "tell_me", after: "result", state: "held" });
    port.resultFor("fbc", "resulted");
    await wait(150);
    await a.rt.settled();
    expect(a.rt.view(sent.task_id)!.obligations[0]).toMatchObject({ state: "held" });
    port.resultFor("malaria", "resulted");
    for (let i = 0; i < 100 && a.rt.view(sent.task_id)!.obligations[0]!.state === "held"; i++) await wait(20);
    await a.rt.settled();
    expect(a.rt.view(sent.task_id)!.obligations[0]).toMatchObject({ state: "done", fired_by: "condition" });
    expect(a.rt.view(sent.task_id)!.notes.filter((x) => x.text.includes("result is back in the record"))).toHaveLength(1);
    expect(port.of("record_note")).toHaveLength(0);
    await a.rt.stop();
  });

  it("keeps the bound order across a restart, fires once on its result, and hands nothing on twice", async () => {
    const clock = { now: Date.now() };
    const port = new LabFake();
    const a = clerkBoot(script, { port, clock, watchMs: 20 });
    const sent = await say(a.rt, "Send a full blood count and a malaria test.");
    await a.rt.settled();
    await say(a.rt, "When the blood count comes back, write a progress note.", sent.task_id);
    await a.rt.settled();
    await wait(80);
    await a.rt.stop();
    a.client.close();
    const handedBefore = port.of(DELEGATE_KIND).length;
    expect(handedBefore).toBe(2);
    const b = clerkBoot(script, { root: a.root, port, clock, watchMs: 20 });
    port.resultFor("malaria", "reported");
    await wait(150);
    await b.rt.settled();
    expect(port.of("record_note")).toHaveLength(0);
    port.resultFor("fbc", "reported");
    for (let i = 0; i < 100 && !port.of("record_note").length; i++) await wait(20);
    await wait(100);
    await b.rt.settled();
    expect(port.of("record_note")).toHaveLength(1);
    expect(port.of(DELEGATE_KIND)).toHaveLength(handedBefore);
    await b.rt.stop();
  });

  it("asks which result to wait for when nothing sent is waiting for one, and holds nothing on a general list change", async () => {
    const port = new LabFake();
    const a = clerkBoot(script, { port, watchMs: 20 });
    const said = await say(a.rt, "When the blood count comes back, write a progress note.");
    await a.rt.settled();
    await wait(100);
    await a.rt.settled();
    const v = a.rt.view(said.task_id)!;
    expect(v.obligations[0]).toMatchObject({ state: "held", condition: { orders: [], tests: ["fbc"] } });
    expect(v.notes.at(-1)!.text).toBe('No blood count sent here is waiting for a result, so this waits until one is sent: Write a progress note: "result back, reviewed".');
    port.tests = '[{"name":"FBC","status":"resulted"}]';
    await wait(100);
    await a.rt.settled();
    expect(port.of("record_note")).toHaveLength(0);
    void VISIT;
    await a.rt.stop();
  });
});
