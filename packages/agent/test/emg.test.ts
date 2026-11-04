import { describe, expect, it } from "vitest";
import { EMERGENCY_KIND, IDENTITY_KIND, spelledName } from "../src/emr/entry.js";
import { EmrPortError, type EmrCommit, type EmrContext, type EmrTarget, type Provenance, type WorkArgs } from "../src/emr/port.js";
import { MIXED_OWNER_KINDS, type SpeakerVerdict, type Voiceprint } from "../src/emr/speaker.js";
import { NO_ADMISSION_REASON, addressSwap, admissionReason, prescriptionSaid, statedDiagnosis } from "../src/emr/work.js";
import { ADMIT, ClerkFake, DOC, PAT, clerkBoot, ins, type W } from "./clerking-helpers.js";

// Lane EMG: the name on a new arrival, no stall, long lines routed part by part, and a clinician's note.
const TOKEN = (n: number) => `v1.${String(1_761_700_000_000 + n)}.${"A".repeat(43)}`;
const print = (n: number): Voiceprint => ({ vector: [n], ms: 20, model: "nemo_en_titanet_small" });
export const OWNER = print(5), MIXED = print(1);
const id = (n: number, tail: string) => `${String(n).repeat(8)}-1111-4222-8333-${tail}`;

// A&E with arrivals that each get their own patient and visit, the doctor's orders and a voice match (5 is the owner).
export class EmgFake extends ClerkFake {
  private n = 0;
  private arrivals = 0;
  readonly visits = new Map<string, string>();
  override kindsFor(): readonly string[] { return [...super.kindsFor(), EMERGENCY_KIND, IDENTITY_KIND, "record_triage_vitals", "request_admission", "order_test", "prescribe", "record_diagnosis"]; }
  orderables() { return { tests: { fbc: ["FBC", "full blood count"], malaria: ["malaria parasite", "MP"], urinalysis: ["urinalysis"] }, drugs: { paracetamol_iv: { words: ["IV paracetamol", "paracetamol"], controlled: false }, paracetamol_oral: { words: ["paracetamol tablets"], controlled: false } } }; }
  override async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    if (kind !== EMERGENCY_KIND) return super.commit(kind, args, key, prov);
    const hit = this.writes.find((w) => w.key === key);
    if (!hit) {
      this.arrivals += 1;
      const patient = id(this.arrivals, "444444444444"), visit = id(this.arrivals, "555555555555");
      this.visits.set(patient, visit);
      this.writes.push({ kind, args, key, prov, id: patient });
    }
    const w = this.writes.find((x) => x.key === key)!;
    return { ok: true, record_id: w.id, record_version: 1, event_ids: [`patient:${w.id}`, `visit:${this.visits.get(w.id)}`], replayed: !!hit };
  }
  readonly speaker = async (_o: string, v: readonly number[], _p: Provenance): Promise<SpeakerVerdict> => {
    this.n += 1;
    return v[0] === 5 ? { speaker: "owner", token: TOKEN(this.n) } : { speaker: "unverified", reason: "mixed_speakers" };
  };
  override async resolve(target: EmrTarget): Promise<EmrContext> {
    const visit = target.patient_id ? this.visits.get(target.patient_id) : undefined;
    if (visit) return { admission_id: "", patient_id: target.patient_id!, visit_id: visit, label: "Unnamed arrival", facts: { ward: null, bed: null, sex: "female" }, keywords: [] };
    return super.resolve(target);
  }
}

export function boot(script: (said: string) => W[], at = Date.parse("2026-11-03T13:36:39Z")) {
  const port = new EmgFake();
  const b = clerkBoot(script, { port, clock: { now: at } });
  return { ...b, port };
}
export type B = ReturnType<typeof boot>;
export async function arrival(b: B, ref = "Unknown arrival 14:36") {
  const e = await b.rt.emergency(DOC, { text: "Um so I've got a new arrival, arrival", spoken_at: new Date(b.clock.now).toISOString(), args: { unidentified_ref: ref, reason: "Emergency arrival" } });
  await b.rt.settled();
  return e.task_id;
}
export const patientOf = (b: B, task: string) => b.rt.view(task)!.patient_id!;
export async function sayOn(b: B, task: string, text: string, v: Voiceprint = OWNER) {
  const r = await b.rt.say({ owner: DOC, target: { patient_id: patientOf(b, task) }, text, source: "audio", voiceprint: v, spoken_at: new Date(b.clock.now).toISOString() }, task);
  await b.rt.settled();
  return r;
}
export const of = (b: B, kind: string) => b.port.writes.filter((w) => w.kind === kind);
const ASIDE: W[] = [{ class: "aside", confidence: 0.9 }];

describe("EMG 1: the name on a new arrival", () => {
  it("writes a said name on today's unnamed arrival though a finished encounter from yesterday has the same name", async () => {
    const b = boot(() => ASIDE, Date.parse("2026-11-02T17:22:59Z"));
    try {
      const old = await arrival(b, "Unknown arrival 18:22");
      await sayOn(b, old, "My name is Amaka Okafor.", MIXED);
      expect(b.rt.view(old)!.state).toBe("done");
      b.clock.now += 20 * 3600_000;
      const fresh = await arrival(b);
      await sayOn(b, fresh, "My name is Amaka Okafor.", MIXED);
      const v = b.rt.view(fresh)!;
      expect(v.questions.map((q) => q.text)).toEqual([]);
      expect(of(b, IDENTITY_KIND).map((w) => [w.args["patient_id"], w.args["name"]])).toEqual([[patientOf(b, old), "Amaka Okafor"], [patientOf(b, fresh), "Amaka Okafor"]]);
    } finally { await b.rt.stop(); }
  });

  it("never asks for whom about a patient whose encounter finished on an earlier day", async () => {
    const b = boot(() => ASIDE, Date.parse("2026-11-02T17:22:59Z"));
    try {
      const old = await arrival(b, "Unknown arrival 18:22");
      await sayOn(b, old, "My name is Amaka Okafor.", MIXED);
      b.clock.now += 20 * 3600_000;
      const fresh = await arrival(b);
      await sayOn(b, fresh, "Madam Okafor don't worry, you're in good hands");
      expect(b.rt.view(fresh)!.questions).toEqual([]);
      b.clock.now += 60_000;
      await sayOn(b, old, "She is comfortable now");
      expect(b.rt.view(fresh)!.questions).toEqual([]);
      await sayOn(b, fresh, "Madam Okafor don't worry");
      expect(b.rt.view(fresh)!.questions.map((q) => q.answers)).toEqual([["Unknown arrival 14:22", "Amaka Okafor"]]);
    } finally { await b.rt.stop(); }
  });

  it("takes a naming line on an unnamed arrival as its own name even while another live patient today shares it", async () => {
    const b = boot(() => ASIDE);
    try {
      const first = await arrival(b, "Unknown arrival 14:36");
      await sayOn(b, first, "My name is Amaka Okafor.", MIXED);
      b.clock.now += 5 * 60_000;
      const second = await arrival(b, "Unknown arrival 14:41");
      await sayOn(b, second, "Her name is Amaka Okafor.");
      expect(b.rt.view(second)!.questions).toEqual([]);
      expect(of(b, IDENTITY_KIND).map((w) => w.args["patient_id"])).toEqual([patientOf(b, first), patientOf(b, second)]);
    } finally { await b.rt.stop(); }
  });

  it("shows each for-whom choice with its arrival time or name, never two identical labels", async () => {
    const b = boot(() => ASIDE);
    try {
      const a = await arrival(b, "Unknown arrival 14:36");
      await sayOn(b, a, "My name is Amaka Okafor.", MIXED);
      b.clock.now += 5 * 60_000;
      const c = await arrival(b, "Unknown arrival 14:41");
      await sayOn(b, c, "My name is Amaka Okafor.", MIXED);
      b.clock.now += 5 * 60_000;
      const d = await arrival(b, "Unknown arrival 14:46");
      await sayOn(b, d, "so however it goes just let me know but Madam Okafor don't worry");
      const q = b.rt.view(d)!.questions[0]!;
      const labels = q.answers!;
      expect(new Set(labels).size).toBe(labels.length);
      expect(labels).toEqual(["Unknown arrival 14:46", "Amaka Okafor, arrived 14:36", "Amaka Okafor, arrived 14:41"]);
      b.clock.now += 10_000;
      await b.rt.say({ owner: DOC, target: {}, text: "Amaka Okafor, arrived 14:41", source: "text", question_id: q.question_id, spoken_at: new Date(b.clock.now).toISOString() }, d);
      await b.rt.settled();
      expect(b.rt.view(d)!.asked.find((x) => x.question_id === q.question_id)!.answered_by).not.toBeNull();
    } finally { await b.rt.stop(); }
  });

  it("reads a spelling of the whole held name as the same name, never a new first name", () => {
    expect(spelledName("Amaka Okafor A M A K A O K A F O R Okay um", "Amaka Okafor")).toBeNull();
    expect(spelledName("O, K, A, F, O, R", "Amaka Okafo")).toEqual({ name: "Amaka Okafor" });
  });
});

// The 3 Nov 14:37 and 14:39 lines as the ear wrote them, and the gate's answer for each part said alone.
export const SPELL_VITALS = "Amaka Okafor A M A K A O K A F O R Okay um I'm going to check your blood pressure now I'm going to check all your vitals please just bear with me okay your pulse is about 110 the blood pressure is quite low it's 90 over 60 your temperature is about 38.5 hmm your SpO2 is about 94 percent and your respiratory rate is 24";
export const LONG = "um how you feeling how you feeling ah doctor I've been having fever for three days I've been vomiting I tried to take medication but today when I went to the market to buy some things I fell off I fainted doctor okay that's fine don't worry we're going to take care of you is there any medicine that you're allergic to doctor I think penicillin okay that's fine just lie down I'll have to do an examination for you real quick um you're quite pale open your eyes for me please okay um you look febrile and a bit drowsy well really drowsy your neck is also not stiff uh well my initial diagnosis for you is that you have severe malaria okay um what we'll do now is to send a request to the lab Nurse please come take a sample the lab needs to do a full blood count test the malaria parasite test and urinalysis okay and also get stats on IV paracetamol 120 milligrams please get to the pharmacy and get that um maybe do it for 12 hours and then we observe her again also give her paracetamol one gram yeah one gram IV paracetamol and please get all of that from the pharmacy immediately admit her in the in the ward for severe malaria obviously um and do a four hourly obliques okay";
export const parted = (said: string): W[] => {
  if (/your pulse is about 110/.test(said)) return [ins("record_triage_vitals", { words: "your pulse is about 110 the blood pressure is quite low it's 90 over 60 your temperature is about 38.5 hmm your SpO2 is about 94 percent and your respiratory rate is 24", pulse: 110, bp: "90/60", temp_c: 38.5, spo2: 94, resp_rate: 24 })];
  if (/fever for three days/.test(said)) return [{ class: "patient_reported", words: "I've been having fever for three days I've been vomiting I tried to take medication but today when I went to the market to buy some things I fell off I fainted", confidence: 0.9 }];
  if (/allergic/.test(said)) return [{ class: "question_to_staff", words: "is there any medicine that you're allergic to", confidence: 0.9 }, { class: "patient_reported", words: "I think penicillin", confidence: 0.9 }];
  if (/quite pale/.test(said)) return [{ class: "finding", section: "examination", words: "you're quite pale", confidence: 0.9 }, { class: "question_to_staff", words: "open your eyes for me please", confidence: 0.9 }];
  if (/febrile/.test(said)) return [{ class: "finding", section: "examination", words: "you look febrile and a bit drowsy well really drowsy your neck is also not stiff", confidence: 0.9 }];
  if (/initial diagnosis/.test(said)) return [{ class: "finding", section: "assessment", words: "my initial diagnosis for you is that you have severe malaria", confidence: 0.9 }];
  if (/full blood count/.test(said)) return [ins("order_test", { words: "the lab needs to do a full blood count test", test: "fbc" }), ins("order_test", { words: "the malaria parasite test", test: "malaria" }), ins("order_test", { words: "and urinalysis", test: "urinalysis" })];
  if (/stats on IV paracetamol/.test(said)) return [ins("prescribe", { words: "get stats on IV paracetamol 120 milligrams", drug: "paracetamol_iv", dose: "120 mg", route: "iv", confidence: 0.88 })];
  if (/one gram IV paracetamol/.test(said)) return [ins("prescribe", { words: "give her paracetamol one gram yeah one gram IV paracetamol", drug: "paracetamol_iv", dose: "1 g", route: "iv", confidence: 0.88 }), ins("request_admission", { words: "admit her in the in the ward for severe malaria", text: "severe malaria" })];
  return ASIDE;
};
const proposed = (b: B, task: string, kind: string) => b.rt.view(task)!.actions.filter((a) => a.kind === kind);

describe("EMG 3: a long line carries many things, each routed as if said alone", () => {
  it("sends the spelled name's line of vitals to the triage row whole and keeps the name", async () => {
    const seen: string[] = [];
    const b = boot((s) => { seen.push(s); return parted(s); });
    try {
      const task = await arrival(b);
      await sayOn(b, task, "My name is Amaka Okafor.", MIXED);
      await sayOn(b, task, SPELL_VITALS);
      expect(of(b, IDENTITY_KIND).map((w) => w.args["name"])).toEqual(["Amaka Okafor"]);
      expect(of(b, "record_triage_vitals").map((w) => [w.args["pulse"], w.args["bp"], w.args["temp_c"], w.args["spo2"], w.args["resp_rate"]])).toEqual([[110, "90/60", "38.5", 94, 24]]);
      expect(b.rt.view(task)!.questions).toEqual([]);
    } finally { await b.rt.stop(); }
  });

  it("routes every test, both medicines and the admission from one long mixed-voice line, past the old cut at 1000 characters", async () => {
    const seen: string[] = [];
    const b = boot((s) => { seen.push(s); return parted(s); });
    try {
      const task = await arrival(b);
      await sayOn(b, task, "My name is Amaka Okafor.", MIXED);
      await sayOn(b, task, LONG, MIXED);
      expect(seen.length).toBeGreaterThan(5);
      expect(seen.every((s) => s.split(/\s+/).length <= 60)).toBe(true);
      expect(proposed(b, task, "order_test").map((a) => a.args["test"])).toEqual(["fbc", "malaria", "urinalysis"]);
      // A medicine missing its count in a voice that is not the owner's is refused in words, never asked of him (4 Nov rehearsal).
      expect(b.rt.view(task)!.questions.map((q) => q.text).filter((q) => q.startsWith("How many"))).toEqual([]);
      expect(b.rt.view(task)!.notes.map((n) => n.text)).toContain("I could not match that voice to you, so nothing was sent. Say it yourself.");
      expect(proposed(b, task, "request_admission").map((a) => a.args["reason"])).toEqual(["severe malaria"]);
      const notes = of(b, "record_clerking").map((w) => [w.args["section"], String(w.args["text"])]);
      expect(notes.find(([s]) => s === "assessment")?.[1]).not.toMatch(/paracetamol|urinalysis|fever for three days/);
      expect(notes.find(([s]) => s === "patient_reported")?.[1]).not.toMatch(/allergic|examination|paracetamol/);
    } finally { await b.rt.stop(); }
  });

  it("never takes the owner's second dose of one medicine as the count asked for the first", async () => {
    const b = boot(parted);
    try {
      const task = await arrival(b);
      await sayOn(b, task, "My name is Amaka Okafor.", MIXED);
      await sayOn(b, task, LONG);
      expect(b.rt.view(task)!.questions.map((q) => q.text).filter((q) => q.startsWith("How many"))).toEqual(["How many should the pharmacy give for IV paracetamol 120 mg? Say the number.", "How many should the pharmacy give for IV paracetamol 1 g? Say the number."]);
      expect(of(b, "order_test").map((w) => w.args["test"])).toEqual(["fbc", "malaria", "urinalysis"]);
    } finally { await b.rt.stop(); }
  });
});

describe("EMG 2: a held part never stalls the rest", () => {
  it("holds for whom only the part naming another live patient, and the vitals and later lines go ahead", async () => {
    const b = boot(parted);
    try {
      const other = await arrival(b, "Unknown arrival 14:36");
      await sayOn(b, other, "My name is Grace Okafor.", MIXED);
      b.clock.now += 60_000;
      const task = await arrival(b, "Unknown arrival 14:37");
      await sayOn(b, task, "Madam Okafor please don't worry we will look after you today and everything is going to be fine okay your pulse is about 110 the blood pressure is quite low it's 90 over 60 your temperature is about 38.5 hmm your SpO2 is about 94 percent and your respiratory rate is 24");
      const v = b.rt.view(task)!;
      expect(v.questions.map((q) => q.answers)).toEqual([["Unknown arrival 14:37", "Grace Okafor"]]);
      expect(of(b, "record_triage_vitals").map((w) => [w.args["patient_id"], w.args["pulse"]])).toEqual([[patientOf(b, task), 110]]);
      await sayOn(b, task, "uh well my initial diagnosis for you is that you have severe malaria");
      expect(of(b, "record_clerking").filter((w) => w.args["patient_id"] === patientOf(b, task)).map((w) => w.args["section"])).toContain("assessment");
    } finally { await b.rt.stop(); }
  });

  it("says and drops one line that cannot be decided, and the encounter takes the next line", async () => {
    const b = boot(parted);
    try {
      const task = await arrival(b);
      const real = b.port.orderables.bind(b.port);
      b.port.orderables = () => { throw new Error("orderables unreadable"); };
      await sayOn(b, task, "okay um what we'll do now is to send a request to the lab Nurse please come take a sample the lab needs to do a full blood count test the malaria parasite test and urinalysis");
      b.port.orderables = real;
      expect(b.rt.view(task)!.state).not.toBe("failed");
      expect(b.rt.view(task)!.notes.map((n) => n.text)).toContain("I could not act on that line, so nothing was written from it. Say it again if it still stands.");
      await sayOn(b, task, "okay your pulse is about 110 the blood pressure is quite low it's 90 over 60 your temperature is about 38.5 hmm your SpO2 is about 94 percent and your respiratory rate is 24");
      expect(of(b, "record_triage_vitals").map((w) => w.args["pulse"])).toEqual([110]);
    } finally { await b.rt.stop(); }
  });
});

describe("D47: a stated initial diagnosis is recorded on the owner's confirm, a hedged one stays assessment", () => {
  it("asks to confirm severe malaria from the 14:39 line in the owner's voice and records it on his confirm", async () => {
    const b = boot(parted);
    try {
      const task = await arrival(b);
      await sayOn(b, task, "uh well my initial diagnosis for you is that you have severe malaria");
      expect(b.rt.view(task)!.asked.map((q) => q.text)).toEqual([expect.stringMatching(/^Record the diagnosis: "severe malaria"\. Say confirm to record this diagnosis\./)]);
      expect(of(b, "record_diagnosis")).toEqual([]);
      await sayOn(b, task, "Confirm.");
      expect(of(b, "record_diagnosis").map((w) => w.args["diagnosis"])).toEqual(["severe malaria"]);
      expect(of(b, "record_clerking").map((w) => w.args["section"])).toContain("assessment");
    } finally { await b.rt.stop(); }
  });

  it("keeps a hedged diagnosis in the assessment and asks nothing", async () => {
    const hedged = "my working diagnosis is that she might have severe malaria";
    const b = boot((s) => (s === hedged ? [{ class: "finding", section: "assessment", words: hedged, confidence: 0.9 }] : ASIDE));
    try {
      const task = await arrival(b);
      await sayOn(b, task, hedged);
      expect(b.rt.view(task)!.actions.filter((a) => a.kind === "record_diagnosis")).toEqual([]);
      expect(of(b, "record_clerking").map((w) => [w.args["section"], w.args["text"]])).toEqual([["assessment", hedged]]);
    } finally { await b.rt.stop(); }
  });

  it("records the diagnosis at once, asking nothing, when the door names no confirm kinds (Samuel, 4 Nov)", async () => {
    class NoConfirmFake extends EmgFake { confirmKinds(): readonly string[] { return []; } }
    const port = new NoConfirmFake();
    const b = { ...clerkBoot(parted, { port, clock: { now: Date.parse("2026-11-03T13:36:39Z") } }), port };
    try {
      const task = await arrival(b);
      await sayOn(b, task, "uh well my initial diagnosis for you is that you have severe malaria");
      expect(b.rt.view(task)!.asked).toEqual([]);
      expect(of(b, "record_diagnosis").map((w) => w.args["diagnosis"])).toEqual(["severe malaria"]);
    } finally { await b.rt.stop(); }
  });
});

describe("D48: no yes before a test or drug when the line holds the owner's voice", () => {
  const TESTS = "okay um what we'll do now is to send a request to the lab Nurse please come take a sample the lab needs to do a full blood count test the malaria parasite test and urinalysis";
  const windows = (...ns: number[]): Voiceprint => ({ ...print(ns[0]!), segments: ns.map((n) => ({ vector: [n], ms: 20 })) });

  it("sends the tests at once from a mixed line with an owner window, under that window's token", async () => {
    const b = boot(parted);
    try {
      const task = await arrival(b);
      await sayOn(b, task, TESTS, windows(5, 1));
      expect(of(b, "order_test").map((w) => w.args["test"]).sort()).toEqual(["fbc", "malaria", "urinalysis"]);
      // Tests on an emergency arrival go urgent, so they head the lab's queue.
      expect(of(b, "order_test").every((w) => w.args["priority"] === "urgent")).toBe(true);
      for (const w of of(b, "order_test")) expect(w.prov.voice?.authorisation).toMatch(/~v1\./);
      expect(b.rt.view(task)!.asked).toEqual([]);
    } finally { await b.rt.stop(); }
  });

  it("sends the emergency admission from a mixed line with an owner window, with no yes asked", async () => {
    const admit = "immediately admit her in the in the ward for severe malaria obviously and do four hourly obs";
    const b = boot((said) => (said === admit ? [ins("admit_patient", { words: "admit her in the in the ward for severe malaria" })] : ASIDE));
    try {
      const task = await arrival(b);
      await sayOn(b, task, admit, windows(5, 1));
      expect(of(b, "request_admission")).toHaveLength(1);
      expect(b.rt.view(task)!.asked).toEqual([]);
    } finally { await b.rt.stop(); }
  });

  it("releases a care plan item said on a mixed line, as it does an order", () => {
    expect(MIXED_OWNER_KINDS.has("add_care_plan_item")).toBe(true);
  });

  it("still asks his yes when no window of the line matched him", async () => {
    const b = boot(parted);
    try {
      const task = await arrival(b);
      await sayOn(b, task, TESTS, windows(1, 1));
      expect(of(b, "order_test")).toEqual([]);
      expect(b.rt.view(task)!.asked.map((q) => q.text).every((q) => /could not match the voice to you, so it waits until you say yes yourself/.test(q))).toBe(true);
      expect(b.rt.view(task)!.asked).toHaveLength(3);
    } finally { await b.rt.stop(); }
  });
});

describe("R-27: a new arrival said while another patient is open", () => {
  it("opens the new arrival from the clinician's own words whatever patient the page names, and files the line there", async () => {
    const b = boot(() => ASIDE);
    try {
      // The doctor is on an ordinary open patient's page when the next arrival is announced.
      const first = (await b.rt.open(DOC, { patient_id: PAT })).task_id;
      const line = "So I have a new arrival in A and E, a man of about 50 with chest pain";
      const r = await b.rt.say({ owner: DOC, target: { patient_id: PAT }, text: line, source: "audio", voiceprint: OWNER, spoken_at: new Date(b.clock.now).toISOString() });
      await b.rt.settled();
      expect(r.task_id).not.toBe(first);
      expect(b.rt.view(r.task_id)!.unidentified).toBe(true);
      expect(of(b, EMERGENCY_KIND)).toHaveLength(1);
      expect((b.rt.view(first)!.transcript ?? []).map((x: { text: string }) => x.text)).not.toContain(line);
    } finally { await b.rt.stop(); }
  });
});

describe("a ward's name alone admits nobody", () => {
  it("drops the scrap 'A and E' the ear cut off an arrival line instead of admitting on it", async () => {
    const b = boot((s) => (s === "A and E" ? [ins("admit_patient", { words: "A and E", ward: "a_and_e" })] : ASIDE));
    try {
      const task = await arrival(b);
      await sayOn(b, task, "A and E");
      expect(of(b, "admit_patient")).toEqual([]);
      expect(of(b, "request_admission")).toEqual([]);
      expect(b.rt.view(task)!.asked).toEqual([]);
    } finally { await b.rt.stop(); }
  });
});

describe("what one line carries, read part by part", () => {
  it("stops a diagnosis where the sentence turns to what comes next", () => {
    expect(statedDiagnosis("my initial diagnosis is you have severe malaria but we need to do a test")).toBe("severe malaria");
    expect(statedDiagnosis("my working diagnosis is severe malaria")).toBe("severe malaria");
  });
  it("reads each medicine from its own clause, so two in one line never share a schedule", () => {
    expect(prescriptionSaid("Start IV paracetamol one gram now.", { dose: "1 g" })).toMatchObject({ quantity: 1, frequency: null });
    expect(prescriptionSaid("Then ceftriaxone one gram IV twice a day for five days.", { dose: "1 g" })).toMatchObject({ frequency: 2, duration_days: 5, quantity: 10 });
  });
  it("takes a dose said in words, checked against the whole line when the clause's words keep the amount out", () => {
    expect(prescriptionSaid("start IV paracetamol one gram now", { dose: "one gram" })).toMatchObject({ dose: "1 gram", quantity: 1, route: "iv" });
    expect(prescriptionSaid("then ceftriaxone IV twice a day for five days", { dose: "one gram" }, "start IV paracetamol one gram now then ceftriaxone one gram IV twice a day for five days")).toMatchObject({ dose: "1 gram", frequency: 2, duration_days: 5, quantity: 10 });
    expect(prescriptionSaid("paracetamol twice a day", { dose: "2 g" }, "give paracetamol twice a day")).toMatchObject({ dose: null, frequency: 2 });
  });
  it("judges hedging on the diagnosis sentence, never on an earlier finding", () => {
    expect(statedDiagnosis("uh you're febrile and drowsy your neck is not stiff the abdomen is soft I think my working diagnosis is severe malaria")).toBe("severe malaria");
    expect(statedDiagnosis("my working diagnosis is that she might have severe malaria")).toBeNull();
    expect(statedDiagnosis("the neck is not stiff so a possible diagnosis is meningitis")).toBeNull();
    expect(statedDiagnosis("maybe her working diagnosis is malaria")).toBeNull();
  });
});

describe("what the gate leaves out of a line it read whole", () => {
  const VITALS = "her temperature is 38.5, pulse 110, respiratory rate 24, blood pressure 90 over 60, SpO2 94 percent.";
  it("fills the SpO2 the line names once into the vitals clause the gate left it out of", async () => {
    const b = boot((s) => (/SpO2 94 percent/.test(s) ? [ins("record_triage_vitals", { words: VITALS, temp_c: 38.5, pulse: 110, resp_rate: 24, bp: "90/60" })] : ASIDE));
    try {
      const task = await arrival(b);
      await sayOn(b, task, VITALS);
      expect(of(b, "record_triage_vitals").map((w) => [w.args["temp_c"], w.args["pulse"], w.args["resp_rate"], w.args["bp"], w.args["spo2"]])).toEqual([["38.5", 110, 24, "90/60", 94]]);
      expect(b.rt.view(task)!.questions).toEqual([]);
    } finally { await b.rt.stop(); }
  });

  it("joins a reason said after a pause to the admission line still being decided", async () => {
    const ADMIT = "please admit her as well in the A and E ward";
    const b = boot((s) => (s === ADMIT ? [ins("admit_patient", { words: ADMIT, ward: "a_and_e" })] : ASIDE));
    try {
      const task = await arrival(b);
      const say = (text: string, ms: number) => b.rt.say({ owner: DOC, target: { patient_id: patientOf(b, task) }, text, source: "audio", voiceprint: OWNER, spoken_at: new Date(b.clock.now + ms).toISOString() }, task);
      await Promise.all([say(ADMIT, 0), say("for severe malaria", 2000)]);
      await b.rt.settled();
      expect([...of(b, "admit_patient"), ...of(b, "request_admission")].map((w) => w.args["reason"])).toEqual(["severe malaria"]);
      expect(of(b, "record_clerking").map((w) => w.args["text"])).not.toContain("for severe malaria");
      expect(b.rt.view(task)!.questions).toEqual([]);
    } finally { await b.rt.stop(); }
  });
});

describe("EMJ: a page that still names a closed patient", () => {
  it("drops the stale patient and opens the new arrival the line asks for", async () => {
    const b = boot(() => ASIDE);
    const gone = "99999999-0000-4000-8000-000000000001";
    const resolve = b.port.resolve.bind(b.port);
    // The real port refuses a patient no longer on the list it reads with unknown_target.
    b.port.resolve = async (t: EmrTarget) => { if (t.patient_id === gone || t.admission_id === gone) throw new EmrPortError("unknown_target", "the patient is not in the list the agent can read"); return resolve(t); };
    try {
      const r = await b.rt.say({ owner: DOC, target: { patient_id: gone }, text: "New unknown arrival in A and E, a woman about 30", source: "audio", voiceprint: OWNER, spoken_at: new Date(b.clock.now).toISOString() });
      await b.rt.settled();
      const v = b.rt.view(r.task_id)!;
      expect(v.unidentified).toBe(true);
      expect(v.patient_id).not.toBe(gone);
      expect(of(b, EMERGENCY_KIND)).toHaveLength(1);
      // Any other line on the closed patient is refused in words, never as a bare read error.
      await expect(b.rt.say({ owner: DOC, target: { patient_id: gone }, text: "Pulse 110", source: "audio", voiceprint: OWNER, spoken_at: new Date(b.clock.now).toISOString() })).rejects.toThrow(/visit is closed/);
      // A listening session on the closed patient still opens, with a bare context, so its words reach say() instead of failing the stream.
      const prov = { owner: DOC, evidence: "transcript:test", spoken_at: new Date(b.clock.now).toISOString() };
      expect(await b.rt.listenContext({ patient_id: gone }, prov)).toEqual({ admission_id: "", patient_id: gone, visit_id: null, label: "the patient", facts: {}, keywords: [] });
      await expect(b.rt.listenContext({ admission_id: gone }, prov)).rejects.toThrow();
    } finally { await b.rt.stop(); }
  });
});

describe("what loose talk must never do (review, 4 Nov)", () => {
  it("opens no arrival for a question or a forecast, nor for a new arrival said in another voice", async () => {
    const b = boot(() => ASIDE);
    try {
      const task = await arrival(b);
      await sayOn(b, task, "Is there another arrival?");
      await sayOn(b, task, "Another arrival is coming at three.");
      await sayOn(b, task, "I have a new arrival in A and E, a man of about 40.", MIXED);
      expect(of(b, EMERGENCY_KIND)).toHaveLength(1);
    } finally { await b.rt.stop(); }
  });

  it("never joins a typed reason fragment to a spoken admission line", async () => {
    const ADMIT = "please admit her as well in the A and E ward";
    const b = boot((s) => (s === ADMIT ? [ins("admit_patient", { words: ADMIT, ward: "a_and_e" })] : ASIDE));
    try {
      const task = await arrival(b);
      const spoken = b.rt.say({ owner: DOC, target: { patient_id: patientOf(b, task) }, text: ADMIT, source: "audio", voiceprint: OWNER, spoken_at: new Date(b.clock.now).toISOString() }, task);
      const typed = b.rt.say({ owner: DOC, target: { patient_id: patientOf(b, task) }, text: "for severe malaria", source: "text", spoken_at: new Date(b.clock.now + 2000).toISOString() }, task);
      await Promise.all([spoken, typed]);
      await b.rt.settled();
      expect([...of(b, "admit_patient"), ...of(b, "request_admission")].map((w) => w.args["reason"])).toEqual(["Not yet stated"]);
    } finally { await b.rt.stop(); }
  });

  it("says why when an admission is asked without an admission word", async () => {
    const line = "send her upstairs please";
    const b = boot((s) => (s === line ? [ins("admit_patient", { words: line, ward: "a_and_e" })] : ASIDE));
    try {
      const task = await arrival(b);
      await sayOn(b, task, line);
      expect([...of(b, "admit_patient"), ...of(b, "request_admission")]).toEqual([]);
      expect(b.rt.view(task)!.notes.map((n) => n.text)).toContainEqual(expect.stringMatching(/without an admission word/));
    } finally { await b.rt.stop(); }
  });
});

describe("a line the fallback ear rescued", () => {
  const VITALS = "pulse 110";
  const ambient = (second_reading: "meta_rest" | "none") => ({ session_id: "s-1", seqs: [1], raw_text: VITALS, ended_at: "2026-11-03T13:36:40Z", final_at: "2026-11-03T13:36:41Z", trailing_silence_ms: 0, finished_by: "fallback_parakeet", second_reading });
  it("writes no number without an independent second ear, and writes it when the Meta ear reads it too", async () => {
    const b = boot((s) => (s === VITALS ? [ins("record_triage_vitals", { words: VITALS, pulse: 110 })] : ASIDE));
    try {
      const task = await arrival(b);
      const say = (second: "meta_rest" | "none") => b.rt.say({ owner: DOC, target: { patient_id: patientOf(b, task) }, text: VITALS, source: "audio", voiceprint: OWNER, spoken_at: new Date(b.clock.now).toISOString(), ambient: ambient(second) }, task);
      await say("none");
      await b.rt.settled();
      expect(of(b, "record_triage_vitals")).toEqual([]);
      expect(b.rt.view(task)!.notes.map((n) => n.text)).toContainEqual(expect.stringMatching(/fallback ear only/));
      await say("meta_rest");
      await b.rt.settled();
      expect(of(b, "record_triage_vitals").map((w) => w.args["pulse"])).toEqual([110]);
    } finally { await b.rt.stop(); }
  });
});

describe("a bare name on an unnamed arrival (live run, 4 Nov)", () => {
  it("takes the name typed as the answer to the name question, and a name said alone after a cut 'her name is'", async () => {
    const b = boot((s) => (s === "her name is" ? [{ class: "unclear", words: "her name is", question: "What is the patient's name?", confidence: 0.6 }] : ASIDE));
    try {
      const task = await arrival(b);
      await sayOn(b, task, "her name is");
      const q = b.rt.view(task)!.questions[0]!;
      await b.rt.say({ owner: DOC, target: { patient_id: patientOf(b, task) }, text: "Ngozi Ada", source: "text", question_id: q.question_id, spoken_at: new Date(b.clock.now).toISOString() }, task);
      await b.rt.settled();
      expect(of(b, IDENTITY_KIND).map((w) => w.args["name"])).toEqual(["Ngozi Ada"]);
      expect(b.rt.view(task)!.questions).toEqual([]);
    } finally { await b.rt.stop(); }
  });
  it("takes a name said alone right after the clinician asks what the name is (Grace, 4 Nov)", async () => {
    const b = boot(() => ASIDE);
    try {
      const task = await arrival(b);
      await sayOn(b, task, "What's your name?");
      await sayOn(b, task, "Grace Carter", MIXED);
      expect(of(b, IDENTITY_KIND).map((w) => w.args["name"])).toEqual(["Grace Carter"]);
    } finally { await b.rt.stop(); }
  });
});

describe("vitals the gate split into several clauses (live run, 4 Nov)", () => {
  const LINE = "Her pulse is 110. Her respiratory rate is 24. Blood pressure 90 over 60. SpO2 94%.";
  it("writes one triage row with every value when the gate returns four vitals clauses of two kinds", async () => {
    const b = boot((s) => (s === LINE ? [ins("record_observation", { words: "Her pulse is 110.", pulse: 110 }), ins("record_observation", { words: "Her respiratory rate is 24.", resp_rate: 24 }), ins("record_observation", { words: "Blood pressure 90 over 60.", bp: "90/60" }), ins("record_triage_vitals", { words: "SpO2 94%.", spo2: 94 })] : ASIDE));
    try {
      const task = await arrival(b);
      await sayOn(b, task, LINE);
      expect(of(b, "record_triage_vitals").map((w) => [w.args["pulse"], w.args["resp_rate"], w.args["bp"], w.args["spo2"]])).toEqual([[110, 24, "90/60", 94]]);
    } finally { await b.rt.stop(); }
  });
});

// Samuel, 4 Nov: he talks to the patient as a doctor does, and arrivals, admissions, names and orders come in ordinary words.
class NaturalFake extends EmgFake {
  override orderables() {
    return {
      tests: { fbc: ["FBC", "full blood count"], malaria: ["malaria parasite", "malaria test"], urinalysis: ["urinalysis", "urine"] },
      drugs: { paracetamol_iv: { words: ["IV paracetamol", "paracetamol"], controlled: false }, paracetamol_oral: { words: ["paracetamol tablets"], controlled: false }, ceftriaxone: { words: ["ceftriaxone"], controlled: false } }
    };
  }
}
// One line said on a fresh arrival, with the gate's answer for that line only.
async function onArrival(line: string, clauses: W[], v: Voiceprint | null = OWNER) {
  const port = new NaturalFake();
  const b = { ...clerkBoot((s) => (s === line ? clauses : ASIDE), { port, clock: { now: Date.parse("2026-11-03T13:36:39Z") } }), port };
  const task = await arrival(b);
  if (v) await sayOn(b, task, line, v);
  else { await b.rt.say({ owner: DOC, target: { patient_id: patientOf(b, task) }, text: line, source: "text", spoken_at: new Date(b.clock.now).toISOString() }, task); await b.rt.settled(); }
  return { b, task };
}
const notes = (b: B, section: string) => of(b, "record_clerking").filter((w) => w.args["section"] === section).map((w) => String(w.args["text"]));

describe("NATURAL 1: the owner speaks to the patient as you", () => {
  it("writes history and examination said to the patient in the third person, even when the gate calls the history the patient's", async () => {
    const hist = "you have had this fever for three days";
    const a = await onArrival(hist, [{ class: "patient_reported", words: hist, confidence: 0.9 }]);
    try { expect(notes(a.b, "history")).toEqual(["Has had this fever for three days"]); expect(notes(a.b, "patient_reported")).toEqual([]); } finally { await a.b.rt.stop(); }
    const exam = "you are pale and febrile";
    const e = await onArrival(exam, [{ class: "finding", section: "examination", words: exam, confidence: 0.9 }]);
    try { expect(notes(e.b, "examination")).toEqual(["Is pale and febrile"]); } finally { await e.b.rt.stop(); }
    const said = await onArrival(hist, [{ class: "finding", section: "history", words: hist, confidence: 0.9 }]);
    try { expect(notes(said.b, "history")).toEqual(["Has had this fever for three days"]); } finally { await said.b.rt.stop(); }
  });

  it("negative control: the same words in a voice that is not the owner's stay where the gate put them", async () => {
    const hist = "you have had this fever for three days";
    const a = await onArrival(hist, [{ class: "patient_reported", words: hist, confidence: 0.9 }], MIXED);
    try { expect(notes(a.b, "history")).toEqual([]); expect(notes(a.b, "patient_reported")).toEqual([hist]); } finally { await a.b.rt.stop(); }
  });

  it("asks to confirm 'you have severe malaria' in the owner's voice and records it on his confirm, from a finding or an instruction", async () => {
    const line = "you have severe malaria";
    for (const clauses of [[{ class: "finding", section: "assessment", words: line, confidence: 0.9 }], [ins("record_diagnosis", { words: line, text: "severe malaria" })]] as W[][]) {
      const { b, task } = await onArrival(line, clauses);
      try {
        expect(b.rt.view(task)!.asked.map((q) => q.text)).toEqual([expect.stringMatching(/^Record the diagnosis: "severe malaria"\. Say confirm/)]);
        await sayOn(b, task, "Confirm.");
        expect(of(b, "record_diagnosis").map((w) => w.args["diagnosis"])).toEqual(["severe malaria"]);
      } finally { await b.rt.stop(); }
    }
  });

  it("negative control: another voice saying 'you have severe malaria' records no diagnosis, and a hedge or history is no diagnosis", async () => {
    const line = "you have severe malaria";
    const { b } = await onArrival(line, [ins("record_diagnosis", { words: line, text: "severe malaria" })], MIXED);
    try {
      expect(of(b, "record_diagnosis")).toEqual([]);
      expect(b.rt.view(b.rt.views(DOC).at(-1)!.task_id)!.notes.map((n) => n.text)).toContainEqual(expect.stringMatching(/no diagnosis was recorded/));
    } finally { await b.rt.stop(); }
    expect(statedDiagnosis("you have severe malaria")).toBe("severe malaria");
    expect(statedDiagnosis("you might have severe malaria")).toBeNull();
    expect(statedDiagnosis("you have severe malaria or typhoid")).toBeNull();
    expect(statedDiagnosis("you have had this fever for three days")).toBeNull();
  });

  it("admits from 'we are admitting you to the A and E ward for severe malaria', 'you will stay with us tonight' and 'we are keeping you in'", async () => {
    const ward = "we are admitting you to the A and E ward for severe malaria";
    const a = await onArrival(ward, [ins("admit_patient", { words: ward, ward: "a_and_e", text: "severe malaria" })]);
    try { expect(of(a.b, "admit_patient").map((w) => [w.args["ward"], w.args["reason"]])).toEqual([["a_and_e", "severe malaria"]]); } finally { await a.b.rt.stop(); }
    for (const line of ["you will stay with us tonight", "we are keeping you in"]) {
      const { b } = await onArrival(line, [ins("admit_patient", { words: line })]);
      try { expect(of(b, "request_admission").map((w) => w.args["reason"])).toEqual([NO_ADMISSION_REASON]); } finally { await b.rt.stop(); }
    }
    expect(admissionReason("we are keeping you in because you have severe malaria")).toBe("severe malaria");
  });

  it("sends 'I am sending your blood for a full blood count' and prescribes what the owner tells the patient he will get", async () => {
    const test = "I am sending your blood for a full blood count";
    const t = await onArrival(test, [ins("order_test", { words: test, test: "fbc" })]);
    try { expect(of(t.b, "order_test").map((w) => w.args["test"])).toEqual(["fbc"]); } finally { await t.b.rt.stop(); }
    const now = "I will give you IV paracetamol one gram now";
    const p = await onArrival(now, [ins("prescribe", { words: now, drug: "paracetamol_iv", dose: "1 g", route: "iv" })]);
    try { expect(of(p.b, "prescribe").map((w) => [w.args["drug"], w.args["quantity"], w.args["route"]])).toEqual([["paracetamol_iv", 1, "iv"]]); } finally { await p.b.rt.stop(); }
    const course = "you will get ceftriaxone one gram twice a day for five days";
    const c = await onArrival(course, [ins("prescribe", { words: course, drug: "ceftriaxone", dose: "1 g" })]);
    try { expect(of(c.b, "prescribe").map((w) => [w.args["drug"], w.args["frequency"], w.args["duration_days"], w.args["quantity"]])).toEqual([["ceftriaxone", 2, 5, 10]]); } finally { await c.b.rt.stop(); }
  });

  it("writes no 'you' it cannot place, so a question to the patient stays as said", () => {
    expect(addressSwap("You were vomiting. Your chest is clear.")).toBe("Was vomiting. Chest is clear.");
    expect(addressSwap("Did you take anything for it?")).toBe("Did you take anything for it?");
  });
});

describe("NATURAL 2: an arrival in ordinary words", () => {
  const LINES = ["A new patient has just come in", "Someone has just been brought in to A and E", "We have a new case in emergency", "A woman has just walked in with fever for three days"];
  const announce = async (b: B, text: string, v: Voiceprint = OWNER) => { const r = await b.rt.say({ owner: DOC, target: { patient_id: PAT }, text, source: "audio", voiceprint: v, spoken_at: new Date(b.clock.now).toISOString() }); await b.rt.settled(); return r; };
  it("opens one arrival for each, in the owner's voice, whatever patient the page names", async () => {
    // Each on its own runtime, since a second arrival within ten seconds is taken as the device's own press.
    for (const line of LINES) {
      const b = boot(() => ASIDE);
      try {
        await b.rt.open(DOC, { patient_id: PAT });
        const r = await announce(b, line);
        expect([line, b.rt.view(r.task_id)!.unidentified, of(b, EMERGENCY_KIND).length]).toEqual([line, true, 1]);
      } finally { await b.rt.stop(); }
    }
  });

  it("negative control: a question, a forecast, another voice, a relative or a result opens nothing", async () => {
    const b = boot(() => ASIDE);
    try {
      await b.rt.open(DOC, { patient_id: PAT });
      for (const line of ["Has a new patient just come in?", "A new patient is coming in later", "Her husband has just come in", "A result from the lab has just come in"]) await announce(b, line);
      await announce(b, "A woman has just walked in with fever", MIXED);
      expect(of(b, EMERGENCY_KIND)).toEqual([]);
    } finally { await b.rt.stop(); }
  });
});

describe("NATURAL 3: an admission without the word admit", () => {
  it("admits on 'hospitalise her', 'keep her overnight' and 'she needs to stay'", async () => {
    for (const line of ["hospitalise her for severe malaria", "keep her overnight", "she needs to stay"]) {
      const { b } = await onArrival(line, [ins("admit_patient", { words: line })]);
      try { expect(of(b, "request_admission")).toHaveLength(1); } finally { await b.rt.stop(); }
    }
  });

  it("negative control: the same admission in another voice waits for the owner's yes", async () => {
    const { b, task } = await onArrival("keep her overnight", [ins("admit_patient", { words: "keep her overnight" })], MIXED);
    try { expect(of(b, "request_admission")).toEqual([]); expect(b.rt.view(task)!.asked.map((q) => q.text)).toEqual([expect.stringMatching(/could not match the voice to you/)]); } finally { await b.rt.stop(); }
  });
});

describe("NATURAL 4: a name in ordinary words", () => {
  it("names the arrival from each way of saying it in the owner's voice", async () => {
    for (const [line, name] of [["This is Ngozi Ada.", "Ngozi Ada"], ["The patient is Ngozi Ada.", "Ngozi Ada"], ["You are Ngozi Ada, is that right?", "Ngozi Ada"], ["Call her Ngozi.", "Ngozi"], ["Ngozi Ada is her name.", "Ngozi Ada"]] as const) {
      const { b } = await onArrival(line, []);
      try { expect(of(b, IDENTITY_KIND).map((w) => w.args["name"])).toEqual([name]); } finally { await b.rt.stop(); }
    }
  });

  it("negative control: the owner's own 'my name is' and a clinician's title name nobody", async () => {
    for (const line of ["My name is Ngozi Ada.", "This is Doctor Bola Ade."]) {
      const { b } = await onArrival(line, []);
      try { expect(of(b, IDENTITY_KIND)).toEqual([]); } finally { await b.rt.stop(); }
    }
  });
});

describe("NATURAL 5: orders in ordinary words", () => {
  it("orders the tests and prescribes from plain talk in the owner's voice", async () => {
    const both = "let's do a full blood count and a malaria test";
    const t = await onArrival(both, [ins("order_test", { words: "let's do a full blood count", test: "fbc" }), ins("order_test", { words: "and a malaria test", test: "malaria" })]);
    try { expect(of(t.b, "order_test").map((w) => w.args["test"])).toEqual(["fbc", "malaria"]); } finally { await t.b.rt.stop(); }
    for (const [line, test] of [["run an FBC", "fbc"], ["check her urine", "urinalysis"]] as const) {
      const { b } = await onArrival(line, [ins("order_test", { words: line, test })]);
      try { expect(of(b, "order_test").map((w) => w.args["test"])).toEqual([test]); } finally { await b.rt.stop(); }
    }
    const course = "put her on ceftriaxone one gram IV twice daily for five days";
    const c = await onArrival(course, [ins("prescribe", { words: course, drug: "ceftriaxone", dose: "1 g", route: "iv" })]);
    try { expect(of(c.b, "prescribe").map((w) => [w.args["drug"], w.args["route"], w.args["frequency"], w.args["duration_days"], w.args["quantity"]])).toEqual([["ceftriaxone", "iv", 2, 5, 10]]); } finally { await c.b.rt.stop(); }
    const now = "she can have paracetamol one gram IV now";
    const p = await onArrival(now, [ins("prescribe", { words: now, drug: "paracetamol_iv", dose: "1 g", route: "iv" })]);
    try { expect(of(p.b, "prescribe").map((w) => [w.args["drug"], w.args["quantity"]])).toEqual([["paracetamol_iv", 1]]); } finally { await p.b.rt.stop(); }
  });

  it("negative control: another voice or a typed line holds the order, and a test the line never names is asked, not sent", async () => {
    const line = "run an FBC";
    for (const v of [MIXED, null]) {
      const { b, task } = await onArrival(line, [ins("order_test", { words: line, test: "fbc" })], v);
      try { expect(of(b, "order_test")).toEqual([]); expect(b.rt.view(task)!.asked).toHaveLength(1); } finally { await b.rt.stop(); }
    }
    const { b, task } = await onArrival("let's check her bloods", [ins("order_test", { words: "let's check her bloods", test: "malaria" })]);
    try { expect(of(b, "order_test")).toEqual([]); expect(b.rt.view(task)!.asked.map((q) => q.text)).toEqual([expect.stringMatching(/^Which test should I send\?/)]); } finally { await b.rt.stop(); }
  });
});

describe("the strip after a run (Samuel, 4 Nov)", () => {
  const ADMIT = "please admit her as well in the A and E ward";
  const admitGate = (s: string) => (s === ADMIT ? [ins("admit_patient", { words: ADMIT, ward: "a_and_e" })] : ASIDE);
  it("lets a typed no drop a held item, while a typed yes is refused without re-asking", async () => {
    const b = boot(admitGate);
    try {
      const task = await arrival(b);
      await sayOn(b, task, ADMIT, MIXED);
      const held = b.rt.view(task)!.questions;
      expect(held).toHaveLength(1);
      const typed = (text: string) => b.rt.say({ owner: DOC, target: { patient_id: patientOf(b, task) }, text, source: "text", question_id: held[0]!.question_id, spoken_at: new Date(b.clock.now).toISOString() }, task);
      await typed("yes");
      await b.rt.settled();
      expect([...of(b, "admit_patient"), ...of(b, "request_admission")]).toEqual([]);
      expect(b.rt.view(task)!.questions.map((q) => q.question_id)).toEqual([held[0]!.question_id]);
      await typed("no");
      await b.rt.settled();
      expect(b.rt.view(task)!.questions).toEqual([]);
      expect(b.rt.view(task)!.actions.filter((a) => a.kind === "admit_patient").map((a) => a.state)).toEqual(["cancelled"]);
    } finally { await b.rt.stop(); }
  });

  it("writes no 'not mine to do' note when the gate wants to record a name the name rule already took", async () => {
    const line = "My name is David Miller, David Miller";
    const b = boot((s) => (/David Miller/.test(s) ? [{ class: "instruction", kind: "record_identity", words: s, confidence: 0.9 } as unknown as W] : ASIDE));
    try {
      const task = await arrival(b);
      await sayOn(b, task, line, MIXED);
      expect(of(b, IDENTITY_KIND).map((w) => w.args["name"])).toEqual(["David Miller"]);
      expect(b.rt.view(task)!.notes.map((n) => n.text).filter((t) => /Not mine to do/.test(t))).toEqual([]);
    } finally { await b.rt.stop(); }
  });

  it("answers a second admission with a note instead of asking the door again", async () => {
    const b = boot(admitGate);
    try {
      const task = await arrival(b);
      await sayOn(b, task, ADMIT);
      await sayOn(b, task, ADMIT);
      expect([...of(b, "admit_patient"), ...of(b, "request_admission")]).toHaveLength(1);
      expect(b.rt.view(task)!.notes.map((n) => n.text)).toContainEqual(expect.stringMatching(/Already admitted/));
    } finally { await b.rt.stop(); }
  });
});

describe("DONE: the owner says they are done with this patient (Samuel, 4 Nov)", () => {
  const RESULT_NOTE: W[] = [ins("record_note", { note_type: "progress", text: "blood count back, reviewed", after: "result" })];
  const script = (s: string) => (/blood count comes back/.test(s) ? RESULT_NOTE : ASIDE);
  const say = async (b: B, text: string, v: Voiceprint = OWNER) => { const r = await b.rt.say({ owner: DOC, target: { patient_id: PAT }, text, source: "audio", voiceprint: v, spoken_at: new Date(b.clock.now).toISOString() }); await b.rt.settled(); return r; };
  const notes = (b: B, task: string) => b.rt.view(task)!.notes.map((n: { text: string }) => n.text);

  it("reads the done phrase whole, with an optional wake or okay, and never a negation or a question", async () => {
    const { doneLine } = await import("../src/emr/runtime.js");
    for (const line of ["I'm done with this patient", "Hey Pisgah, I'm done with this patient.", "okay we're done with her", "We're done with them", "That's all for this patient", "I'm finished with this patient", "finished with him"]) expect([line, doneLine(line)]).toEqual([line, { next: null }]);
    for (const line of ["I'm not done with this patient", "Are we done with this patient?", "I'm done with this patient?", "I'm done with this patient, give her paracetamol", "We are done with the morphine"]) expect([line, doneLine(line)]).toEqual([line, null]);
    expect(doneLine("I'm done with this patient, I have another one, a woman about 30 with fever")).toEqual({ next: "I have another one, a woman about 30 with fever" });
    for (const next of ["I have another patient", "there's another one", "next patient", "I have a new arrival in A and E"]) expect(doneLine(`I'm done with this patient, ${next}`)).toEqual({ next });
  });

  it("closes the task with the note in the owner's voice and leaves its obligation held", async () => {
    const b = boot(script);
    try {
      const task = (await b.rt.open(DOC, { patient_id: PAT })).task_id;
      await say(b, "When the blood count comes back, write a progress note: blood count back, reviewed.");
      expect(b.rt.view(task)!.obligations.map((o: { state: string }) => o.state)).toEqual(["held"]);
      const before = JSON.stringify(b.rt.view(task)!.obligations);
      const r = await say(b, "I'm done with this patient");
      const v = b.rt.view(task)!;
      expect([r.task_id, v.state, v.reason]).toEqual([task, "done", "owner_done"]);
      expect(notes(b, task)).toContain("Finished with Child Patient; say hey Pisgah for the next one.");
      expect(JSON.stringify(v.obligations)).toBe(before);
      expect(of(b, EMERGENCY_KIND)).toEqual([]);
    } finally { await b.rt.stop(); }
  });

  it("closes one task and opens exactly one new arrival from the same breath, carrying the words after the phrase", async () => {
    const b = boot(script);
    try {
      const task = (await b.rt.open(DOC, { patient_id: PAT })).task_id;
      await say(b, "Okay I'm done with this patient, I have another one, a woman about 30 with fever");
      expect([b.rt.view(task)!.state, b.rt.view(task)!.reason]).toEqual(["done", "owner_done"]);
      const opened = of(b, EMERGENCY_KIND);
      expect(opened).toHaveLength(1);
      const arrival = b.rt.openSubjects(DOC).find((x) => x.unidentified)!;
      const lines = b.rt.view(arrival.task_id)!.transcript.map((x: { text: string }) => x.text);
      expect(lines).toContain("I have another one, a woman about 30 with fever");
      expect(lines.some((x: string) => /done with this patient/.test(x))).toBe(false);
    } finally { await b.rt.stop(); }
  });

  it("negative control: another voice gets only a refusal note, and a negation or a question does nothing", async () => {
    const b = boot(script);
    try {
      const task = (await b.rt.open(DOC, { patient_id: PAT })).task_id;
      await say(b, "I'm done with this patient, I have another one", MIXED);
      let v = b.rt.view(task)!;
      expect(v.reason).not.toBe("owner_done");
      expect(notes(b, task).filter((n: string) => /Finished with/.test(n))).toEqual([]);
      expect(notes(b, task).some((n: string) => /I could not match that voice to you, so I did not act on it/.test(n))).toBe(true);
      await say(b, "I'm not done with this patient");
      await say(b, "Are we done with this patient?");
      await say(b, "I'm done with this patient?");
      v = b.rt.view(task)!;
      expect(v.reason).not.toBe("owner_done");
      expect(notes(b, task).filter((n: string) => /Finished with/.test(n))).toEqual([]);
      expect(of(b, EMERGENCY_KIND)).toEqual([]);
    } finally { await b.rt.stop(); }
  });
});

describe("a second arrival said while an admitted patient is open (rehearsal, 4 Nov 15:39)", () => {
  const LINE = "Emergency, another patient, motorcycle accident, a man about thirty";
  const windows = (...ns: number[]): Voiceprint => ({ ...print(ns[0]!), segments: ns.map((n) => ({ vector: [n], ms: 20 })) });
  const onPage = async (b: B, text: string, v: Voiceprint = OWNER, after = 0) => { const r = await b.rt.say({ owner: DOC, target: { admission_id: ADMIT }, text, source: "audio", voiceprint: v, spoken_at: new Date(b.clock.now + after).toISOString() }); await b.rt.settled(); return r; };
  const lines = (b: B, task: string) => b.rt.view(task)!.transcript.map((x: { text: string }) => x.text);
  const scene = async (said: [string, Voiceprint, number][]) => {
    const b = boot(() => ASIDE);
    const open = (await b.rt.open(DOC, { admission_id: ADMIT })).task_id;
    let last = null as Awaited<ReturnType<typeof onPage>> | null;
    for (const [text, v, after] of said) last = await onPage(b, text, v, after);
    return { b, open, last: last! };
  };

  it("opens exactly one arrival from a wake said alone and the emergency said next in the owner's voice, carrying the description", async () => {
    const { b, open, last } = await scene([["Hey Pisgah.", OWNER, 0], [LINE, OWNER, 3000]]);
    try {
      expect(of(b, EMERGENCY_KIND)).toHaveLength(1);
      expect(String(of(b, EMERGENCY_KIND)[0]!.args["reason"])).toMatch(/motorcycle accident, a man about thirty/);
      expect(last.task_id).not.toBe(open);
      expect(b.rt.view(last.task_id)!.unidentified).toBe(true);
      expect(lines(b, last.task_id)).toContain("another patient, motorcycle accident, a man about thirty");
      expect(lines(b, open)).not.toContain(LINE);
    } finally { await b.rt.stop(); }
  });

  it("opens from the phrase anywhere in a line's first forty characters, and from a mixed line holding the owner's window", async () => {
    for (const [said, v] of [["Okay so listen everyone, hey Pisgah, emergency, a woman about forty", OWNER], ["Hey Pisgah, we have another emergency, a boy of ten", OWNER], [LINE, windows(1, 5)]] as const) {
      const { b } = await scene(said === LINE ? [["Hey Pisgah.", OWNER, 0], [LINE, v, 2000]] : [[said, v, 0]]);
      try { expect([said, of(b, EMERGENCY_KIND).length]).toEqual([said, 1]); } finally { await b.rt.stop(); }
    }
  });

  it("negative control: the same two lines from another voice, a late line, a question and a ward open nothing", async () => {
    for (const said of [
      [["Hey Pisgah.", MIXED, 0], [LINE, MIXED, 3000]],
      [["Hey Pisgah.", OWNER, 0], [LINE, MIXED, 3000]],
      [["Hey Pisgah.", OWNER, 0], [LINE, OWNER, 9000]],
      [["Hey Pisgah.", OWNER, 0], ["Is this an emergency?", OWNER, 2000]],
      [["Hey Pisgah.", OWNER, 0], ["Emergency admission for her please", OWNER, 2000]],
      [[LINE, OWNER, 0]],
      [["Okay so listen everyone, hey Pisgah, emergency, a woman about forty", MIXED, 0]],
      [["We will speak to the family about it all this afternoon, hey Pisgah, emergency", OWNER, 0]],
      [["Hey Pisgah, is this an emergency?", OWNER, 0]]
    ] as [string, Voiceprint, number][][]) {
      const { b, open } = await scene(said);
      try {
        expect([said.map((x) => x[0]).join(" | "), of(b, EMERGENCY_KIND).length]).toEqual([said.map((x) => x[0]).join(" | "), 0]);
        expect(b.rt.openSubjects(DOC).map((x) => x.task_id)).toEqual([open]);
      } finally { await b.rt.stop(); }
    }
  });

  it("carries the rest of a long line that opened an arrival onto that arrival, so its name never lands on the open patient", async () => {
    const long = "Hey Pisgah. Emergency, another patient, motorcycle accident, a man about thirty. His name is John Brown and he was riding without a helmet this morning. He has a cut on his forehead and he is bleeding a little from the scalp.";
    const { b, open, last } = await scene([[long, OWNER, 0]]);
    try {
      expect(of(b, EMERGENCY_KIND)).toHaveLength(1);
      const arrived = b.rt.openSubjects(DOC).find((x) => x.unidentified)!;
      expect(last.task_id).toBe(arrived.task_id);
      expect(of(b, IDENTITY_KIND).map((w) => [w.args["patient_id"], w.args["name"]])).toEqual([[patientOf(b, arrived.task_id), "John Brown"]]);
      expect(lines(b, open).some((x: string) => /John Brown|forehead/.test(x))).toBe(false);
    } finally { await b.rt.stop(); }
  });
});

describe("a named arrival keeps its name against loose naming (rehearsal, 4 Nov 15:39)", () => {
  const NAME_Q: W[] = [{ class: "unclear", words: "her name is", question: "What is the patient's name?", confidence: 0.6 }];
  const names = (b: B) => of(b, IDENTITY_KIND).map((w) => w.args["name"]);
  const notes = (b: B, task: string) => b.rt.view(task)!.notes.map((n: { text: string }) => n.text);

  it("writes a note and changes nothing for another voice, or for the owner without a correction, and takes the owner's sorry", async () => {
    const b = boot(() => ASIDE);
    try {
      const task = await arrival(b);
      await sayOn(b, task, "This is Grace Carter.");
      for (const [line, v] of [["This is John Brown.", MIXED], ["My name is John Brown.", MIXED], ["This is John Brown.", OWNER]] as const) {
        const before = notes(b, task).length;
        await sayOn(b, task, line, v);
        expect([line, names(b)]).toEqual([line, ["Grace Carter"]]);
        const added = notes(b, task).slice(before);
        expect(added).toEqual(["Heard another name, so the name was not changed; say sorry, the name is ... to change it."]);
      }
      expect(b.rt.view(task)!.identities.map((i: { name: string }) => i.name)).toEqual(["Grace Carter"]);
      await sayOn(b, task, "Sorry, her name is Grace Carter-Jones.", MIXED);
      expect(names(b)).toEqual(["Grace Carter"]);
      await sayOn(b, task, "Sorry, her name is Grace Carter-Jones.");
      expect(names(b)).toEqual(["Grace Carter", "Grace Carter-Jones"]);
      for (const x of notes(b, task)) expect(x).not.toMatch(/John|Brown|Grace|Carter/);
    } finally { await b.rt.stop(); }
  });

  it("takes the owner's name answering a name question on a named arrival, and keeps a spelled correction working", async () => {
    const b = boot((s) => (s === "her name is" ? NAME_Q : ASIDE));
    try {
      const task = await arrival(b);
      await sayOn(b, task, "This is Grace Carter.");
      await sayOn(b, task, "her name is");
      const q = b.rt.view(task)!.questions[0]!;
      await b.rt.say({ owner: DOC, target: { patient_id: patientOf(b, task) }, text: "Ngozi Ada", source: "audio", voiceprint: OWNER, question_id: q.question_id, spoken_at: new Date(b.clock.now).toISOString() }, task);
      await b.rt.settled();
      expect(names(b)).toEqual(["Grace Carter", "Ngozi Ada"]);
      await sayOn(b, task, "Her surname is spelt A, D, U.", MIXED);
      expect(names(b)).toEqual(["Grace Carter", "Ngozi Ada", "Ngozi Adu"]);
    } finally { await b.rt.stop(); }
  });
});

describe("another voice's order is never asked about (rehearsal, 4 Nov 15:39)", () => {
  const MORPHINE = "Give him morphine now";
  const Q = "What dose, route, frequency and duration for the morphine?";
  const gate = (s: string): W[] => (s === MORPHINE ? [{ class: "unclear", kind: "prescribe", drug: "morphine", words: MORPHINE, question: Q, confidence: 0.6 } as unknown as W] : s === "give her IV paracetamol one gram" ? [ins("prescribe", { words: s, drug: "paracetamol_iv", dose: "1 g", route: "iv" })] : ASIDE);

  it("writes the refusal note and asks nothing for a stranger's order with missing details, and the owner's is asked as today", async () => {
    const b = boot(gate);
    try {
      const task = await arrival(b);
      await sayOn(b, task, MORPHINE, MIXED);
      await sayOn(b, task, "give her IV paracetamol one gram", MIXED);
      const v = b.rt.view(task)!;
      expect(v.questions).toEqual([]);
      expect(v.notes.map((n: { text: string }) => n.text).filter((t: string) => /so nothing was sent/.test(t))).toEqual(["I could not match that voice to you, so nothing was sent. Say it yourself.", "I could not match that voice to you, so nothing was sent. Say it yourself."]);
      expect(of(b, "prescribe")).toEqual([]);
      await sayOn(b, task, MORPHINE);
      expect(b.rt.view(task)!.questions.map((q) => q.text)).toEqual([Q]);
    } finally { await b.rt.stop(); }
  });
});
