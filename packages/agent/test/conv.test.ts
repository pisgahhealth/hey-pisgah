import { describe, expect, it } from "vitest";
import { ORDER_REFERENCE_KINDS } from "../src/emr/gate.js";
import type { EmrContext, EmrTarget, Orderables, Provenance } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { ClerkFake, DOC, PAT, VISIT, clerkBoot, ins, type W } from "./clerking-helpers.js";

// Lane CONV: the conversation fixes after the ACC2 review, each red before its fix.
const TOKEN = (n: number) => `v1.${String(1_761_700_000_000 + n)}.${"A".repeat(43)}`;
const print = (n: number): Voiceprint => ({ vector: [n], ms: 20, model: "nemo_en_titanet_small" });
const OWNER = print(5), DRB = print(4);

// A doctor who orders, with a voice match (5 is the owner, 4 is Dr B) and two paracetamols the ear can mix up.
class ConvFake extends ClerkFake {
  private n = 0;
  override kindsFor(): readonly string[] { return [...ORDER_REFERENCE_KINDS]; }
  orderables(): Orderables {
    return { tests: {}, drugs: { paracetamol_iv: { words: ["IV paracetamol", "paracetamol IV"], controlled: false }, paracetamol_oral: { words: ["paracetamol tablets", "oral paracetamol"], controlled: false } } };
  }
  readonly speaker = async (_o: string, v: readonly number[], _p: Provenance): Promise<SpeakerVerdict> => {
    this.n += 1;
    return v[0] === 5 ? { speaker: "owner", token: TOKEN(this.n) } : v[0] === 4 ? { speaker: "other_clinician", label: "Dr B", role: "doctor" } as SpeakerVerdict : { speaker: "unverified", reason: "no_match" };
  };
  override async resolve(target: EmrTarget): Promise<EmrContext> {
    if (target.patient_id === PAT) return { admission_id: "", patient_id: PAT, visit_id: VISIT, label: "Emeka Obi", facts: { ward: null, bed: null }, keywords: [] };
    return super.resolve(target);
  }
}

function boot(script: (said: string) => W[]) {
  const port = new ConvFake();
  return { ...clerkBoot(script, { port }), port };
}
type Rt = ReturnType<typeof boot>["rt"];
const say = (rt: Rt, text: string, v: Voiceprint | null = OWNER, o: { task?: string; question_id?: string; typed?: boolean } = {}) =>
  rt.say({ owner: DOC, target: { patient_id: PAT }, text, source: o.typed ? "text" : "audio", ...(v ? { voiceprint: v } : {}), ...(o.question_id ? { question_id: o.question_id } : {}) }, o.task);
const rx = (port: ConvFake) => port.writes.filter((w) => w.kind === "prescribe");

// Pass 10b's A10: the ear wrote "IV pay rasitamol", so the gate guessed the IV paracetamol and the medicine is asked, never guessed.
const ASIDE: W[] = [{ class: "aside", confidence: 0.9 }];
const A10 = "Give her IV pay rasitamol, one gram, eight hourly, for one day. That's three doses";
const gate = (s: string): W[] => {
  if (/pay rasitamol/.test(s)) return [ins("prescribe", { drug: "paracetamol_iv", dose: "1 g" })];
  if (/^Oral paracetamol 500 mg/.test(s)) return [ins("prescribe", { drug: "paracetamol_oral", dose: "500 mg", route: "oral" })];
  if (/paracetamol tablets/.test(s)) return [ins("prescribe", { drug: "paracetamol_oral", dose: "500 mg", route: "oral" })];
  if (/IV paracetamol/.test(s)) return [ins("prescribe", { drug: "paracetamol_iv" })];
  return ASIDE;
};

describe("CONV 0: the answer to which medicine is the owner's own request, through resumeWork", () => {
  it("holds an order a typed reply to which medicine finishes, and never sends it on the earlier line's voice", async () => {
    const { rt, port } = boot(gate);
    const a = await say(rt, A10);
    await rt.settled();
    const q = rt.view(a.task_id)!.questions.at(-1)!;
    expect(q.text).toMatch(/Which medicine should I prescribe/);
    await say(rt, "IV paracetamol.", null, { task: a.task_id, question_id: q.question_id, typed: true });
    await rt.settled();
    expect(rx(port)).toHaveLength(0);
    expect(rt.view(a.task_id)!.actions.find((x) => x.kind === "prescribe")).toMatchObject({ state: "proposed", awaiting: "owner_voice" });
    await rt.stop();
  });

  it("writes the dose and route the answer said, over the held line's", async () => {
    const { rt, port } = boot(gate);
    const a = await say(rt, A10);
    await rt.settled();
    const b = await say(rt, "Oral paracetamol 500 mg.");
    await rt.settled();
    expect(rx(port)).toHaveLength(1);
    expect(rx(port)[0]!.args).toMatchObject({ drug: "paracetamol_oral", dose: "500 mg", route: "oral" });
    expect(rx(port)[0]!.prov.voice?.authorisation).toContain(`transcript:${b.line_id}~`);
    const v = rt.view(a.task_id)!;
    expect(v.questions.filter((x) => /Which medicine/.test(x.text))).toEqual([]);
    await rt.stop();
  });

  it("writes a later take-home line as its own order while which medicine is still open", async () => {
    const { rt, port } = boot(gate);
    const a = await say(rt, A10);
    await rt.settled();
    // The acceptance script's A19 as the cleaned transcript reads it, said while A10's question is still open.
    const home = await say(rt, "Actually, give her oral paracetamol tablets to take home, 500 milligrams, three times a day for three days, quantity nine.");
    await rt.settled();
    expect(rx(port)).toHaveLength(1);
    expect(rx(port)[0]!.args).toMatchObject({ drug: "paracetamol_oral", dose: "500 mg", frequency: 3, duration_days: 3, quantity: 9, route: "oral" });
    expect(rt.view(a.task_id)!.actions.find((x) => x.kind === "prescribe")!.line_id).toBe(home.line_id);
    await rt.stop();
  });

  it("never finishes a question raised on Dr B's line with the owner's bare count", async () => {
    const { rt, port } = boot((s) => (/^IV paracetamol one gram/.test(s) ? [ins("prescribe", { drug: "paracetamol_iv", dose: "1 g" })] : ASIDE));
    const a = await say(rt, "IV paracetamol one gram.", DRB);
    await rt.settled();
    expect(rt.view(a.task_id)!.questions.some((q) => /How many/.test(q.text))).toBe(true);
    await say(rt, "Three.", OWNER, { task: a.task_id });
    await rt.settled();
    expect(rx(port)).toHaveLength(0);
    await rt.stop();
  });

  it("writes the quantity follow-up once after which medicine is answered", async () => {
    const { rt, port } = boot((s) => (/pay rasitamol/.test(s) ? [ins("prescribe", { drug: "paracetamol_iv", dose: "1 g" })] : /IV paracetamol/.test(s) ? [ins("prescribe", { drug: "paracetamol_iv" })] : ASIDE));
    const a = await say(rt, "Give her IV pay rasitamol, one gram, eight hourly.");
    await rt.settled();
    await say(rt, "IV paracetamol.", OWNER, { task: a.task_id });
    await rt.settled();
    expect(rx(port)).toHaveLength(0);
    expect(rt.view(a.task_id)!.questions.at(-1)!.text).toMatch(/How many should the pharmacy give for IV paracetamol/);
    await say(rt, "Three.", OWNER, { task: a.task_id });
    await rt.settled();
    await say(rt, "Three.", OWNER, { task: a.task_id });
    await rt.settled();
    expect(rx(port).map((w) => w.args)).toEqual([{ visit_id: VISIT, patient_id: PAT, drug: "paracetamol_iv", dose: "1 g", frequency: 3, quantity: 3, route: "iv" }]);
    await rt.stop();
  });
});
