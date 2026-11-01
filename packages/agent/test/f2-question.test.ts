import { describe, expect, it } from "vitest";
import type { EmrCommit, Orderables, Provenance, WorkArgs } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { CLERK_KINDS, ClerkFake, DOC, PAT, clerkBoot, ins, type W } from "./clerking-helpers.js";
import { until } from "./emr-helpers.js";

// Lane F2 (a): a "could not use that" question closes when a later line of the same kind writes and proves its record.
const print = (n: number): Voiceprint => ({ vector: [n], ms: 20, model: "nemo_en_titanet_small" });
const OWNER_V = print(5);

class StaleFake extends ClerkFake {
  private n = 0;
  refuseTriage = false;
  // While set, the triage read finds nothing yet, so a later line can be heard before the earlier write is proved.
  unproved = false;
  override kindsFor(): readonly string[] { return [...CLERK_KINDS, "record_triage_vitals", "prescribe"]; }
  orderables(): Orderables { return { tests: {}, drugs: { paracetamol_iv: { words: ["IV paracetamol"], controlled: false }, amoxicillin: { words: ["amoxicillin"], controlled: false } } }; }
  override async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    if (kind === "record_triage_vitals" && this.refuseTriage) return { ok: false, reason: "door_409_conflict", status: 409, retryable: false, counted: false };
    return super.commit(kind, args, key, prov);
  }
  override async prove(k: string, a: WorkArgs, w: { record_id: string; record_version: number; event_ids: string[] }) {
    return k === "record_triage_vitals" && this.unproved ? null : super.prove(k, a, w);
  }
  readonly speaker = async (): Promise<SpeakerVerdict> => { this.n += 1; return { speaker: "owner", token: `v1.${String(1_761_700_000_000 + this.n)}.${"A".repeat(43)}` }; };
}

// The gate hears the triage values even when the line spells them as words, as the live gate did on 31 Oct.
const gate = (s: string): W[] => {
  if (/^Pulse/i.test(s)) return [ins("record_triage_vitals", { pulse: 88, spo2: 97 })];
  if (/penicillin/i.test(s)) return [ins("record_allergy", { substance: "penicillin" })];
  if (/IV paracetamol/.test(s)) return [ins("prescribe", { drug: "paracetamol_iv" })];
  if (/amoxicillin/.test(s)) return [ins("prescribe", { drug: "amoxicillin" })];
  return [{ class: "aside", confidence: 0.9 }];
};
function boot() {
  const port = new StaleFake();
  return { ...clerkBoot(gate, { port }), port };
}
type B = ReturnType<typeof boot>;
// Each later line is dated past the two-minute answer window, so only the new rule can close the earlier question.
const say = (b: B, text: string, minutes = 0) => b.rt.say({ owner: DOC, target: { patient_id: PAT }, text, source: "audio", voiceprint: OWNER_V, spoken_at: new Date(Date.now() + minutes * 60_000).toISOString() });
const STALE = /^I could not use that \(triage needs at least one measurement\)\. Please say it again\.$/;

describe("F2 (a): a stale could-not-use question", () => {
  it("is answered by the later triage line that wrote, with no note and nothing left asking", async () => {
    const b = boot();
    const first = await say(b, "Pulse eighty eight, sats ninety seven on air.");
    await b.rt.settled();
    const t = b.rt.task(first.task_id)!;
    expect(t.questions.filter((q) => q.answered_by === null).map((q) => q.text)).toEqual([expect.stringMatching(STALE)]);
    const later = await say(b, "Pulse 88, sats 97 on air.", 5);
    await b.rt.settled();
    expect(b.port.writes.filter((w) => w.kind === "record_triage_vitals").map((w) => w.args)).toEqual([expect.objectContaining({ pulse: 88, spo2: 97 })]);
    expect(b.rt.view(first.task_id)!.questions).toEqual([]);
    expect(t.questions.find((q) => STALE.test(q.text))!.answered_by).toBe(later.line_id);
    const notes = b.rt.view(first.task_id)!.notes.map((n) => n.text);
    expect(notes.some((n) => /Closed my question|No answer, so nothing was done/.test(n))).toBe(false);
    expect(b.rt.stateOf(first.task_id)).toBe("done");
    await b.rt.stop();
  });

  it("stays open while the later triage line is refused, and when only another kind of work is written", async () => {
    const b = boot();
    const first = await say(b, "Pulse eighty eight, sats ninety seven on air.");
    await b.rt.settled();
    b.port.refuseTriage = true;
    await say(b, "Pulse 88, sats 97 on air.", 5);
    await b.rt.settled();
    await say(b, "She is allergic to penicillin.", 6);
    await b.rt.settled();
    expect(b.port.writes.filter((w) => w.kind === "record_allergy")).toHaveLength(1);
    expect(b.rt.view(first.task_id)!.questions.map((q) => q.text)).toContainEqual(expect.stringMatching(STALE));
    await b.rt.stop();
  });

  it("leaves a how-many question open when a prescription of another medicine is written", async () => {
    const b = boot();
    const first = await say(b, "Give IV paracetamol.");
    await b.rt.settled();
    expect(b.rt.view(first.task_id)!.questions.map((q) => q.text)).toEqual([expect.stringMatching(/^How many should the pharmacy give for IV paracetamol/)]);
    await say(b, "Give amoxicillin, 21 tablets.", 5);
    await b.rt.settled();
    expect(b.port.writes.filter((w) => w.kind === "prescribe").map((w) => w.args["drug"])).toEqual(["amoxicillin"]);
    expect(b.rt.view(first.task_id)!.questions.map((q) => q.text)).toEqual([expect.stringMatching(/^How many should the pharmacy give for IV paracetamol/)]);
    await b.rt.stop();
  });

  it("is not answered by an earlier line's write that is proved after the question was asked", async () => {
    const b = boot();
    b.port.unproved = true;
    const first = await say(b, "Pulse 88, sats 97 on air.");
    await b.rt.settled();
    await say(b, "Pulse eighty eight, sats ninety seven on air.", 5);
    await b.rt.settled();
    expect(b.rt.task(first.task_id)!.questions.filter((q) => q.answered_by === null).map((q) => q.text)).toEqual([expect.stringMatching(STALE)]);
    b.port.unproved = false;
    await until(() => b.rt.view(first.task_id)!.actions.some((a) => a.state === "completed"), 8000).catch(() => null);
    await b.rt.pollOnce();
    await b.rt.settled();
    expect(b.rt.view(first.task_id)!.actions.filter((a) => a.kind === "record_triage_vitals").map((a) => a.state)).toEqual(["completed"]);
    expect(b.rt.view(first.task_id)!.questions.map((q) => q.text)).toEqual([expect.stringMatching(STALE)]);
    await b.rt.stop();
  });
});
