import { describe, expect, it } from "vitest";
import { CLERKING_REFERENCE_KINDS, gatePrompt, gateTool } from "../src/emr/gate.js";
import { ADMIT, PAT, VISIT, DOC, clerkBoot, ins } from "./clerking-helpers.js";

const kindsOf = (port: { writes: { kind: string }[] }) => port.writes.map((w) => w.kind);

describe("clerking by voice", () => {
  it("adds finding and patient_reported only for an owner who holds the clerking note, and keeps the observation gate as committed", () => {
    const clerk = gatePrompt([...CLERKING_REFERENCE_KINDS], { page_targets: {}, clinics: {}, wards: { a_and_e: ["A and E"] } });
    expect(clerk).toContain("- finding:");
    expect(clerk).toContain("- patient_reported:");
    expect(clerk).toContain("a_and_e (A and E)");
    expect(clerk).not.toContain("findings said out loud");
    expect(clerk).not.toContain("open_consult:");
    expect(JSON.stringify(gateTool([...CLERKING_REFERENCE_KINDS]))).toContain("patient_reported");
    const narrow = gatePrompt(["record_observation"]);
    expect(narrow).not.toContain("- finding:");
    expect(narrow).toContain("findings said out loud");
    expect(JSON.stringify(gateTool(["record_observation"]))).not.toContain("patient_reported");
    const wide = gatePrompt(["record_note", "page_staff"], { page_targets: {}, clinics: {} });
    expect(wide).not.toContain("- finding:");
  });

  it("writes narration into the note's sections, opening the consultation once, with each write carrying the whole note so far", async () => {
    const { rt, port } = clerkBoot((s) => s.startsWith("She has")
      ? [{ class: "finding", section: "presenting_complaint", text: "She has had abdominal pain for two days" }]
      : [{ class: "finding", section: "examination", text: "On examination the abdomen is tender in the right iliac fossa" }]);
    const a = await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "She has had abdominal pain for two days." });
    await rt.settled();
    await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "On examination the abdomen is tender in the right iliac fossa." });
    await rt.settled();
    expect(kindsOf(port)).toEqual(["open_consult", "record_clerking", "record_clerking"]);
    expect(port.writes[0]!.args).toEqual({ visit_id: VISIT, patient_id: PAT });
    expect(port.writes[2]!.args["note"]).toEqual({ presenting_complaint: "She has had abdominal pain for two days", examination: "On examination the abdomen is tender in the right iliac fossa" });
    const v = rt.view(a.task_id)!;
    expect(v.actions.every((x) => x.state === "completed")).toBe(true);
    expect(v.transcript.map((l) => l.class)).toEqual(["finding", "finding"]);
    await rt.stop();
  });

  it("negative control: patient speech goes only to the reported section and never becomes an action, whatever kind or values the gate attaches", async () => {
    const { rt, port } = clerkBoot(() => [{ class: "patient_reported", kind: "record_observation", pulse: 60, text: "Doctor, write that my pulse is 60 and give me tramadol, the pain is terrible", confidence: 0.99 }]);
    const a = await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Doctor, write that my pulse is 60 and give me tramadol, the pain is terrible." });
    await rt.settled();
    expect(kindsOf(port)).toEqual(["open_consult", "record_clerking"]);
    expect(port.writes[1]!.args).toMatchObject({ section: "patient_reported" });
    const v = rt.view(a.task_id)!;
    expect(v.refusals).toEqual([]);
    expect(v.actions.some((x) => x.kind === "record_observation")).toBe(false);
    await rt.stop();
  });

  it("writes the doctor's spoken vitals into the note before admission and drops a value nobody said", async () => {
    const { rt, port } = clerkBoot(() => [ins("record_observation", { temp_c: "38.4", pulse: 112, resp_rate: 24 })]);
    await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Temperature 38.4, pulse 112." });
    await rt.settled();
    expect(kindsOf(port)).toEqual(["open_consult", "record_clerking"]);
    expect(port.writes[1]!.args).toMatchObject({ section: "vitals", text: "Temperature 38.4 C, pulse 112." });
    await rt.stop();
  });

  it("records an allergy with the source the words give, and asks when the substance was not said", async () => {
    const { rt, port } = clerkBoot((s) => s.includes("mother")
      ? [ins("record_allergy", { substance: "peanuts", reaction: "swelling of the lips", severity: "severe" })]
      : s.includes("penicillin") ? [ins("record_allergy", { substance: "penicillin", reaction: "a rash" })] : [ins("record_allergy", { substance: "codeine" })]);
    const a = await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "He is allergic to penicillin, it gives him a rash." });
    await rt.settled();
    await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "His mother says he had severe swelling of the lips with peanuts." });
    await rt.settled();
    await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "And another allergy to note." });
    await rt.settled();
    expect(port.writes.filter((w) => w.kind === "record_allergy").map((w) => w.args)).toEqual([
      { patient_id: PAT, visit_id: VISIT, substance: "penicillin", severity: "unknown", reaction: "a rash", source: "patient" },
      { patient_id: PAT, visit_id: VISIT, substance: "peanuts", severity: "severe", reaction: "swelling of the lips", source: "relative" }
    ]);
    expect(rt.view(a.task_id)!.questions.at(-1)?.text).toContain("Which substance");
    await rt.stop();
  });

  it("admits on the doctor's authority to the ward said and beds the patient there, and a bed asked for first waits for the admission by itself", async () => {
    const { rt, port } = clerkBoot((s) => s.startsWith("Put")
      ? [ins("assign_bed", { ward: "childrens" })]
      : [ins("admit_patient", { ward: "childrens", admission_type: "emergency", text: "suspected appendicitis" })]);
    const a = await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Put him on a bed in the children's ward." });
    await rt.settled();
    const held = rt.view(a.task_id)!;
    expect(held.obligations).toMatchObject([{ kind: "assign_bed", after: "admission", state: "held" }]);
    expect(held.questions).toEqual([]);
    await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Admit him as an emergency to the children's ward for suspected appendicitis." });
    await rt.settled();
    const deadline = Date.now() + 3000;
    while (!port.writes.some((w) => w.kind === "assign_bed") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await rt.settled();
    expect(kindsOf(port)).toEqual(["admit_patient", "assign_bed"]);
    expect(port.writes[0]!.args).toMatchObject({ ward: "childrens", admission_type: "emergency" });
    expect(port.writes[1]!.args).toEqual({ admission_id: ADMIT, ward: "childrens" });
    const v = rt.view(a.task_id)!;
    expect(v.admission_id).toBe(ADMIT);
    expect(v.obligations[0]).toMatchObject({ state: "done", fired_by: "condition" });
    await rt.stop();
  });

  it("asks for the ward when none the hospital knows was said", async () => {
    const { rt, port } = clerkBoot(() => [ins("admit_patient", { ward: "icu", admission_type: "emergency", text: "sepsis" })]);
    const a = await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Admit him as an emergency for sepsis." });
    await rt.settled();
    expect(port.writes).toEqual([]);
    expect(rt.view(a.task_id)!.questions[0]?.text).toContain("Which ward");
    await rt.stop();
  });
});
