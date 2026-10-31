import { describe, expect, it } from "vitest";
import { ORDER_REFERENCE_KINDS } from "../src/emr/gate.js";
import type { Orderables, Provenance } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { ClerkFake, CLERK_KINDS, DOC, PAT, clerkBoot, ins, type W } from "./clerking-helpers.js";

// Lane LABE: the three conversation items CONV left open, each red before its fix.
const TOKEN = (n: number) => `v1.${String(1_761_700_000_000 + n)}.${"A".repeat(43)}`;
const print = (n: number): Voiceprint => ({ vector: [n], ms: 20, model: "nemo_en_titanet_small" });
const OWNER = print(5), DRB = print(4);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A doctor who orders and clerks, with a voice match where 5 is the owner and 4 is Dr B.
class LabeFake extends ClerkFake {
  private n = 0;
  override kindsFor(): readonly string[] { return [...new Set([...CLERK_KINDS, ...ORDER_REFERENCE_KINDS])]; }
  orderables(): Orderables {
    return { tests: { fbc: ["full blood count", "FBC"] }, drugs: { paracetamol_iv: { words: ["IV paracetamol", "paracetamol IV"], controlled: false }, paracetamol_oral: { words: ["paracetamol tablets", "oral paracetamol"], controlled: false }, morphine: { words: ["morphine"], controlled: true } } };
  }
  readonly speaker = async (_o: string, v: readonly number[], _p: Provenance): Promise<SpeakerVerdict> => {
    this.n += 1;
    return v[0] === 5 ? { speaker: "owner", token: TOKEN(this.n) } : v[0] === 4 ? { speaker: "other_clinician", label: "Dr B", role: "doctor" } as SpeakerVerdict : { speaker: "unverified", reason: "no_match" };
  };
}
const ASIDE: W[] = [{ class: "aside", confidence: 0.9 }];
function boot(script: (said: string) => W[]) {
  const port = new LabeFake();
  return { ...clerkBoot(script, { port }), port };
}
type B = ReturnType<typeof boot>;
const say = (b: B, text: string, o: { task?: string; question_id?: string; typed?: boolean; v?: Voiceprint | null; at?: number } = {}) =>
  b.rt.say({ owner: DOC, target: { patient_id: PAT }, text, source: o.typed ? "text" : "audio", ...(o.v === null || o.typed ? {} : { voiceprint: o.v ?? OWNER }), ...(o.question_id ? { question_id: o.question_id } : {}), spoken_at: new Date(o.at ?? b.clock.now).toISOString() }, o.task);
const of = (b: B, kind: string) => b.port.writes.filter((w) => w.kind === kind);
const notes = (b: B, task: string) => b.rt.view(task)!.notes.map((n) => n.text);
const open = (b: B, task: string) => b.rt.view(task)!.questions.map((q) => q.text);
const MIN = 60_000;

describe("LABE: an unanswered question closes after 30 minutes with a note", () => {
  const script = (s: string): W[] => (/^Chart the thing/.test(s) ? [{ class: "unclear", confidence: 0.9, words: s, question: "Which thing do you mean?" }] : /^IV paracetamol one gram/.test(s) ? [ins("prescribe", { drug: "paracetamol_iv", dose: "1 g" })] : ASIDE);

  it("closes a question nobody answered at 31 minutes, naming it", async () => {
    const b = boot(script);
    const a = await say(b, "Chart the thing.");
    await b.rt.settled();
    b.clock.now += 31 * MIN;
    await wait(120);
    await b.rt.settled();
    expect(open(b, a.task_id)).not.toContain("Which thing do you mean?");
    expect(notes(b, a.task_id)).toContain("No answer, so nothing was done: Which thing do you mean?");
    await b.rt.stop();
  });

  it("a tap bound to its question at 20 minutes still answers it and writes once", async () => {
    const b = boot(script);
    const a = await say(b, "IV paracetamol one gram.");
    await b.rt.settled();
    const q = b.rt.view(a.task_id)!.questions.at(-1)!;
    expect(q.text).toMatch(/How many/);
    b.clock.now += 20 * MIN;
    await wait(120);
    await say(b, "3", { task: a.task_id, question_id: q.question_id, typed: true });
    await b.rt.settled();
    expect(open(b, a.task_id).some((x) => /How many/.test(x))).toBe(false);
    expect(b.rt.view(a.task_id)!.actions.filter((x) => x.kind === "prescribe")).toMatchObject([{ state: "proposed", args: { quantity: 3 } }]);
    expect(notes(b, a.task_id).some((n) => n.startsWith("No answer"))).toBe(false);
    await b.rt.stop();
  });

  it("cancels the controlled order a lapsed confirm held, so a later yes sends nothing", async () => {
    const b = boot((s) => (/^Give morphine/.test(s) ? [ins("prescribe", { drug: "morphine", dose: "5 mg" })] : ASIDE));
    const a = await say(b, "Give morphine 5 mg IV, one dose.");
    await b.rt.settled();
    expect(b.rt.view(a.task_id)!.actions.find((x) => x.kind === "prescribe")).toMatchObject({ state: "proposed", awaiting: "confirm" });
    b.clock.now += 31 * MIN;
    await wait(120);
    await b.rt.settled();
    await say(b, "Yes, go ahead with the morphine.", { task: a.task_id });
    await b.rt.settled();
    expect(of(b, "prescribe")).toHaveLength(0);
    expect(b.rt.view(a.task_id)!.actions.find((x) => x.kind === "prescribe")!.state).toBe("cancelled");
    expect(notes(b, a.task_id).some((n) => n.startsWith("No answer, so nothing was done: ") && /morphine/i.test(n))).toBe(true);
    await b.rt.stop();
  });
});

describe("LABE: the floor question takes the owner's bare yes or no", () => {
  const LINE = "She is allergic to penicillin, severe.";
  const script = (s: string): W[] => (s === LINE ? [ins("record_allergy", { substance: "penicillin", severity: "severe", confidence: 0.3 })] : ASIDE);
  const ask = async (b: B) => {
    const a = await say(b, LINE);
    await b.rt.settled();
    const q = b.rt.view(a.task_id)!.questions.at(-1)!;
    expect(q.text).toMatch(/^Did you want me to chart this/);
    expect(of(b, "record_allergy")).toHaveLength(0);
    return { task: a.task_id, q };
  };

  it("yes charts the held line once", async () => {
    const b = boot(script);
    const { task } = await ask(b);
    await say(b, "Yes.", { task });
    await b.rt.settled();
    expect(of(b, "record_allergy")).toHaveLength(1);
    expect(of(b, "record_allergy")[0]!.args).toMatchObject({ substance: "penicillin", severity: "severe" });
    await b.rt.stop();
  });

  it("no drops the held line with a note", async () => {
    const b = boot(script);
    const { task, q } = await ask(b);
    await say(b, "No.", { task });
    await b.rt.settled();
    expect(of(b, "record_allergy")).toHaveLength(0);
    expect(open(b, task)).not.toContain(q.text);
    expect(notes(b, task)).toContain(`Left it unwritten, as you said: "${LINE}".`);
    await b.rt.stop();
  });

  it("okay writes nothing and leaves the question open", async () => {
    const b = boot(script);
    const { task, q } = await ask(b);
    await say(b, "Okay.", { task });
    await b.rt.settled();
    expect(of(b, "record_allergy")).toHaveLength(0);
    expect(open(b, task)).toContain(q.text);
    await b.rt.stop();
  });

  it("another voice's yes writes nothing", async () => {
    const b = boot(script);
    const { task } = await ask(b);
    await say(b, "Yes.", { task, v: DRB });
    await b.rt.settled();
    expect(of(b, "record_allergy")).toHaveLength(0);
    await b.rt.stop();
  });

  it("a bare yes is bound to the floor question only while it is the latest shown (D38)", async () => {
    const b = boot((s) => (s === LINE ? script(s) : /^Chart the thing/.test(s) ? [{ class: "unclear", confidence: 0.9, words: s, question: "Which thing do you mean?" }] : ASIDE));
    const { task } = await ask(b);
    await say(b, "Chart the thing.", { task });
    await b.rt.settled();
    await say(b, "Yes.", { task });
    await b.rt.settled();
    expect(of(b, "record_allergy")).toHaveLength(0);
    await b.rt.stop();
  });
});

describe("LABE: a restart in the middle of a two-field question", () => {
  it("asks which medicine, then how many; after a restart between the two, the count completes one write", async () => {
    const script = (s: string): W[] => (/pay rasitamol/.test(s) ? [ins("prescribe", { drug: "paracetamol_iv", dose: "1 g" })] : /^IV paracetamol/.test(s) ? [ins("prescribe", { drug: "paracetamol_iv" })] : ASIDE);
    const b = boot(script);
    const a = await say(b, "Give her IV pay rasitamol one gram eight hourly.");
    await b.rt.settled();
    const which = b.rt.view(a.task_id)!.questions.at(-1)!;
    expect(which.text).toMatch(/Which medicine/);
    await say(b, "IV paracetamol.", { task: a.task_id });
    await b.rt.settled();
    expect(b.rt.view(a.task_id)!.questions.at(-1)!.text).toMatch(/How many/);
    await b.rt.stop();
    // A process restart frees the model ledger; in one test process the first client has to let it go.
    b.client.close();
    const again = clerkBoot(script, { root: b.root, port: b.port, clock: b.clock });
    await again.rt.settled();
    await again.rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Three.", source: "audio", voiceprint: OWNER, spoken_at: new Date(b.clock.now).toISOString() }, a.task_id);
    await again.rt.settled();
    await wait(60);
    await again.rt.settled();
    expect(of(b, "prescribe")).toHaveLength(1);
    expect(of(b, "prescribe")[0]!.args).toMatchObject({ drug: "paracetamol_iv", quantity: 3, frequency: 3 });
    await again.rt.stop();
  });
});
