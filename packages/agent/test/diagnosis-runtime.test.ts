import { describe, expect, it } from "vitest";
import type { Provenance } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { ClerkFake, DOC, PAT, VISIT, clerkBoot, ins } from "./clerking-helpers.js";

const TOKEN = (n: number) => `v1.${String(1_761_700_000_000 + n)}.${"A".repeat(43)}`;
const print = (n: number): Voiceprint => ({ vector: [n], ms: 20, model: "nemo_en_titanet_small" });
const OWNER = print(5), DRB = print(2), STRANGER = print(1);
const KINDS = ["record_observation", "open_consult", "record_clerking", "record_diagnosis"];

// The emergency doctor's hospital with a voice match: the owner gets a token, Dr B is named, anyone else is unverified.
class DxFake extends ClerkFake {
  private n = 0;
  override kindsFor(): readonly string[] { return KINDS; }
  readonly speaker = async (_o: string, v: readonly number[], _p: Provenance): Promise<SpeakerVerdict> => {
    this.n += 1;
    return v[0] === 5 ? { speaker: "owner", token: TOKEN(this.n) } : v[0] === 2 ? { speaker: "other_clinician", label: "Dr B" } as SpeakerVerdict : { speaker: "unverified", reason: "no_match" };
  };
}

function boot() {
  const port = new DxFake();
  return { ...clerkBoot((s) => (/diagnosis is/i.test(s) ? [ins("record_diagnosis", { text: s.replace(/^.*diagnosis is\s*/i, "").replace(/\.$/, "") })] : /pulse/i.test(s) ? [ins("record_observation", { pulse: 104 })] : []), { port }), port };
}
const say = (rt: ReturnType<typeof boot>["rt"], text: string, v: Voiceprint | null, task?: string) =>
  rt.say({ owner: DOC, target: { patient_id: PAT }, text, source: "audio", ...(v ? { voiceprint: v } : {}) }, task);
const dx = (port: DxFake) => port.writes.filter((w) => w.kind === "record_diagnosis");

describe("the diagnosis by voice in the runtime", () => {
  it("reads the diagnosis back on the owner's line and records it only on the owner's later confirm, with both tokens", async () => {
    const { rt, port } = boot();
    const a = await say(rt, "The diagnosis is acute appendicitis.", OWNER);
    await rt.settled();
    const v = rt.view(a.task_id)!;
    expect(v.actions.find((x) => x.kind === "record_diagnosis")).toMatchObject({ state: "proposed", awaiting: "confirm", args: { visit_id: VISIT, patient_id: PAT, diagnosis: "acute appendicitis" } });
    expect(v.questions.at(-1)!.text).toBe('Record the diagnosis: "acute appendicitis". Say confirm to record this diagnosis.');
    expect(dx(port)).toHaveLength(0);
    // Negative controls: an unverified voice and Dr B saying confirm write nothing.
    await say(rt, "Confirm.", STRANGER, a.task_id);
    await say(rt, "Confirm.", DRB, a.task_id);
    await rt.settled();
    expect(dx(port)).toHaveLength(0);
    const yes = await say(rt, "Confirm.", OWNER, a.task_id);
    await rt.settled();
    expect(dx(port)).toHaveLength(1);
    expect(dx(port)[0]!.prov.evidence).toBe(`transcript:${a.line_id}`);
    expect(dx(port)[0]!.prov.voice?.authorisation).toMatch(new RegExp(`^transcript:${a.line_id}~v1\\.`));
    expect(dx(port)[0]!.prov.voice?.confirmation).toMatch(new RegExp(`^transcript:${yes.line_id}~v1\\.`));
    expect(rt.view(a.task_id)!.actions.find((x) => x.kind === "record_diagnosis")!.state).toBe("completed");
    await rt.stop();
  });

  it("never records a diagnosis Dr B, an unverified voice or an unmatched typed line states, even after the owner's yes", async () => {
    const { rt, port } = boot();
    const b = await say(rt, "The diagnosis is malaria.", DRB);
    await rt.settled();
    const u = await say(rt, "The diagnosis is typhoid.", STRANGER, b.task_id);
    await rt.settled();
    await say(rt, "The diagnosis is sepsis.", null, b.task_id);
    await rt.settled();
    await say(rt, "Yes.", OWNER, b.task_id);
    await say(rt, "Confirm.", OWNER, b.task_id);
    await rt.settled();
    const v = rt.view(b.task_id)!;
    expect(v.actions.filter((x) => x.kind === "record_diagnosis")).toEqual([]);
    expect(dx(port)).toHaveLength(0);
    expect(v.notes.some((n) => n.text.startsWith("Dr B said a diagnosis"))).toBe(true);
    expect(v.transcript.find((l) => l.line_id === u.line_id)).toBeDefined();
    await rt.stop();
  });

  it("keeps the owner's confirm open when another voice gives an instruction, so the owner's next confirm records the diagnosis", async () => {
    const { rt, port } = boot();
    const a = await say(rt, "The diagnosis is acute appendicitis.", OWNER);
    await rt.settled();
    expect(rt.view(a.task_id)!.questions.at(-1)!.text).toMatch(/^Record the diagnosis/);
    // Dr B and an unverified voice each give an instruction while the owner's confirm question is open.
    await say(rt, "Pulse is one hundred and four.", DRB, a.task_id);
    await say(rt, "Pulse is one hundred and four.", STRANGER, a.task_id);
    await rt.settled();
    expect(rt.view(a.task_id)!.questions.some((q) => q.text.startsWith("Record the diagnosis"))).toBe(true);
    await say(rt, "Confirm.", OWNER, a.task_id);
    await rt.settled();
    expect(dx(port)).toHaveLength(1);
    expect(rt.view(a.task_id)!.actions.find((x) => x.kind === "record_diagnosis")!.state).toBe("completed");
    await rt.stop();
  });

  it("still lets the owner's own instruction move past the open confirm, as before", async () => {
    const { rt, port } = boot();
    const a = await say(rt, "The diagnosis is acute appendicitis.", OWNER);
    await rt.settled();
    await say(rt, "Pulse is one hundred and four.", OWNER, a.task_id);
    await rt.settled();
    expect(rt.view(a.task_id)!.questions.some((q) => q.text.startsWith("Record the diagnosis"))).toBe(false);
    expect(dx(port)).toHaveLength(0);
    await rt.stop();
  });
});
