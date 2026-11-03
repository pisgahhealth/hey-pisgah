import { describe, expect, it } from "vitest";
import { EMERGENCY_KIND, IDENTITY_KIND, spelledName } from "../src/emr/entry.js";
import type { EmrCommit, EmrContext, EmrTarget, Provenance, WorkArgs } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { ClerkFake, DOC, clerkBoot, ins, type W } from "./clerking-helpers.js";

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
      // Each medicine said keeps its own question for the count the pharmacy needs, the second never swallowed by the first.
      expect(b.rt.view(task)!.questions.map((q) => q.text).filter((q) => q.startsWith("How many"))).toEqual(["How many should the pharmacy give for IV paracetamol 120 mg? Say the number.", "How many should the pharmacy give for IV paracetamol 1 g? Say the number."]);
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
