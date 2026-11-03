import { describe, expect, it } from "vitest";
import { ClerkFake, DOC, PAT, clerkBoot, ins, type W } from "./clerking-helpers.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { sourceClause } from "../src/emr/work.js";

const OWNER: Voiceprint = { vector: [5], ms: 20, model: "nemo_en_titanet_small" };
class ClinicalPort extends ClerkFake {
  override kindsFor(): readonly string[] { return [...super.kindsFor(), "record_diagnosis"]; }
  readonly speaker = async (): Promise<SpeakerVerdict> => ({ speaker: "owner", token: `v1.1761700000001.${"A".repeat(43)}` });
}
const boot = (script: (said: string) => W[]) => clerkBoot(script, { port: new ClinicalPort() });
const say = (b: ReturnType<typeof boot>, text: string, task?: string) => b.rt.say({ owner: DOC, target: { patient_id: PAT }, text, source: "audio", voiceprint: OWNER }, task);
const notes = (b: ReturnType<typeof boot>) => b.port.writes.filter((w) => w.kind === "record_clerking");
const diagnoses = (b: ReturnType<typeof boot>) => b.port.writes.filter((w) => w.kind === "record_diagnosis");

describe("clinical documentation from the spoken clause", () => {
  it.each([
    ["You are not febrile.", "Is febrile.", "Is not febrile."],
    ["You have no rash.", "Has rash.", "Has no rash."],
    ["Your right pupil is 3 mm, not 5 mm.", "Right pupil is 5 mm.", "Right pupil is 3 mm, not 5 mm."],
  ])("preserves the source when the generated examination drops negation or changes a measurement: %s", async (line, generated, expected) => {
    const b = boot((s) => [{ class: "finding", section: "examination", words: s, text: generated, confidence: 0.99 }]);
    try {
      await say(b, line);
      await b.rt.settled();
      expect(notes(b).map((w) => w.args["text"])).toEqual([expected]);
    } finally { await b.rt.stop(); }
  });

  it("transforms only the examination clause in a mixed utterance", async () => {
    const line = "You have no rash. We could try antibiotics.";
    const b = boot(() => [
      { class: "finding", section: "examination", words: "You have no rash.", text: "Has rash.", confidence: 0.99 },
      { class: "option", words: "We could try antibiotics.", confidence: 0.99 },
    ]);
    try {
      await say(b, line);
      await b.rt.settled();
      expect(notes(b).map((w) => w.args["text"])).toEqual(["Has no rash."]);
      expect(b.port.writes.map((w) => w.kind)).toEqual(["open_consult", "record_clerking"]);
    } finally { await b.rt.stop(); }
  });

  it.each([
    "I no longer think my initial diagnosis is cerebral malaria.",
    "My initial diagnosis is malaria, or perhaps meningitis.",
    "My working diagnosis is that she might have cerebral malaria.",
  ])("keeps an option as assessment, never a final diagnosis: %s", async (line) => {
    const b = boot((s) => s === line ? [{ class: "option", words: s, confidence: 0.99 }] : []);
    try {
      const first = await say(b, line);
      await b.rt.settled();
      await say(b, "Confirm.", first.task_id);
      await b.rt.settled();
      expect(diagnoses(b)).toHaveLength(0);
      expect(notes(b).map((w) => [w.args["section"], w.args["text"]])).toEqual([["assessment", line]]);
      expect(b.rt.view(first.task_id)!.actions.filter((a) => a.kind === "record_diagnosis")).toHaveLength(0);
    } finally { await b.rt.stop(); }
  });

  it("retains uncertainty even when the gate incorrectly proposes a settled diagnosis", async () => {
    const line = "My provisional diagnosis is malaria, or perhaps meningitis.";
    const b = boot((s) => [ins("record_diagnosis", { words: s, text: "malaria" })]);
    try {
      const first = await say(b, line);
      await b.rt.settled();
      expect(diagnoses(b)).toHaveLength(0);
      expect(b.rt.view(first.task_id)!.actions.filter((a) => a.kind === "record_diagnosis")).toHaveLength(0);
      expect(notes(b).map((w) => w.args["text"])).toEqual([line]);
    } finally { await b.rt.stop(); }
  });

  it("retains a differential classified as an assessment finding even if generated text omits alternatives", async () => {
    const line = "It could be malaria or meningitis.";
    const b = boot((s) => [{ class: "finding", section: "assessment", words: s, text: "malaria", confidence: 0.99 }]);
    try {
      await say(b, line);
      await b.rt.settled();
      expect(notes(b).map((w) => w.args["text"])).toEqual([line]);
      expect(diagnoses(b)).toHaveLength(0);
    } finally { await b.rt.stop(); }
  });

  it("never borrows a diagnosis from a different clause of a long instruction", async () => {
    const line = "If my initial diagnosis is malaria, wait for the tests. We could try antibiotics.";
    const b = boot(() => [
      { class: "conditional", words: "If my initial diagnosis is malaria, wait for the tests.", confidence: 0.99 },
      { class: "option", words: "We could try antibiotics.", confidence: 0.99 },
    ]);
    try {
      const first = await say(b, line);
      await b.rt.settled();
      expect(b.rt.view(first.task_id)!.actions.filter((a) => a.kind === "record_diagnosis")).toHaveLength(0);
      expect(diagnoses(b)).toHaveLength(0);
    } finally { await b.rt.stop(); }
  });

  it("keeps an explicitly settled diagnosis behind its matched confirmation", async () => {
    const line = "The diagnosis is acute appendicitis.";
    const b = boot((s) => s === line ? [ins("record_diagnosis", { words: s, text: "acute appendicitis" })] : []);
    try {
      const first = await say(b, line);
      await b.rt.settled();
      expect(diagnoses(b)).toHaveLength(0);
      expect(b.rt.view(first.task_id)!.questions.at(-1)!.text).toContain("Say confirm to record this diagnosis");
      await say(b, "Confirm.", first.task_id);
      await b.rt.settled();
      expect(diagnoses(b).map((w) => w.args["diagnosis"])).toEqual(["acute appendicitis"]);
    } finally { await b.rt.stop(); }
  });

  it("rejects a rewritten source clause and accepts only case, whitespace and apostrophe differences", () => {
    expect(sourceClause("you are febrile", "You are not febrile.")).toBeNull();
    expect(sourceClause("you're not febrile", "YOU’RE  not febrile.")).toBe("YOU’RE not febrile");
    expect(sourceClause("malaria", "antimalarial therapy")).toBeNull();
  });
});
