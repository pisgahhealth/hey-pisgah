import { describe, expect, it } from "vitest";
import { EMERGENCY_KIND, IDENTITY_KIND, spelledName } from "../src/emr/entry.js";
import type { EmrCommit, EmrContext, EmrTarget, Provenance, WorkArgs } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { cleanNoteText } from "../src/emr/work.js";
import { CLERK_KINDS, ClerkFake, DOC, clerkBoot, ins, type W } from "./clerking-helpers.js";

// Lane EMN: a clean note and a spelling that never lands on the wrong part.
const TOKEN = (n: number) => `v1.${String(1_761_700_000_000 + n)}.${"A".repeat(43)}`;
const print = (n: number): Voiceprint => ({ vector: [n], ms: 20, model: "nemo_en_titanet_small" });
const OWNER = print(5), DRB = print(4), STRANGER = print(1);
const ARRIVAL = "dddddddd-1111-4222-8333-444444444444", ARRIVAL_VISIT = "eeeeeeee-1111-4222-8333-444444444444";

// A doctor with a voice match (5 is the owner, 4 is Dr B) who opens arrivals and clerks.
class EmnFake extends ClerkFake {
  private n = 0;
  override kindsFor(): readonly string[] { return [...CLERK_KINDS, EMERGENCY_KIND, IDENTITY_KIND, "record_triage_vitals"]; }
  override async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    if (kind !== EMERGENCY_KIND) return super.commit(kind, args, key, prov);
    if (!this.writes.some((w) => w.key === key)) this.writes.push({ kind, args, key, prov, id: ARRIVAL });
    return { ok: true, record_id: ARRIVAL, record_version: 1, event_ids: [`patient:${ARRIVAL}`, `visit:${ARRIVAL_VISIT}`], replayed: false };
  }
  readonly speaker = async (_o: string, v: readonly number[], _p: Provenance): Promise<SpeakerVerdict> => {
    this.n += 1;
    return v[0] === 5 ? { speaker: "owner", token: TOKEN(this.n) } : v[0] === 4 ? { speaker: "other_clinician", label: "Dr B", role: "doctor" } as SpeakerVerdict : { speaker: "unverified", reason: "no_match" };
  };
  override async resolve(target: EmrTarget): Promise<EmrContext> {
    if (target.patient_id === ARRIVAL) return { admission_id: "", patient_id: ARRIVAL, visit_id: ARRIVAL_VISIT, label: "Unknown arrival 17:22", facts: { ward: null, bed: null }, keywords: [] };
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
const gate = (s: string): W[] => {
  if (s === PC) return [{ class: "finding", section: "presenting_complaint", text: "highhigh fever and confusion", confidence: 0.9 }];
  if (s === EXAM) return [{ class: "finding", section: "examination", text: s, confidence: 0.9 }];
  if (s === RR) return [ins("record_triage_vitals", { resp_rate: 24, text: "Respiratory rate 24" })];
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
