import { describe, expect, it } from "vitest";
import { EMERGENCY_KIND, IDENTITY_KIND, spelledName } from "../src/emr/entry.js";
import type { EmrCommit, EmrContext, EmrTarget, Provenance, WorkArgs } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import type { SecondEar } from "../src/emr/ears.js";
import { fromLine } from "../src/emr/runtime.js";
import { addressSwap, cleanNoteText, fromLineOrSwapped, personSwap, sourceClause, diagnosisIsTentative } from "../src/emr/work.js";
import { CLERK_KINDS, ClerkFake, DOC, PAT, clerkBoot, ins, type W } from "./clerking-helpers.js";

// Lane EMN: a clean note, a spelling that never lands on the wrong part, and no ward class question on an emergency arrival.
const TOKEN = (n: number) => `v1.${String(1_761_700_000_000 + n)}.${"A".repeat(43)}`;
const print = (n: number): Voiceprint => ({ vector: [n], ms: 20, model: "nemo_en_titanet_small" });
const OWNER = print(5), DRB = print(4), STRANGER = print(1);
const ARRIVAL = "dddddddd-1111-4222-8333-444444444444", ARRIVAL_VISIT = "eeeeeeee-1111-4222-8333-444444444444";

// A doctor with a voice match (5 is the owner, 4 is Dr B) who opens arrivals, clerks and requests admission.
class EmnFake extends ClerkFake {
  private n = 0;
  refuseAdmission: string | null = null;
  override kindsFor(): readonly string[] { return [...CLERK_KINDS, EMERGENCY_KIND, IDENTITY_KIND, "record_triage_vitals", "request_admission"]; }
  override async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    if (kind === "request_admission" && this.refuseAdmission) { this.writes.push({ kind, args, key, prov, id: "refused" }); return { ok: false, reason: "door_422", status: 422, retryable: false, counted: true, message: this.refuseAdmission }; }
    if (kind !== EMERGENCY_KIND) return super.commit(kind, args, key, prov);
    if (!this.writes.some((w) => w.key === key)) this.writes.push({ kind, args, key, prov, id: ARRIVAL });
    return { ok: true, record_id: ARRIVAL, record_version: 1, event_ids: [`patient:${ARRIVAL}`, `visit:${ARRIVAL_VISIT}`], replayed: false };
  }
  readonly speaker = async (_o: string, v: readonly number[], _p: Provenance): Promise<SpeakerVerdict> => {
    this.n += 1;
    return v[0] === 5 ? { speaker: "owner", token: TOKEN(this.n) } : v[0] === 4 ? { speaker: "other_clinician", label: "Dr B", role: "doctor" } as SpeakerVerdict : { speaker: "unverified", reason: "no_match" };
  };
  override async resolve(target: EmrTarget): Promise<EmrContext> {
    if (target.patient_id === ARRIVAL) return { admission_id: "", patient_id: ARRIVAL, visit_id: ARRIVAL_VISIT, label: "Unknown arrival 17:22", facts: { ward: null, bed: null, sex: "female" }, keywords: [] };
    return super.resolve(target);
  }
}

function boot(script: (said: string) => W[], o: { holdMs?: number; port?: EmnFake; secondEar?: SecondEar } = {}) {
  const port = o.port ?? new EmnFake();
  return { ...clerkBoot(script, { port, ...(o.holdMs ? { holdMs: o.holdMs } : {}), ...(o.secondEar ? { secondEar: o.secondEar } : {}) }), port };
}
type B = ReturnType<typeof boot>;
async function arrival(b: B) {
  const e = await b.rt.emergency(DOC, { text: "I have a new unknown arrival.", spoken_at: new Date(b.clock.now).toISOString(), args: { unidentified_ref: "Unknown arrival 17:22", reason: "Emergency arrival, opened by voice; reason not yet stated" } });
  await b.rt.settled();
  return e.task_id;
}
const sayOn = (b: B, task: string, text: string, v: Voiceprint = OWNER) => b.rt.say({ owner: DOC, target: { patient_id: ARRIVAL }, text, source: "audio", voiceprint: v }, task);
const of = (b: B, kind: string) => b.port.writes.filter((w) => w.kind === kind);
const ASIDE: W[] = [{ class: "aside", confidence: 0.9 }];

// The lines of the 2 Nov live test, as the ear wrote them.
const PC = "Presenting complaint highhigh fever and confusion.";
const EXAM = "um stomach seems a bit stiff, pale, febrile and drowsy, no neck stiffness";
const RR = "Respiratory rate 24.";
const SPELL = "um just to get the spelling right okay A F O R I'm going to try to check your vitals now Madam Okafor";
const SAID = "I've been having fever for three days and I've been vomiting and very drowsy in fact I just fell off in the market";
const THIRD = "Has been having fever for three days and has been vomiting and very drowsy, in fact just fell off in the market";
const gate = (s: string): W[] => {
  if (s === SAID) return [{ class: "patient_reported", text: s, confidence: 0.9 }];
  if (s === "I've had a cough. My chest hurts.") return [{ class: "patient_reported", text: "Two weeks of productive cough with chest pain.", confidence: 0.9 }];
  if (s === "Doctor, I've been coughing.") return [{ class: "patient_reported", text: "Has been coughing.", confidence: 0.9 }];
  if (s === "I fell at home." || s === "I saw her in my clinic last week.") return [{ class: "finding", section: "history", text: s, confidence: 0.9 }];
  if (s === PC) return [{ class: "finding", section: "presenting_complaint", text: "highhigh fever and confusion", confidence: 0.9 }];
  if (s === EXAM) return [{ class: "finding", section: "examination", text: s, confidence: 0.9 }];
  if (s === RR) return [ins("record_triage_vitals", { resp_rate: 24, text: "Respiratory rate 24" })];
  if (s === "Admit her for severe malaria") return [ins("admit_patient", { text: "severe malaria" })];
  if (s === "Admit her to the children's ward for severe malaria") return [ins("admit_patient", { ward: "childrens", text: "severe malaria" })];
  if (/admit/i.test(s)) return [ins("request_admission", { text: "observation" })];
  return ASIDE;
};

describe("EMN 1: the note reads as a clinician writes it", () => {
  it("drops an ear stutter and fillers and keeps real doubled words, ER and millimetres", () => {
    expect(cleanNoteText("highhigh fever and confusion")).toBe("high fever and confusion");
    expect(cleanNoteText("um stomach seems a bit stiff, uh, pale")).toBe("stomach seems a bit stiff, pale");
    expect(cleanNoteText("Um, erm, chest is clear")).toBe("chest is clear");
    expect(cleanNoteText("soft murmur, ate pawpaw, beriberi ruled out, brought to ER, 3 mm lesion")).toBe("soft murmur, ate pawpaw, beriberi ruled out, brought to ER, 3 mm lesion");
  });

  it("writes another clinician's finding and triage with no speaker prefix, and keeps who said it on the line the record cites", async () => {
    const b = boot(gate);
    const task = await arrival(b);
    await sayOn(b, task, PC);
    await b.rt.settled();
    const exam = await sayOn(b, task, EXAM, DRB);
    await b.rt.settled();
    await sayOn(b, task, RR, STRANGER);
    await b.rt.settled();
    const notes = of(b, "record_clerking").map((w) => String(w.args["text"]));
    expect(notes).toEqual(["high fever and confusion", "stomach seems a bit stiff, pale, febrile and drowsy, no neck stiffness"]);
    const last = of(b, "record_clerking").at(-1)!;
    expect(Object.values(last.args["note"] as Record<string, string>).join(" ")).not.toMatch(/said:|not verified|highhigh|\bum\b/);
    expect(last.prov.evidence).toBe(`transcript:${exam.line_id}`);
    expect(b.rt.view(task)!.transcript.find((l) => l.id === exam.line_id)!.speaker).toMatchObject({ speaker: "other_clinician", label: "Dr B" });
    const triage = of(b, "record_triage_vitals")[0]!;
    expect(triage.args["resp_rate"]).toBe(24);
    expect(String(triage.args["note"] ?? "")).not.toMatch(/said|not verified/i);
    await b.rt.stop();
  });
});

describe("EMN 2: a spelled run goes to the part it names or matches, never to a part it is not", () => {
  it("leaves Amaka Okafor whole when the ear heard the surname's spelling as A F O R", () => {
    expect(spelledName(SPELL, "Amaka Okafor")).toBeNull();
    // A fragment of the surname said for the first name is asked, never written over it.
    expect(spelledName("Spell her first name, A, F, O, R.", "Amaka Okafor")).toEqual({ ask: ["Amaka", "Okafor"], word: "Afor" });
    // A named part still takes a run that is no fragment of another part.
    expect(spelledName("Her surname is spelt O, K, O, R, O.", "Amaka Okafor")).toEqual({ name: "Amaka Okoro" });
    expect(spelledName("A, M, A, K, A", "Amaka Okafo")).toBeNull();
    expect(spelledName("O, K, A, F, O, R", "Amaka Okafo")).toEqual({ name: "Amaka Okafor" });
  });

  it("keeps the name the patient said when the spelling line follows it on the arrival", async () => {
    const b = boot(() => ASIDE);
    const task = await arrival(b);
    await sayOn(b, task, "My name is Amaka Okafor", STRANGER);
    await b.rt.settled();
    await sayOn(b, task, SPELL);
    await b.rt.settled();
    expect(of(b, IDENTITY_KIND).map((w) => w.args["name"])).toEqual(["Amaka Okafor"]);
    await b.rt.stop();
  });
});

describe("EMN 3: an emergency admission asks no ward class", () => {
  it("requests the admission on an emergency arrival with no ward class and as an emergency", async () => {
    const b = boot(gate);
    const task = await arrival(b);
    await sayOn(b, task, "Let's admit her for observation.");
    await b.rt.settled();
    const v = b.rt.view(task)!;
    expect(v.questions.map((q) => q.text).join(" ")).not.toMatch(/ward class|emergency or a planned/i);
    const req = of(b, "request_admission");
    expect(req).toHaveLength(1);
    expect(req[0]!.args).not.toHaveProperty("ward_class");
    expect(req[0]!.args["admission_type"]).toBe("emergency");
    await b.rt.stop();
  });

  it("asks the ward class only when the hospital refuses for want of one", async () => {
    const b = boot(gate);
    b.port.refuseAdmission = "Say which ward class to admit to: general, private, ICU, HDU or another.";
    const task = await arrival(b);
    await sayOn(b, task, "Let's admit her for observation.");
    await b.rt.settled();
    expect(b.rt.view(task)!.questions.at(-1)!.text).toBe("Which ward class should I request: general, private, ICU, HDU or another?");
    await b.rt.stop();
  });

  it("sends 'Admit her for severe malaria' on an emergency arrival as a request with no class, and a named ward keeps the direct admission", async () => {
    const b = boot(gate);
    const task = await arrival(b);
    await sayOn(b, task, "Admit her for severe malaria");
    await b.rt.settled();
    expect(b.rt.view(task)!.questions.map((q) => q.text).join(" ")).not.toMatch(/which ward|ward class|emergency or a planned/i);
    expect(of(b, "admit_patient")).toHaveLength(0);
    expect(of(b, "request_admission").map((w) => w.args)).toEqual([{ visit_id: ARRIVAL_VISIT, patient_id: ARRIVAL, admission_type: "emergency", reason: "severe malaria" }]);
    const c = boot(gate);
    const other = await arrival(c);
    await sayOn(c, other, "Admit her to the children's ward for severe malaria");
    await c.rt.settled();
    expect(of(c, "request_admission")).toHaveLength(0);
    expect(of(c, "admit_patient").map((w) => w.args)).toEqual([{ visit_id: ARRIVAL_VISIT, patient_id: ARRIVAL, ward: "childrens", admission_type: "emergency", reason: "severe malaria" }]);
    await b.rt.stop();
    await c.rt.stop();
  });

  it("still asks the ward class for an ordinary patient's admission", async () => {
    const b = boot(gate);
    const a = await b.rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Let's admit him for observation.", source: "audio", voiceprint: OWNER });
    await b.rt.settled();
    expect(of(b, "request_admission")).toHaveLength(0);
    expect(b.rt.view(a.task_id)!.questions.at(-1)!.text).toBe("Which ward class should I request: general, private, ICU, HDU or another?");
    await b.rt.stop();
  });
});

describe("EMN 4: the patient's own words in third person by a fixed table", () => {
  it("swaps the 2 Nov line and nothing outside the table", () => {
    expect(personSwap(SAID, "female")).toBe(THIRD);
    expect(personSwap(SAID, null)).toBe(THIRD);
    expect(personSwap("My head hurts. I fell at home.", "female")).toBe("Her head hurts. Fell at home.");
    expect(personSwap("My head hurts and it hurts me.", "male")).toBe("His head hurts and it hurts him.");
    expect(personSwap("I hurt myself.", null)).toBe("Hurt themselves.");
    expect(personSwap("I'm tired. I was at work. I have a rash.", "f")).toBe("Is tired. Was at work. Has a rash.");
    // A sentence keeping an "I" the table cannot place stays exactly as said, and third person stays as it is.
    expect(personSwap("I feel dizzy and my head hurts.", "female")).toBe("I feel dizzy and my head hurts.");
    expect(personSwap("I have a headache since I woke up.", "female")).toBe("I have a headache since I woke up.");
    expect(personSwap(THIRD, "female")).toBe(THIRD);
  });

  it("accepts the gate's text when it is the line after the swap, and never free text", () => {
    expect(fromLineOrSwapped(THIRD, SAID, "female", fromLine)).toBe(true);
    expect(fromLineOrSwapped("Three days of fever and vomiting, drowsy, collapsed at the market.", SAID, "female", fromLine)).toBe(false);
    expect(fromLine(THIRD, SAID)).toBe(true);
    expect(fromLineOrSwapped("Her chest hurts.", "My chest hurts.", "female", fromLine)).toBe(true);
    expect(fromLine("Her chest hurts.", "My chest hurts.")).toBe(false);
    expect(fromLineOrSwapped("Her chest hurts.", "My chest hurts.", "male", fromLine)).toBe(false);
  });

  it("writes the patient's words and an unmatched voice's history in third person, and leaves a clinician's own history as said", async () => {
    const b = boot(gate);
    const task = await arrival(b);
    for (const [line, v] of [[SAID, STRANGER], ["I've had a cough. My chest hurts.", STRANGER], ["Doctor, I've been coughing.", STRANGER], ["I fell at home.", STRANGER], ["I saw her in my clinic last week.", OWNER]] as const) {
      await sayOn(b, task, line, v);
      await b.rt.settled();
    }
    const by = (sec: string) => of(b, "record_clerking").filter((w) => w.args["section"] === sec).map((w) => String(w.args["text"]));
    expect(by("patient_reported")).toEqual([THIRD, "Has had a cough. Her chest hurts.", "Has been coughing."]);
    expect(by("history")).toEqual(["Fell at home.", "I saw her in my clinic last week."]);
    await b.rt.stop();
  });
});

// Lane EMF, from the 3 Nov live test: vitals after the first set, a clinician's "you" in the examination, a diagnosis said in passing, speech order and a held admission's yes.
class EmfFake extends EmnFake {
  override kindsFor(): readonly string[] { return [...super.kindsFor(), "record_diagnosis"]; }
}
const PULSE = "okay your pulse is about 110", BPT = "blood pressure 90 over 60, temperature 38.5", RRS = "respiratory rate 24, oxygen 94%";
const EXAM3 = "you look pretty pale um and it seems like you're also drowsy and febrile your neck too is a bit stiff";
const DX = "I think my initial diagnosis is that you might have cerebral malaria";
const ADMIT_AE = "admit her to A and E for severe malaria";
const gate3 = (s: string): W[] => {
  if (s === PULSE) return [ins("record_observation", { pulse: 110 })];
  if (s === BPT) return [ins("record_observation", { bp: "90/60" }), ins("record_observation", { temp_c: 38.5 })];
  if (s === RRS) return [ins("record_triage_vitals", { resp_rate: 24, spo2: 94 })];
  if (s === "pulse is actually 112") return [{ class: "correction", pulse: 112, confidence: 0.9 }];
  if (s === EXAM3 || s === "Can you sit up for me. Your chest is clear.") return [{ class: "finding", section: "examination", text: s, confidence: 0.9 }];
  if (s === DX || s === "it could be malaria or meningitis, my working diagnosis is malaria or meningitis" || s === "we could try antibiotics") return [{ class: "option", confidence: 0.9 }];
  if (s === ADMIT_AE) return [ins("admit_patient", { ward: "a_and_e", text: "severe malaria" })];
  return ASIDE;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("EMF 1: every vitals line on an emergency arrival goes to the triage row", () => {
  it("gathers vitals said within the hold into one triage write, and a later set or correction is its own write, never the note", async () => {
    const b = boot(gate3, { holdMs: 150 });
    const task = await arrival(b);
    await sayOn(b, task, PULSE);
    await sayOn(b, task, BPT);
    await b.rt.settled();
    await wait(400);
    await b.rt.settled();
    await sayOn(b, task, RRS);
    await b.rt.settled();
    await wait(400);
    await sayOn(b, task, "pulse is actually 112");
    await b.rt.settled();
    await wait(400);
    await b.rt.settled();
    const triage = of(b, "record_triage_vitals").map((w) => w.args);
    expect(triage).toEqual([
      { visit_id: ARRIVAL_VISIT, patient_id: ARRIVAL, pulse: 110, bp: "90/60", temp_c: "38.5" },
      { visit_id: ARRIVAL_VISIT, patient_id: ARRIVAL, resp_rate: 24, spo2: 94 },
      { visit_id: ARRIVAL_VISIT, patient_id: ARRIVAL, pulse: 112 },
    ]);
    expect(of(b, "record_clerking").filter((w) => w.args["section"] === "vitals")).toHaveLength(0);
    await b.rt.stop();
  });
});

describe("EMF 1a: the hold runs again from the line that joins it", () => {
  it("does not write a gathered set before the later line's hold is over", async () => {
    const b = boot(gate3, { holdMs: 400 });
    const task = await arrival(b);
    // The runtime's settled() waits out every hold, so this test waits by the clock alone until the end.
    await sayOn(b, task, PULSE);
    await wait(250);
    await sayOn(b, task, BPT);
    await wait(250);
    expect(of(b, "record_triage_vitals")).toHaveLength(0);
    await wait(400);
    await b.rt.settled();
    expect(of(b, "record_triage_vitals").map((w) => w.args["bp"])).toEqual(["90/60"]);
    await b.rt.stop();
  });
});

describe("EMF 1b: a gathered triage set is written only when every line's second reading agrees", () => {
  const earOf = (heard: string[]): SecondEar => async () => ({ text: heard.shift() ?? "", provider: "local", model: "test-ear", response_id: null, cost_usd: 0.001, fallback_reason: null });
  const run = async (heard: string[]) => {
    const b = boot(gate3, { holdMs: 150, secondEar: earOf(heard) });
    const task = await arrival(b);
    const clip = new Uint8Array(44);
    await b.rt.say({ owner: DOC, target: { patient_id: ARRIVAL }, text: PULSE, source: "audio", voiceprint: OWNER, clip }, task);
    await b.rt.say({ owner: DOC, target: { patient_id: ARRIVAL }, text: BPT, source: "audio", voiceprint: OWNER, clip }, task);
    await b.rt.settled();
    await wait(400);
    await b.rt.settled();
    return { b, task };
  };
  it("writes one set when both readings agree", async () => {
    const { b } = await run([PULSE, BPT]);
    expect(of(b, "record_triage_vitals").map((w) => w.args)).toEqual([{ visit_id: ARRIVAL_VISIT, patient_id: ARRIVAL, pulse: 110, bp: "90/60", temp_c: "38.5" }]);
    await b.rt.stop();
  });
  it("writes nothing and asks when the earlier line's reading differs", async () => {
    const { b, task } = await run(["okay your pulse is about 170", BPT]);
    expect(of(b, "record_triage_vitals")).toHaveLength(0);
    expect(b.rt.view(task)!.questions.at(-1)!.text).toMatch(/ulse/);
    await b.rt.stop();
  });
  it("writes nothing and asks when the later line's reading differs", async () => {
    const { b, task } = await run([PULSE, "blood pressure 90 over 60, temperature 39.5"]);
    expect(of(b, "record_triage_vitals")).toHaveLength(0);
    expect(b.rt.view(task)!.questions.at(-1)!.text).toMatch(/emperature/);
    await b.rt.stop();
  });
});

describe("EMF 2: a clinician's words to the patient in the examination by the fixed table", () => {
  it("swaps you look, you're, your neck and your X, and leaves what the table cannot place", () => {
    expect(addressSwap(cleanNoteText(EXAM3))).toBe("Looks pretty pale and seems also drowsy and febrile neck too is a bit stiff");
    expect(addressSwap("You are febrile. Your abdomen is soft.")).toBe("Is febrile. Abdomen is soft.");
    expect(addressSwap("Can you sit up for me. Your chest is clear.")).toBe("Can you sit up for me. Chest is clear.");
    expect(addressSwap("Chest is clear.")).toBe("Chest is clear.");
  });

  it("writes the 3 Nov examination line without the second person, from any voice", async () => {
    const b = boot(gate3);
    const task = await arrival(b);
    await sayOn(b, task, EXAM3);
    await b.rt.settled();
    await sayOn(b, task, "Can you sit up for me. Your chest is clear.", STRANGER);
    await b.rt.settled();
    expect(of(b, "record_clerking").map((w) => w.args["text"])).toEqual(["Looks pretty pale and seems also drowsy and febrile neck too is a bit stiff", "Can you sit up for me. Chest is clear."]);
    await b.rt.stop();
  });
});

describe("EMF 3: a working diagnosis said in passing", () => {
  it("keeps the source clause and recognises uncertainty without extracting a final diagnosis", () => {
    expect(sourceClause(DX, DX)).toBe(DX);
    expect(diagnosisIsTentative(DX)).toBe(true);
    expect(diagnosisIsTentative("my working diagnosis is severe malaria.")).toBe(true);
    expect(diagnosisIsTentative("the diagnosis is acute appendicitis.")).toBe(false);
  });

  it("documents a working diagnosis and differential without asking for or recording a final diagnosis", async () => {
    const b = boot(gate3, { port: new EmfFake() });
    const task = await arrival(b);
    const differential = "it could be malaria or meningitis, my working diagnosis is malaria or meningitis";
    await sayOn(b, task, DX);
    await b.rt.settled();
    await sayOn(b, task, differential);
    await b.rt.settled();
    await sayOn(b, task, "confirm the diagnosis");
    await b.rt.settled();
    expect(of(b, "record_diagnosis")).toHaveLength(0);
    expect(of(b, "record_clerking").filter((w) => w.args["section"] === "assessment").map((w) => w.args["text"])).toEqual([DX, differential]);
    expect(b.rt.view(task)!.questions.filter((q) => q.text.includes("confirm to record this diagnosis"))).toHaveLength(0);
    await b.rt.stop();
  });
});

describe("EMF 4: the transcript is in speech order", () => {
  it("places a line the ears returned late by when it was spoken", async () => {
    const b = boot(() => ASIDE);
    const task = await arrival(b);
    const at = (s: number) => new Date(b.clock.now + s * 1000).toISOString();
    // Two ears: the main ear and a second one that returned its earlier speech late; one ear's own lines keep their order.
    const line = (text: string, s: number, session: string) => b.rt.say({ owner: DOC, target: { patient_id: ARRIVAL }, text, source: "audio", voiceprint: OWNER, spoken_at: at(s), ambient: { session_id: session, seqs: [s], ended_at: at(s + 1), final_at: at(s + 1), finished_by: "quiet_tail", raw_text: text, trailing_silence_ms: 700 } as never }, task);
    const third = await line("third, said at ten", 10, "ear-1");
    // One ear's backlog can stamp a later line with an earlier start; that ear's own order stands.
    const fourth = await line("fourth, stamped nine and a half", 9.5, "ear-1");
    const first = await line("first, said at two", 2, "ear-1.f1.0");
    const second = await line("second, said at five", 5, "ear-1.f1.0");
    await b.rt.settled();
    const ids = [first, second, third, fourth].map((x) => x.line_id);
    expect(b.rt.view(task)!.transcript.map((l) => l.id).filter((id) => ids.includes(id))).toEqual(ids);
    await b.rt.stop();
  });
});

describe("capture-time transcript ordering", () => {
  it("orders reliable timestamps within the same session and replays that order", async () => {
    const b = boot(() => ASIDE);
    const task = await arrival(b);
    const line = (text: string, seq: number) => b.rt.say({ owner: DOC, target: { patient_id: ARRIVAL }, text, source: "audio", voiceprint: OWNER, spoken_at: new Date(b.clock.now + seq * 1000).toISOString(), ambient: { session_id: "same", seqs: [seq], captured: true, ended_at: new Date(b.clock.now + (seq + 1) * 1000).toISOString(), final_at: new Date().toISOString(), finished_by: "quiet_tail", raw_text: text, trailing_silence_ms: 700 } as never }, task);
    const second = await line("second captured turn", 2);
    const first = await line("first captured turn", 1);
    await b.rt.settled();
    expect(b.rt.view(task)!.transcript.slice(-2).map((l) => l.id)).toEqual([first.line_id, second.line_id]);
    await b.rt.stop();
  });
});

describe("EMF 5: a held admission says exactly what yes releases it", () => {
  it("asks for 'yes, admit her to A and E', releases on that reply in the owner's voice, and a bare yes from no matched voice stays refused", async () => {
    const b = boot(gate3);
    const task = await arrival(b);
    await sayOn(b, task, ADMIT_AE, STRANGER);
    await b.rt.settled();
    const held = b.rt.view(task)!.questions.at(-1)!.text;
    expect(held).toMatch(/Say: "yes, admit her to A and E"\./);
    await sayOn(b, task, "yes", STRANGER);
    await b.rt.settled();
    expect(of(b, "admit_patient")).toHaveLength(0);
    expect(b.rt.view(task)!.questions.at(-1)!.text).toMatch(/Say: "yes, admit her to A and E"\./);
    await sayOn(b, task, "yes, admit her to A and E");
    await b.rt.settled();
    expect(of(b, "admit_patient").map((w) => w.args["ward"])).toEqual(["a_and_e"]);
    await b.rt.stop();
  });
});
