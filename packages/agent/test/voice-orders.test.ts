import { describe, expect, it } from "vitest";
import { gatePrompt, gateTool, holdsOrders, ORDER_REFERENCE_KINDS } from "../src/emr/gate.js";
import type { Orderables, Provenance, ReadBack } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { doseAgrees, dosesIn, prescriptionSaid } from "../src/emr/work.js";
import { ModelClient } from "@hey-pisgah/model";
import { EmrRuntime } from "../src/emr/runtime.js";
import type { SecondEar } from "../src/emr/ears.js";
import { ClerkFake, PAT, VISIT, DOC, clerkBoot, ins } from "./clerking-helpers.js";
import { emrRoot, gater, type C } from "./emr-helpers.js";

const ORDER_KINDS = [...ORDER_REFERENCE_KINDS];
const ITEM_A = "dddddddd-1111-4222-8333-444444444444";
const ITEM_B = "eeeeeeee-1111-4222-8333-444444444444";
const TOKEN = (n: number) => `v1.${String(1_761_700_000_000 + n)}.${"A".repeat(43)}`;
const print = (who: string): Voiceprint => ({ vector: [who.length], ms: 20, model: "nemo_en_titanet_small" });

// The clerking hospital with voice orders: the speaker match answers by the test's own voiceprint, and the read-back is scripted.
class OrderFake extends ClerkFake {
  readBackAnswer: ReadBack = { items: [{ stateId: ITEM_A, label: "Full Blood Count", kind: "lab", controlled: false, sentAt: "2026-10-29T10:00:00.000Z" }], itemsDigest: "a".repeat(64), readBackAt: "2026-10-29T10:05:00.000Z", seal: "S".repeat(43), awaitingSecond: [], changed: [] };
  readonly matched: string[] = [];
  private n = 0;
  override kindsFor(): readonly string[] { return ORDER_KINDS; }
  orderables(): Orderables { return { tests: { fbc: ["full blood count", "FBC"] }, drugs: { paracetamol_iv: { words: ["paracetamol"], controlled: false }, morphine: { words: ["morphine"], controlled: true } } }; }
  readonly speaker = async (_owner: string, v: readonly number[], prov: Provenance): Promise<SpeakerVerdict> => {
    this.matched.push(prov.evidence);
    this.n += 1;
    // The voiceprint's one number stands for who spoke: 5 is the owner, 4 is Dr B, anything else is a stranger.
    return v[0] === 5 ? { speaker: "owner", token: TOKEN(this.n) } : v[0] === 4 ? { speaker: "other_clinician", label: "Dr. Bisi", role: "doctor" } : { speaker: "unverified", reason: "no_match" };
  };
  readonly readBack = async (): Promise<ReadBack> => this.readBackAnswer;
}

const OWNER_VOICE = print("owner"), DR_B = print("drbi"), STRANGER = print("x");
const sayAs = (rt: ReturnType<typeof clerkBoot>["rt"], text: string, voiceprint: Voiceprint | null) =>
  rt.say({ owner: DOC, target: { patient_id: PAT }, text, source: "audio", ...(voiceprint ? { voiceprint } : {}) });

function orderBoot(script: Parameters<typeof clerkBoot>[0]) {
  const port = new OrderFake();
  return { ...clerkBoot(script, { port }), port };
}

describe("voice orders, attribution and countersign", () => {
  it("names order kinds only for an order owner, keeps tests and medicines in the prompt, and leaves the clerking prompt as it was", () => {
    expect(holdsOrders(ORDER_KINDS)).toBe(true);
    const p = gatePrompt(ORDER_KINDS, { page_targets: {}, clinics: {}, wards: {}, tests: { fbc: ["full blood count"] }, drugs: { morphine: ["morphine"] } });
    expect(p).toContain("order_test:");
    expect(p).toContain("fbc (full blood count)");
    expect(p).not.toContain("countersign:");
    expect(JSON.stringify(gateTool(ORDER_KINDS))).toContain("duration_days");
  });

  it("sends an order the owner's matched voice gave, with that line's token, and never one from an unmatched voice until the owner says yes", async () => {
    const { rt, port } = orderBoot((s) => (s.includes("blood count") ? [ins("order_test", { test: "fbc" })] : []));
    // Negative control: a voice the hospital cannot match asks for the test, and nothing is sent.
    const a = await sayAs(rt, "Send a full blood count.", STRANGER);
    await rt.settled();
    expect(port.writes.filter((w) => w.kind === "order_test")).toHaveLength(0);
    const held = rt.view(a.task_id)!.actions.find((x) => x.kind === "order_test")!;
    expect(held).toMatchObject({ state: "proposed", awaiting: "owner_voice" });
    // A yes from another enrolled clinician does not authorise it either.
    await sayAs(rt, "Yes.", DR_B);
    await rt.settled();
    expect(port.writes.filter((w) => w.kind === "order_test")).toHaveLength(0);
    // The owner's own yes authorises it, and the write carries that line's token.
    const yes = await sayAs(rt, "Yes.", OWNER_VOICE);
    await rt.settled();
    const sent = port.writes.filter((w) => w.kind === "order_test");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.args).toEqual({ visit_id: VISIT, patient_id: PAT, test: "fbc" });
    expect(sent[0]!.prov.voice?.authorisation).toBe(`transcript:${yes.line_id}~${TOKEN(3)}`);
    expect(sent[0]!.prov.evidence).toBe(`transcript:${a.line_id}`);
    // The owner's own instruction goes straight through on its own line.
    const b = await sayAs(rt, "Send another full blood count urgently.", OWNER_VOICE);
    await rt.settled();
    const second = port.writes.filter((w) => w.kind === "order_test")[1]!;
    expect(second.args["priority"]).toBe("urgent");
    expect(second.prov.voice?.authorisation).toContain(`transcript:${b.line_id}~`);
    await rt.stop();
  });

  it("records another clinician's finding as theirs and refuses their order, and marks an unmatched finding unverified", async () => {
    const { rt, port } = orderBoot((s) => (s.startsWith("Chest") ? [{ class: "finding", section: "examination", text: s }] : s.includes("paracetamol") ? [ins("prescribe", { drug: "paracetamol_iv" })] : []));
    const v = await sayAs(rt, "Chest is clear on both sides.", DR_B);
    await rt.settled();
    await sayAs(rt, "Give paracetamol 1 g IV stat.", DR_B);
    await rt.settled();
    await sayAs(rt, "Chest sounds a little wheezy.", STRANGER);
    await rt.settled();
    const notes = port.writes.filter((w) => w.kind === "record_clerking").map((w) => String(w.args["text"]));
    expect(notes).toEqual(["Dr. Bisi said: Chest is clear on both sides.", "Speaker not verified: Chest sounds a little wheezy."]);
    expect(port.writes.some((w) => w.kind === "prescribe")).toBe(false);
    const view = rt.view(v.task_id)!;
    expect(view.notes.some((n) => /Dr\. Bisi's orders need Dr\. Bisi's own session/.test(n.text))).toBe(true);
    expect(view.transcript.map((l) => l.speaker?.speaker)).toEqual(["other_clinician", "other_clinician", "unverified"]);
    await rt.stop();
  });

  it("takes the drug the gate named when the ear spells it its own way, and never a drug only like another one or one the line does not hold", async () => {
    const words = { tests: {}, drugs: { paracetamol_iv: { words: ["IV paracetamol", "paracetamol IV"], controlled: false }, paracetamol_oral: { words: ["paracetamol tablets", "oral paracetamol"], controlled: false }, morphine: { words: ["morphine"], controlled: true } } };
    const { rt, port } = orderBoot((s) => (/give her/i.test(s) ? [ins("prescribe", { drug: "paracetamol_iv", dose: "1 g" })] : /amox/i.test(s) ? [ins("prescribe", { drug: "paracetamol_iv" })] : []));
    port.orderables = () => words;
    // Pass 10's A10: the local ear wrote "IV pay rasitamol".
    await sayAs(rt, "Give her IV pay rasitamol, one gram, eight hourly, for one day. That's three doses", OWNER_VOICE);
    await rt.settled();
    const rx = port.writes.filter((w) => w.kind === "prescribe");
    expect(rx).toHaveLength(1);
    expect(rx[0]!.args).toMatchObject({ drug: "paracetamol_iv", quantity: 3 });
    // Negative control: a line that holds no word near any of that drug's words is still asked about.
    const b = await sayAs(rt, "Give her amoxil, one gram, for one day, three doses", OWNER_VOICE);
    await rt.settled();
    expect(port.writes.filter((w) => w.kind === "prescribe")).toHaveLength(1);
    expect(rt.view(b.task_id)!.questions.at(-1)!.text).toMatch(/Which medicine should I prescribe/);
    await rt.stop();
  });

  it("holds a controlled drug for the owner's spoken confirm and sends it with that line as confirmation", async () => {
    const { rt, port } = orderBoot((s) => (s.includes("morphine") ? [ins("prescribe", { drug: "morphine", dose: "5 mg" })] : []));
    const a = await sayAs(rt, "Give morphine 5 mg IV, one dose.", OWNER_VOICE);
    await rt.settled();
    expect(port.writes.filter((w) => w.kind === "prescribe")).toHaveLength(0);
    expect(rt.view(a.task_id)!.questions.at(-1)!.text).toMatch(/controlled drug: say confirm/);
    await sayAs(rt, "Confirm.", STRANGER);
    await rt.settled();
    expect(port.writes.filter((w) => w.kind === "prescribe")).toHaveLength(0);
    const c = await sayAs(rt, "Confirm.", OWNER_VOICE);
    await rt.settled();
    const rx = port.writes.filter((w) => w.kind === "prescribe");
    expect(rx).toHaveLength(1);
    expect(rx[0]!.args).toMatchObject({ drug: "morphine", dose: "5 mg", route: "iv", quantity: 1 });
    expect(rx[0]!.prov.voice?.confirmation).toContain(`transcript:${c.line_id}~`);
    expect(rx[0]!.prov.voice?.authorisation).toContain(`transcript:${a.line_id}~`);
    await rt.stop();
  });

  it("reads back the identified batch on sign everything and countersigns exactly it on the owner's yes", async () => {
    const { rt, port } = orderBoot(() => []);
    const s = await sayAs(rt, "Sign everything.", OWNER_VOICE);
    await rt.settled();
    const q = rt.view(s.task_id)!.questions.at(-1)!;
    expect(q.text).toMatch(/Countersign 1 voice order: 1\. Full Blood Count sent 10:00/);
    // An order added after the read-back is not in the batch the yes signs.
    port.readBackAnswer = { ...port.readBackAnswer, items: [...port.readBackAnswer.items, { stateId: ITEM_B, label: "Urinalysis", kind: "lab", controlled: false, sentAt: null }], itemsDigest: "b".repeat(64) };
    const yes = await sayAs(rt, "Yes.", OWNER_VOICE);
    await rt.settled();
    const cs = port.writes.filter((w) => w.kind === "countersign");
    expect(cs).toHaveLength(1);
    expect(cs[0]!.args).toMatchObject({ visit_id: VISIT, item_ids: [ITEM_A], items_digest: "a".repeat(64), read_back_at: "2026-10-29T10:05:00.000Z", read_back_seal: "S".repeat(43) });
    expect(cs[0]!.prov.voice?.confirmation).toContain(`transcript:${yes.line_id}~`);
    await rt.stop();
  });

  it("does not read back or sign when the voice is not the owner's", async () => {
    const { rt, port } = orderBoot(() => []);
    const s = await sayAs(rt, "Sign everything.", DR_B);
    await rt.settled();
    expect(port.writes).toHaveLength(0);
    expect(rt.view(s.task_id)!.questions).toHaveLength(0);
    await rt.stop();
  });

  it("reads a prescription only from the words said, with stat as one dose and no value worked out", () => {
    expect(prescriptionSaid("Give paracetamol 1 g IV three times a day for 3 days, quantity 9.", { dose: "1 g" })).toEqual({ dose: "1 g", frequency: 3, duration_days: 3, quantity: 9, route: "iv" });
    expect(prescriptionSaid("Paracetamol 1 g IV stat.", { dose: "1 g" })).toMatchObject({ quantity: 1, route: "iv", frequency: null });
    expect(prescriptionSaid("Paracetamol twice a day.", { dose: "500 mg" })).toEqual({ dose: null, frequency: 2, duration_days: null, quantity: null, route: null });
  });

  it("holds a prescription when the second reading hears its dose unit differently, and sends it when both agree", async () => {
    expect(dosesIn("Give paracetamol 500 milligrams IV")).toEqual([{ n: "500", unit: "mg" }]);
    expect(doseAgrees("500 mg", "give paracetamol 500 milliliters iv")).toBe(false);
    expect(doseAgrees("500 mg", "give paracetamol 500mg iv")).toBe(true);
    expect(doseAgrees("1 g", "paracetamol one gram")).toBe(true);
    expect(doseAgrees("1 g", "paracetamol two grams")).toBe(false);
    expect(dosesIn("give morphine five milligrams IV")).toEqual([{ n: "5", unit: "mg" }]);
    const run = async (heard: string) => {
      const root = emrRoot();
      const port = new OrderFake();
      let rt: EmrRuntime | null = null;
      const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater(() => [ins("prescribe", { drug: "paracetamol_iv", dose: "500 mg" }) as unknown as C]), taskStateOf: (id) => rt?.stateOf(id) ?? null });
      const ear: SecondEar = async () => ({ text: heard, provider: "modal", model: "spark", response_id: null, cost_usd: 0, fallback_reason: null });
      rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1, secondEar: ear });
      rt.start();
      const a = await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Give paracetamol 500 mg IV, quantity 2.", source: "audio", voiceprint: OWNER_VOICE, clip: new Uint8Array(44) });
      await rt.settled();
      const out = { sent: port.writes.filter((w) => w.kind === "prescribe").length, view: rt.view(a.task_id)! };
      await rt.stop();
      return out;
    };
    const swapped = await run("Give paracetamol 500 milliliters IV, quantity 2.");
    expect(swapped.sent).toBe(0);
    expect(swapped.view.actions.find((x) => x.kind === "prescribe")).toMatchObject({ state: "cancelled", reason: "dose_readings_differ" });
    expect(swapped.view.questions.at(-1)!.text).toMatch(/Nothing was sent/);
    expect((await run("Give paracetamol 500 milligrams IV, quantity 2.")).sent).toBe(1);
  });

  it("gives an unenrolled second voice no authority: its order waits and is never sent on its own", async () => {
    const { rt, port } = orderBoot((s) => (s.includes("morphine") ? [ins("prescribe", { drug: "morphine", dose: "10 mg" })] : []));
    const a = await sayAs(rt, "Give morphine 10 mg IV, one dose.", STRANGER);
    await rt.settled();
    await sayAs(rt, "Confirm.", STRANGER);
    await rt.settled();
    expect(port.writes.some((w) => w.kind === "prescribe")).toBe(false);
    expect(rt.view(a.task_id)!.transcript.every((l) => l.speaker?.speaker === "unverified")).toBe(true);
    await rt.stop();
  });
});

describe("sign everything said the way clinicians say it (acceptance rehearsal, 30 Oct)", () => {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
  it("takes the natural forms and leaves other talk with sign in it alone", async () => {
    const { SIGN_EVERYTHING: rule } = await import("../src/emr/runtime.js");
    for (const yes of ["Let me sign everything for her.", "Sign that one too.", "I'll sign them all now", "Okay, sign everything", "so let's sign the orders for him", "Sign that one to"]) expect(rule.test(norm(yes)), yes).toBe(true);
    for (const no of ["she signed the consent", "sign her up for the clinic", "let me sign off the note later", "who will sign for the blood"]) expect(rule.test(norm(no)), no).toBe(false);
  });
});
