import { describe, expect, it } from "vitest";
import { EMERGENCY_KIND, IDENTITY_KIND, spelledName } from "../src/emr/entry.js";
import type { EmrCommit, EmrContext, EmrTarget, Provenance, WorkArgs } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { fromLine } from "../src/emr/runtime.js";
import { cleanNoteText, fromLineOrSwapped, personSwap } from "../src/emr/work.js";
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

function boot(script: (said: string) => W[]) {
  const port = new EmnFake();
  return { ...clerkBoot(script, { port }), port };
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
