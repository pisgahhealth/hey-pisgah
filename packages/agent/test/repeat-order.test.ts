import { describe, expect, it } from "vitest";
import { ORDER_REFERENCE_KINDS } from "../src/emr/gate.js";
import type { EmrContext, EmrTarget, Orderables, Provenance } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { ClerkFake, PAT, VISIT, DOC, clerkBoot, ins } from "./clerking-helpers.js";

const PAT2 = "aaaaaaaa-2222-4222-8333-444444444444";
const VISIT2 = "bbbbbbbb-2222-4222-8333-444444444444";
const TOKEN = (n: number) => `v2.${String(1_761_700_000_000 + n)}.${"B".repeat(22)}.${"A".repeat(43)}`;
const print = (who: string): Voiceprint => ({ vector: [who.length], ms: 20, model: "nemo_en_titanet_small" });
const OWNER_VOICE = print("owner"), STRANGER = print("x");

// The clerking hospital with voice orders for two patients; the owner's voiceprint is matched and every other one is not.
class RepeatFake extends ClerkFake {
  private n = 0;
  override kindsFor(): readonly string[] { return [...ORDER_REFERENCE_KINDS]; }
  orderables(): Orderables { return { tests: { fbc: ["full blood count", "FBC"], malaria: ["malaria test"] }, drugs: { paracetamol_oral: { words: ["paracetamol"], controlled: false }, amoxicillin: { words: ["amoxicillin"], controlled: false }, morphine: { words: ["morphine"], controlled: true } } }; }
  override async resolve(target: EmrTarget): Promise<EmrContext> {
    if (target.patient_id === PAT2) return { admission_id: "", patient_id: PAT2, visit_id: VISIT2, label: "Second Patient", facts: { ward: null, bed: null }, keywords: [] };
    return super.resolve(target);
  }
  readonly speaker = async (_owner: string, v: readonly number[], _prov: Provenance): Promise<SpeakerVerdict> => {
    this.n += 1;
    return v[0] === 5 ? { speaker: "owner", token: TOKEN(this.n) } : { speaker: "unverified", reason: "no_match" };
  };
}

const gate = (s: string) => {
  if (/blood count/i.test(s)) return [ins("order_test", { test: "fbc" })];
  if (/malaria/i.test(s)) return [ins("order_test", { test: "malaria" })];
  const dose = /(\d+ ?(?:mg|g))/i.exec(s)?.[1];
  if (/paracetamol/i.test(s)) return [ins("prescribe", { drug: "paracetamol_oral", ...(dose ? { dose } : {}) })];
  if (/amoxicillin/i.test(s)) return [ins("prescribe", { drug: "amoxicillin", ...(dose ? { dose } : {}) })];
  if (/morphine/i.test(s)) return [ins("prescribe", { drug: "morphine", ...(dose ? { dose } : {}) })];
  return [];
};

function boot() {
  const port = new RepeatFake();
  return { ...clerkBoot(gate, { port }), port };
}
type Rt = ReturnType<typeof boot>["rt"];
const say = (rt: Rt, text: string, voiceprint: Voiceprint = OWNER_VOICE, patient = PAT) => rt.say({ owner: DOC, target: { patient_id: patient }, text, source: "audio", voiceprint });
const writes = (port: RepeatFake, kind: string) => port.writes.filter((w) => w.kind === kind);
const HELD = /Already ordered at \d{2}:\d{2}\. Order again\?/;

describe("D35: a repeated instruction is held, a deliberate repeat is a new order", () => {
  it("holds the same test said twice for the same patient and visit with the time it was ordered, and sends nothing more", async () => {
    const { rt, port } = boot();
    await say(rt, "Send a full blood count.");
    await rt.settled();
    const b = await say(rt, "Send a full blood count.");
    await rt.settled();
    expect(writes(port, "order_test")).toHaveLength(1);
    const v = rt.view(b.task_id)!;
    expect(v.questions.at(-1)!.text).toMatch(HELD);
    expect(v.actions.filter((a) => a.kind === "order_test").map((a) => a.state)).toEqual(["completed", "proposed"]);
    await rt.stop();
  });

  it("releases exactly one order on the owner's matched yes, never on another voice's yes, and a later yes releases nothing", async () => {
    const { rt, port } = boot();
    await say(rt, "Send a full blood count.");
    await rt.settled();
    await say(rt, "Send a full blood count.");
    await rt.settled();
    await say(rt, "Yes.", STRANGER);
    await rt.settled();
    expect(writes(port, "order_test")).toHaveLength(1);
    const yes = await say(rt, "Yes.");
    await rt.settled();
    expect(writes(port, "order_test")).toHaveLength(2);
    // The second order is the repeated line's own, authorised by that line and released by the yes.
    expect(writes(port, "order_test")[1]!.prov.evidence).not.toBe(`transcript:${yes.line_id}`);
    await say(rt, "Yes.");
    await rt.settled();
    expect(writes(port, "order_test")).toHaveLength(2);
    await rt.stop();
  });

  it("cancels the held repeat on the owner's no", async () => {
    const { rt, port } = boot();
    await say(rt, "Send a full blood count.");
    await rt.settled();
    const b = await say(rt, "Send a full blood count.");
    await rt.settled();
    await say(rt, "No.");
    await rt.settled();
    expect(writes(port, "order_test")).toHaveLength(1);
    expect(rt.view(b.task_id)!.actions.filter((a) => a.kind === "order_test").map((a) => a.state)).toEqual(["completed", "cancelled"]);
    await rt.stop();
  });

  it("holds the same medicine at the same dose and route, and sends a differing dose as a new order", async () => {
    const { rt, port } = boot();
    await say(rt, "Give paracetamol 500 mg by mouth, two tablets.");
    await rt.settled();
    const same = await say(rt, "Give paracetamol 500 mg by mouth, two tablets.");
    await rt.settled();
    expect(writes(port, "prescribe")).toHaveLength(1);
    expect(rt.view(same.task_id)!.questions.at(-1)!.text).toMatch(HELD);
    await say(rt, "Give paracetamol 1 g by mouth, two tablets.");
    await rt.settled();
    expect(writes(port, "prescribe")).toHaveLength(2);
    expect(writes(port, "prescribe")[1]!.args["dose"]).toBe("1 g");
    await rt.stop();
  });

  it("sends a repeat that says another or again as a new order", async () => {
    const { rt, port } = boot();
    await say(rt, "Send a full blood count.");
    await rt.settled();
    await say(rt, "Send another full blood count.");
    await rt.settled();
    await say(rt, "Send the full blood count again.");
    await rt.settled();
    expect(writes(port, "order_test")).toHaveLength(3);
    await rt.stop();
  });

  it("negative controls: a different drug is not held, and the same drug for the other patient is not held", async () => {
    const { rt, port } = boot();
    await say(rt, "Give paracetamol 500 mg by mouth, two tablets.");
    await rt.settled();
    const other = await say(rt, "Give amoxicillin 500 mg by mouth, two tablets.");
    await rt.settled();
    expect(writes(port, "prescribe")).toHaveLength(2);
    expect(rt.view(other.task_id)!.questions.filter((q) => HELD.test(q.text))).toHaveLength(0);
    const p2 = await say(rt, "Give paracetamol 500 mg by mouth, two tablets.", OWNER_VOICE, PAT2);
    await rt.settled();
    expect(writes(port, "prescribe")).toHaveLength(3);
    expect(writes(port, "prescribe")[2]!.args).toMatchObject({ patient_id: PAT2, visit_id: VISIT2 });
    expect(rt.view(p2.task_id)!.questions.filter((q) => HELD.test(q.text))).toHaveLength(0);
    await rt.stop();
  });

  it("does not count an order the owner declined, so saying it again is not held", async () => {
    const { rt, port } = boot();
    await say(rt, "Give morphine 5 mg IV, one dose.");
    await rt.settled();
    await say(rt, "No.");
    await rt.settled();
    const again = await say(rt, "Give morphine 5 mg IV, one dose.");
    await rt.settled();
    const v = rt.view(again.task_id)!;
    expect(v.questions.at(-1)!.text).toMatch(/controlled drug: say confirm/);
    expect(v.questions.filter((q) => HELD.test(q.text))).toHaveLength(0);
    expect(writes(port, "prescribe")).toHaveLength(0);
    await rt.stop();
  });

  it("a repeat the gate is unsure of is asked as the repeat with the bound yes, and a first order it is unsure of is still asked as before", async () => {
    const port = new RepeatFake();
    let n = 0;
    const { rt } = clerkBoot((s) => (/blood count/i.test(s) ? [ins("order_test", { test: "fbc", confidence: (n += 1) === 1 ? 0.95 : 0.3 })] : /malaria/i.test(s) ? [ins("order_test", { test: "malaria", confidence: 0.3 })] : []), { port });
    await say(rt, "Send a full blood count.");
    await rt.settled();
    const b = await say(rt, "Send a full blood count.");
    await rt.settled();
    expect(rt.view(b.task_id)!.questions.at(-1)!.text).toMatch(HELD);
    await say(rt, "Yes.");
    await rt.settled();
    expect(writes(port, "order_test")).toHaveLength(2);
    // Negative control: an unsure first order is still the chart question, and nothing is sent.
    const m = await say(rt, "Send a malaria test.");
    await rt.settled();
    expect(rt.view(m.task_id)!.questions.at(-1)!.text).toMatch(/Did you want me to chart this/);
    expect(writes(port, "order_test")).toHaveLength(2);
    await rt.stop();
  });

  it("a repeated controlled drug asks about the repeat first and still needs its own confirm after the yes", async () => {
    const { rt, port } = boot();
    await say(rt, "Give morphine 5 mg IV, one dose.");
    await rt.settled();
    await say(rt, "Confirm.");
    await rt.settled();
    expect(writes(port, "prescribe")).toHaveLength(1);
    const b = await say(rt, "Give morphine 5 mg IV, one dose.");
    await rt.settled();
    expect(rt.view(b.task_id)!.questions.at(-1)!.text).toMatch(HELD);
    await say(rt, "Yes.");
    await rt.settled();
    expect(writes(port, "prescribe")).toHaveLength(1);
    expect(rt.view(b.task_id)!.questions.at(-1)!.text).toMatch(/controlled drug: say confirm/);
    const c = await say(rt, "Confirm.");
    await rt.settled();
    const rx = writes(port, "prescribe");
    expect(rx).toHaveLength(2);
    expect(rx[1]!.prov.voice?.confirmation).toContain(`transcript:${c.line_id}~`);
    await rt.stop();
  });
});
