import { describe, expect, it } from "vitest";
import { ORDER_REFERENCE_KINDS } from "../src/emr/gate.js";
import type { EmrContext, EmrTarget, Orderables, Provenance } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { naturalYes, noteKind, patientNames } from "../src/emr/runtime.js";
import { otherPatientsNamed } from "../src/emr/entry.js";
import { prescriptionSaid } from "../src/emr/work.js";
import { ADMIT, ClerkFake, DOC, PAT, VISIT, clerkBoot, ins, type W } from "./clerking-helpers.js";

// Lane RT: the runtime fixes from the 31 Oct read-only review, each red on b27d297 and green here.
const TOKEN = (n: number) => `v1.${String(1_761_700_000_000 + n)}.${"A".repeat(43)}`;
const print = (n: number): Voiceprint => ({ vector: [n], ms: 20, model: "nemo_en_titanet_small" });
const OWNER = print(5), DRB = print(4), STRANGER = print(1);
const PAT_B = "dddddddd-1111-4222-8333-444444444444", VISIT_B = "eeeeeeee-1111-4222-8333-444444444444";

// A doctor who orders, with a voice match: 5 is the owner, 4 is Dr B, anyone else is unverified; two patients, Emeka and Blessing.
class RtFake extends ClerkFake {
  private n = 0;
  override kindsFor(): readonly string[] { return [...ORDER_REFERENCE_KINDS]; }
  orderables(): Orderables { return { tests: { fbc: ["full blood count", "FBC"] }, drugs: { paracetamol_iv: { words: ["paracetamol"], controlled: false }, morphine: { words: ["morphine"], controlled: true } } }; }
  readonly speaker = async (_o: string, v: readonly number[], _p: Provenance): Promise<SpeakerVerdict> => {
    this.n += 1;
    return v[0] === 5 ? { speaker: "owner", token: TOKEN(this.n) } : v[0] === 4 ? { speaker: "other_clinician", label: "Dr B", role: "doctor" } as SpeakerVerdict : { speaker: "unverified", reason: "no_match" };
  };
  override async resolve(target: EmrTarget): Promise<EmrContext> {
    if (target.patient_id === PAT_B) return { admission_id: "", patient_id: PAT_B, visit_id: VISIT_B, label: "Blessing Okon", facts: { ward: null, bed: null }, keywords: [] };
    if (target.patient_id === PAT && !this.admitted) return { admission_id: "", patient_id: PAT, visit_id: VISIT, label: "Emeka Obi", facts: { ward: null, bed: null }, keywords: [] };
    return super.resolve(target);
  }
}

function boot(script: (said: string) => W[], o: { confirmWindowMs?: number } = {}) {
  const port = new RtFake();
  const b = clerkBoot(script, { port });
  if (o.confirmWindowMs !== undefined) (b.rt as unknown as { o: { confirmWindowMs?: number } }).o.confirmWindowMs = o.confirmWindowMs;
  return { ...b, port };
}
type Rt = ReturnType<typeof boot>["rt"];
const say = (rt: Rt, text: string, v: Voiceprint | null = OWNER, o: { task?: string; patient?: string; spoken_at?: string; question_id?: string } = {}) =>
  rt.say({ owner: DOC, target: { patient_id: o.patient ?? PAT }, text, source: "audio", ...(v ? { voiceprint: v } : {}), ...(o.spoken_at ? { spoken_at: o.spoken_at } : {}), ...(o.question_id ? { question_id: o.question_id } : {}) }, o.task);
const of = (port: RtFake, kind: string) => port.writes.filter((w) => w.kind === kind);
const later = (ms: number) => new Date(Date.now() + ms).toISOString();

// The gate as the ward would hear it: the paracetamol line names the drug and dose, the morphine line is a controlled drug, the FBC is a test.
const ASIDE: W[] = [{ class: "aside", confidence: 0.9 }];
const ward = (s: string): W[] => {
  if (/morphine 5 mg/i.test(s)) return [ins("prescribe", { drug: "morphine", dose: "5 mg" })];
  if (/paracetamol/i.test(s)) return [ins("prescribe", { drug: "paracetamol_iv", dose: "1 g" })];
  if (/full blood count|\bFBC\b/i.test(s)) return [ins("order_test", { test: "fbc" })];
  if (/^Send a test\.?$/i.test(s)) return [ins("order_test", {})];
  if (/sats/i.test(s)) return [ins("record_observation", { spo2: 96, resp_rate: 22 })];
  if (/temperature/i.test(s)) return [ins("record_observation", { temp_c: "38.9" })];
  return ASIDE;
};

describe("RT 1: every note reaches the owner with its kind", () => {
  it("lists refusals, holds and questions in one list, newest last, each with a kind and a question's resolved_at", async () => {
    const { rt } = boot((s) => (/blood bank/.test(s) ? [ins("call_blood_bank", { asked_for: "call the blood bank" })] : /^Send a test/.test(s) ? [ins("order_test", {})] : ASIDE));
    const a = await say(rt, "Call the blood bank for two units.");
    await rt.settled();
    await say(rt, "Send a test.", OWNER, { task: a.task_id });
    await rt.settled();
    const v = rt.view(a.task_id)!;
    expect(v.notes.map((n) => n.kind)).toEqual(["refusal", "question"]);
    expect(v.notes[0]!.text).toMatch(/^Not mine to do, left for you: call the blood bank/);
    expect(v.notes[1]).toMatchObject({ id: v.questions[0]!.question_id, kind: "question" });
    expect(v.notes[1]!.resolved_at).toBeUndefined();
    expect(v.notes.every((n, i) => i === 0 || v.notes[i - 1]!.at <= n.at)).toBe(true);
    await rt.stop();
  });

  it("reads each kind of note the runtime writes from its words, for notes journaled before kinds were stored", () => {
    expect(noteKind("Held until the patient is admitted: Add to the care plan. I will do it then without being asked again.")).toBe("hold");
    expect(noteKind("No malaria test sent here is waiting for a result, so this waits until one is sent: telling you.")).toBe("hold");
    expect(noteKind("Prescribe paracetamol: the hospital's answer was lost, so it may be saved.")).toBe("hold");
    expect(noteKind("I could not match that voice to you, so nothing was signed or sent. Say it yourself.")).toBe("refusal");
    expect(noteKind("Dr B said that, so I did not act on it. Say it yourself.")).toBe("refusal");
    expect(noteKind("Left out values you did not say: pulse 120.")).toBe("refusal");
    expect(noteKind("The malaria result is back in the record, as you asked to be told.")).toBe("info");
    expect(noteKind("Review due now: review his abdomen.")).toBe("info");
  });
});

describe("RT 2 and 8: a request asked about is finished by the answer, never re-asked in a loop", () => {
  it("'paracetamol one gram' then 'eight hourly, three doses' completes one prescription", async () => {
    const { rt, port } = boot((s) => (/^Paracetamol/.test(s) ? ward(s) : ASIDE));
    const a = await say(rt, "Paracetamol one gram.");
    await rt.settled();
    expect(rt.view(a.task_id)!.questions).toEqual([expect.objectContaining({ text: expect.stringMatching(/^How many should the pharmacy give for paracetamol/) })]);
    await say(rt, "Eight hourly, three doses.", OWNER, { task: a.task_id });
    await rt.settled();
    expect(of(port, "prescribe")).toHaveLength(1);
    expect(of(port, "prescribe")[0]!.args).toEqual({ visit_id: VISIT, patient_id: PAT, drug: "paracetamol_iv", dose: "1 g", frequency: 3, quantity: 3 });
    expect(rt.view(a.task_id)!.questions).toEqual([]);
    await rt.stop();
  });

  it("'eight hourly' alone keeps the same question open with the frequency carried, and 'three' then finishes it", async () => {
    const { rt, port } = boot((s) => (/^Paracetamol/.test(s) ? ward(s) : /hourly/.test(s) ? [ins("prescribe", {})] : ASIDE));
    const a = await say(rt, "Paracetamol one gram.");
    await rt.settled();
    const q1 = rt.view(a.task_id)!.questions[0]!.question_id;
    await say(rt, "Eight hourly.", OWNER, { task: a.task_id });
    await rt.settled();
    // The same question, not a new one and not "which medicine": the drug, dose and frequency are kept.
    expect(rt.view(a.task_id)!.questions.map((q) => q.question_id)).toEqual([q1]);
    expect(rt.view(a.task_id)!.asked).toHaveLength(1);
    await say(rt, "Three.", OWNER, { task: a.task_id });
    await rt.settled();
    expect(of(port, "prescribe").map((w) => w.args)).toEqual([{ visit_id: VISIT, patient_id: PAT, drug: "paracetamol_iv", dose: "1 g", frequency: 3, quantity: 3 }]);
    await rt.stop();
  });

  it("another clinician's line never answers the owner's question, and the owner's own answer still finishes it", async () => {
    const { rt, port } = boot((s) => (/paracetamol/i.test(s) ? ward(s) : ASIDE));
    const a = await say(rt, "Paracetamol one gram.");
    await rt.settled();
    await say(rt, "Paracetamol, three doses.", DRB, { task: a.task_id });
    await rt.settled();
    expect(of(port, "prescribe")).toHaveLength(0);
    expect(rt.view(a.task_id)!.questions.some((q) => /^How many should the pharmacy give for paracetamol/.test(q.text))).toBe(true);
    await say(rt, "Three doses.", OWNER, { task: a.task_id });
    await rt.settled();
    expect(of(port, "prescribe").map((w) => w.args)).toEqual([{ visit_id: VISIT, patient_id: PAT, drug: "paracetamol_iv", dose: "1 g", quantity: 3 }]);
    await rt.stop();
  });

  it("negative control: a long new instruction for another medicine is a new request, not the answer", async () => {
    const { rt, port } = boot((s) => (/^Paracetamol/.test(s) ? ward(s) : /^Give him morphine/.test(s) ? [ins("prescribe", { drug: "morphine", dose: "5 mg" })] : ASIDE));
    const a = await say(rt, "Paracetamol one gram.");
    await rt.settled();
    await say(rt, "Give him morphine 5 mg IV stat, just the one dose please.", OWNER, { task: a.task_id });
    await rt.settled();
    const v = rt.view(a.task_id)!;
    expect(v.questions.some((q) => /paracetamol/.test(q.text))).toBe(true);
    expect(v.actions.find((x) => x.kind === "prescribe")!.args).toMatchObject({ drug: "morphine" });
    expect(of(port, "prescribe")).toHaveLength(0);
    await rt.stop();
  });
});

describe("RT 3: an instruction closes only the question it answers", () => {
  it("with two questions open, the answer to one closes it and the other stays open and shown", async () => {
    const { rt, port } = boot((s) => (/^Send a test/.test(s) ? [ins("order_test", {})] : /^Paracetamol/.test(s) ? ward(s) : /full blood count/i.test(s) ? ward(s) : ASIDE));
    const a = await say(rt, "Send a test.");
    await rt.settled();
    await say(rt, "Paracetamol one gram.", OWNER, { task: a.task_id });
    await rt.settled();
    expect(rt.view(a.task_id)!.questions).toHaveLength(2);
    await say(rt, "A full blood count.", OWNER, { task: a.task_id });
    await rt.settled();
    const v = rt.view(a.task_id)!;
    expect(of(port, "order_test")).toHaveLength(1);
    expect(v.questions.map((q) => q.text)).toEqual([expect.stringMatching(/^How many should the pharmacy give for paracetamol/)]);
    const shown = v.notes.filter((n) => n.kind === "question");
    expect(shown.map((n) => !!n.resolved_at)).toEqual([true, false]);
    await rt.stop();
  });

  it("an answer posted with a question id closes only that question, though another was asked after it", async () => {
    const { rt, port } = boot((s) => (/^Send a test/.test(s) ? [ins("order_test", {})] : /^Paracetamol/.test(s) ? ward(s) : ASIDE));
    const a = await say(rt, "Send a test.");
    await rt.settled();
    await say(rt, "Paracetamol one gram.", OWNER, { task: a.task_id });
    await rt.settled();
    const [testQ, rxQ] = rt.view(a.task_id)!.questions;
    // The typed answer names the paracetamol question; the test question stays open.
    await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Three doses.", question_id: rxQ!.question_id }, a.task_id);
    await rt.settled();
    expect(of(port, "prescribe")).toHaveLength(0);
    // The test question stays open; the paracetamol question closed, and its prescription is held for the owner's voice, since the typed line had none to match.
    const left = rt.view(a.task_id)!.questions;
    expect(left.map((q) => q.question_id)).toContain(testQ!.question_id);
    expect(left.map((q) => q.question_id)).not.toContain(rxQ!.question_id);
    expect(left.filter((q) => q.question_id !== testQ!.question_id).map((q) => q.text)).toEqual([expect.stringMatching(/^Held: Prescribe paracetamol iv 1 g, quantity 3/)]);
    expect(rt.view(a.task_id)!.actions.find((x) => x.kind === "prescribe")).toMatchObject({ state: "proposed", awaiting: "owner_voice", args: { quantity: 3, dose: "1 g" } });
    await rt.stop();
  });
});

describe("RT 8: an answer is bound to its question by id", () => {
  const script = (s: string): W[] => (/^Send a test/.test(s) ? [ins("order_test", {})] : /^Paracetamol/.test(s) ? ward(s) : ASIDE);
  async function asked() {
    const b = boot(script);
    const a = await say(b.rt, "Send a test.");
    await b.rt.settled();
    await say(b.rt, "Paracetamol one gram.", OWNER, { task: a.task_id });
    await b.rt.settled();
    const [testQ, rxQ] = b.rt.view(a.task_id)!.questions;
    return { ...b, a, testQ: testQ!, rxQ: rxQ! };
  }

  it("a typed answer posted with the earlier question's id answers that question, not the one shown last", async () => {
    const { rt, a, testQ, rxQ } = await asked();
    await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Full blood count.", question_id: testQ.question_id }, a.task_id);
    await rt.settled();
    const v = rt.view(a.task_id)!;
    expect(v.actions.find((x) => x.kind === "order_test")).toMatchObject({ args: { test: "fbc" } });
    expect(v.questions.map((q) => q.question_id)).toContain(rxQ.question_id);
    expect(v.questions.map((q) => q.question_id)).not.toContain(testQ.question_id);
    await rt.stop();
  });

  it("negative control: the same words with no id go to the question shown last, and no test is ordered", async () => {
    const { rt, a, rxQ } = await asked();
    await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Full blood count." }, a.task_id);
    await rt.settled();
    const v = rt.view(a.task_id)!;
    expect(v.actions.find((x) => x.kind === "order_test")).toBeUndefined();
    expect(v.questions.map((q) => q.question_id)).toContain(rxQ.question_id);
    await rt.stop();
  });
});

describe("RT 4: a controlled-drug, death, leave-against-advice or discharge confirm is bound to its read-back", () => {
  const morphine = async (rt: Rt) => { const a = await say(rt, "Give him morphine 5 mg IV, one dose."); await rt.settled(); return a; };

  it("accepts the owner's six-word confirm naming the morphine, with that line as confirmation", async () => {
    const { rt, port } = boot(ward);
    const a = await morphine(rt);
    expect(rt.view(a.task_id)!.questions.at(-1)!.text).toMatch(/controlled drug: say confirm to send it\. Ref #1\.$/);
    const c = await say(rt, "Yes, confirm the morphine five milligrams.", OWNER, { task: a.task_id });
    await rt.settled();
    expect(of(port, "prescribe")).toHaveLength(1);
    expect(of(port, "prescribe")[0]!.prov.voice?.confirmation).toContain(`transcript:${c.line_id}~`);
    await rt.stop();
  });

  it("accepts 'yes, go ahead with the morphine' and refuses 'yeah, go on'", async () => {
    expect(naturalYes("yes go ahead with the morphine".split(" "), ["morphine"])).toBe(true);
    expect(naturalYes("yeah go on".split(" "), ["morphine"])).toBe(false);
    expect(naturalYes("yes but not the morphine".split(" "), ["morphine"])).toBe(false);
    expect(naturalYes("yes and send a full blood count".split(" "), ["morphine"])).toBe(false);
    // REC's repeated-order question ("Order again?") is a confirm too, and takes the same natural yes.
    expect(naturalYes("yes order it again".split(" "), ["full", "blood", "count"])).toBe(true);
    expect(naturalYes("yes send the full blood count again".split(" "), ["full", "blood", "count"])).toBe(true);
    const { rt, port } = boot(ward);
    const a = await morphine(rt);
    await say(rt, "Yes, go ahead with the morphine.", OWNER, { task: a.task_id });
    await rt.settled();
    expect(of(port, "prescribe")).toHaveLength(1);
    await rt.stop();
  });

  it("refuses another speaker's yes and an unmatched voice's yes, and the owner's own yes still confirms", async () => {
    const { rt, port } = boot(ward);
    const a = await morphine(rt);
    await say(rt, "Yes, confirm the morphine.", DRB, { task: a.task_id });
    await say(rt, "Yes.", STRANGER, { task: a.task_id });
    await rt.settled();
    expect(of(port, "prescribe")).toHaveLength(0);
    expect(rt.view(a.task_id)!.notes.filter((n) => n.kind === "refusal").map((n) => n.text)).toEqual([
      "Dr B said that, so nothing was signed or sent. Say it yourself.", "I could not match that voice to you, so nothing was signed or sent. Say it yourself."
    ]);
    await say(rt, "Confirm.", OWNER, { task: a.task_id });
    await rt.settled();
    expect(of(port, "prescribe")).toHaveLength(1);
    await rt.stop();
  });

  it("refuses the owner's yes after the window, asks again with a fresh read-back, and takes the next yes inside it", async () => {
    const { rt, port } = boot(ward);
    const a = await morphine(rt);
    const q1 = rt.view(a.task_id)!.questions[0]!.question_id;
    await say(rt, "Yes, confirm the morphine.", OWNER, { task: a.task_id, spoken_at: later(61_000) });
    await rt.settled();
    expect(of(port, "prescribe")).toHaveLength(0);
    const v = rt.view(a.task_id)!;
    expect(v.notes.find((n) => n.kind === "refusal")!.text).toMatch(/^Not confirmed: that yes came more than 60 seconds after I asked about Prescribe morphine/);
    expect(v.questions).toHaveLength(1);
    expect(v.questions[0]!.question_id).not.toBe(q1);
    await say(rt, "Confirm.", OWNER, { task: a.task_id });
    await rt.settled();
    expect(of(port, "prescribe")).toHaveLength(1);
    await rt.stop();
  });

  it("takes its window from the options", async () => {
    const { rt, port } = boot(ward, { confirmWindowMs: 5_000 });
    const a = await morphine(rt);
    await say(rt, "Confirm the morphine.", OWNER, { task: a.task_id, spoken_at: later(6_000) });
    await rt.settled();
    expect(of(port, "prescribe")).toHaveLength(0);
    await rt.stop();
  });

  it("refuses a bare yes once another question is shown after the read-back, and takes the yes that names the morphine", async () => {
    const { rt, port } = boot(ward);
    const a = await morphine(rt);
    await say(rt, "Send a test.", OWNER, { task: a.task_id });
    await rt.settled();
    await say(rt, "Yes.", OWNER, { task: a.task_id });
    await rt.settled();
    expect(of(port, "prescribe")).toHaveLength(0);
    expect(rt.view(a.task_id)!.notes.some((n) => n.kind === "refusal" && /did not say which it was for/.test(n.text))).toBe(true);
    await say(rt, "Yes, the morphine.", OWNER, { task: a.task_id });
    await rt.settled();
    expect(of(port, "prescribe")).toHaveLength(1);
    await rt.stop();
  });

  it("a yes with no proposal waiting does nothing", async () => {
    const { rt, port } = boot(ward);
    const a = await say(rt, "Yes.");
    await rt.settled();
    const v = rt.view(a.task_id)!;
    expect(port.writes).toHaveLength(0);
    expect(v.actions).toHaveLength(0);
    expect(v.notes.filter((n) => n.kind === "refusal")).toHaveLength(0);
    await rt.stop();
  });
});

describe("RT 5: the other patient named without a switch phrase", () => {
  async function two() {
    const b = boot(ward);
    await b.rt.open(DOC, { patient_id: PAT_B });
    const e = await b.rt.open(DOC, { patient_id: PAT });
    return { ...b, emeka: e.task_id, blessing: b.rt.views(DOC).find((v) => v.patient_id === PAT_B)!.task_id };
  }

  it("holds 'For Blessing, send a full blood count' on Emeka's page with a question, and sends it for Blessing on her name", async () => {
    const { rt, port, emeka, blessing } = await two();
    await say(rt, "For Blessing, send a full blood count.");
    await rt.settled();
    expect(of(port, "order_test")).toHaveLength(0);
    expect(rt.view(emeka)!.actions).toHaveLength(0);
    expect(rt.view(emeka)!.questions).toEqual([{ question_id: expect.any(String), text: "For Emeka Obi or for Blessing Okon? I have not written it anywhere yet.", answers: ["Emeka Obi", "Blessing Okon"] }]);
    await say(rt, "Blessing.");
    await rt.settled();
    expect(of(port, "order_test").map((w) => w.args)).toEqual([{ visit_id: VISIT_B, patient_id: PAT_B, test: "fbc" }]);
    expect(rt.view(emeka)!.questions).toEqual([]);
    expect(rt.view(emeka)!.actions).toHaveLength(0);
    expect(rt.view(blessing)!.actions.map((x) => x.kind)).toEqual(["order_test"]);
    await rt.stop();
  });

  it("a line naming the patient in context proceeds on that patient", async () => {
    const { rt, port, emeka } = await two();
    await say(rt, "Emeka's full blood count, send it now.");
    await rt.settled();
    expect(of(port, "order_test").map((w) => w.args)).toEqual([{ visit_id: VISIT, patient_id: PAT, test: "fbc" }]);
    expect(rt.view(emeka)!.questions).toEqual([]);
    await rt.stop();
  });

  // Sandbox rt-proof-2: a task opened for a delegation carries its title as label, and "emergency" in it held an admission line.
  it("never reads a delegation task's title as a patient's name", () => {
    const handed = { entry: "delegation", label: "Register the emergency arrival", identities: [] };
    expect(patientNames(handed)).toEqual([]);
    expect(otherPatientsNamed("Admit him to A and E as an emergency, put him on a bed.", [{ labels: patientNames(handed) }], ["Unnamed arrival"])).toEqual([]);
    expect(otherPatientsNamed("Admit him to A and E as an emergency.", [{ labels: ["Register the emergency arrival"] }], ["Unnamed arrival"])).toHaveLength(1);
  });

  it("negative control: with no other patient open the line proceeds as before", async () => {
    const { rt, port } = boot(ward);
    await say(rt, "For Blessing, send a full blood count.");
    await rt.settled();
    expect(of(port, "order_test")).toHaveLength(1);
    await rt.stop();
  });
});

describe("RT 6: ward frequency words", () => {
  it("A10's line carries its frequency, and the Nigerian ward forms are read", () => {
    expect(prescriptionSaid("Give her IV paracetamol, one gram, eight hourly, for one day, that's three doses.", { dose: "1 g" })).toEqual({ dose: "1 g", frequency: 3, duration_days: 1, quantity: 3, route: "iv" });
    const f = (s: string) => prescriptionSaid(s, {}).frequency;
    expect([f("8 hourly"), f("twelve hourly"), f("12 hourly"), f("six hourly"), f("6-hourly"), f("once daily"), f("twice daily"), f("nocte"), f("stat")]).toEqual([3, 2, 2, 4, 4, 1, 2, 1, 1]);
    expect([f("tds"), f("bd"), f("qds"), f("od"), f("tid")]).toEqual([3, 2, 4, 1, 3]);
    expect(f("prn")).toBeNull();
  });

  it("the A10 line through the runtime writes a prescription with frequency 3", async () => {
    const { rt, port } = boot(ward);
    await say(rt, "Give her IV paracetamol, one gram, eight hourly, for one day, that's three doses.");
    await rt.settled();
    expect(of(port, "prescribe").map((w) => w.args)).toEqual([{ visit_id: VISIT, patient_id: PAT, drug: "paracetamol_iv", dose: "1 g", frequency: 3, duration_days: 1, quantity: 3, route: "iv" }]);
    await rt.stop();
  });
});

describe("RT 7: SpO2 after admission", () => {
  it("writes the sats said on an admitted patient and shows them in the read-back", async () => {
    const { rt, port } = boot(ward);
    port.admitted = true;
    const a = await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Sats 96 on room air, resp rate 22.", source: "audio", voiceprint: OWNER });
    await rt.settled();
    expect(of(port, "record_observation").map((w) => w.args)).toEqual([{ admission_id: ADMIT, spo2: 96, resp_rate: 22 }]);
    expect(rt.view(a.task_id)!.actions[0]!.summary).toBe("Record respiratory rate 22, oxygen saturation 96%");
    await rt.stop();
  });
});
