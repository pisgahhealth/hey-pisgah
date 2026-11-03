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
  orderables() { return { tests: { fbc: ["FBC", "full blood count"], malaria: ["malaria parasite", "MP"], urinalysis: ["urinalysis"] }, drugs: { paracetamol_iv: ["IV paracetamol"], paracetamol_oral: ["paracetamol"] } }; }
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
