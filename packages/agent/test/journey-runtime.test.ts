import { describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import { EmrRuntime, PAY_LINK_VERIFIED_NOTE, SPOKEN_PAUSE, SPOKEN_RESUME } from "../src/emr/runtime.js";
import { gatePrompt, gateTool } from "../src/emr/gate.js";
import { cadenceSaid, dateSaid } from "../src/emr/work.js";
import { startEmrServe } from "../src/emr/serve.js";
import { emrRoot, gater, until, type C } from "./emr-helpers.js";
import { ACC, ADMIT, DOC, NURSE, PAT, VISIT, WorkFake } from "./work-helpers.js";

type W = C & Record<string, unknown>;
function boot(script: (said: string) => W[], o: { holdMs?: number; watchMs?: number } = {}) {
  const root = emrRoot();
  const port = new WorkFake();
  const seen: string[] = [];
  let rt: EmrRuntime | null = null;
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater((s) => script(s), seen), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: o.holdMs ?? 0, proofRetryMs: 1, ...(o.watchMs ? { watchMs: o.watchMs } : {}) });
  rt.start();
  return { rt, port, seen };
}
const ins = (kind: string, f: Record<string, unknown> = {}): W => ({ class: "instruction", kind, confidence: 0.95, ...f });

describe("journey kinds in the runtime", () => {
  it("keeps the observation-only gate as committed and lists only the owner's kinds in the wider prompt", () => {
    const narrow = gatePrompt(["record_observation"]);
    expect(narrow).not.toContain("page_staff");
    expect(JSON.stringify(gateTool(["record_observation"]))).not.toContain("ward_class");
    const wide = gatePrompt(["record_note", "page_staff"], { page_targets: { lab: ["lab"] }, clinics: {} });
    expect(wide).toContain("page_staff:");
    expect(wide).toContain("lab (lab)");
    expect(wide).not.toContain("send_pay_link:");
    expect(JSON.stringify(gateTool(["record_note"]))).toContain("ward_class");
  });

  it("opens a task on the patient before admission, links it when the requested admission exists, and keeps one task", async () => {
    const { rt, port } = boot((s) => s.startsWith("Write") ? [ins("draft_consult_note", { text: "right iliac fossa pain since yesterday" })]
      : [ins("request_admission", { ward_class: "general", admission_type: "emergency", text: "suspected appendicitis" })]);
    const a = await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Write my assessment: right iliac fossa pain since yesterday." });
    await rt.settled();
    const b = await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Request an emergency admission to the general ward for suspected appendicitis." });
    await rt.settled();
    expect(b.task_id).toBe(a.task_id);
    const v = rt.view(a.task_id)!;
    expect(v.actions.map((x) => [x.kind, x.state])).toEqual([["draft_consult_note", "completed"], ["request_admission", "completed"]]);
    expect(v.actions[0]!.args).toMatchObject({ visit_id: VISIT, text: "right iliac fossa pain since yesterday" });
    expect(v.admission_id).toBe(ADMIT);
    const c = await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Chart pulse 96." });
    expect(c.task_id).toBe(a.task_id);
    expect(port.writes.map((w) => w.kind)).toEqual(["draft_consult_note", "request_admission"]);
    await rt.stop();
  });

  it("asks instead of guessing a ward class, a cadence, a page target or a date nobody said", async () => {
    const { rt, port } = boot((s) => {
      if (s.includes("admit")) return [ins("request_admission", { ward_class: "icu", admission_type: "emergency" })];
      if (s.includes("observations")) return [ins("add_care_plan_item", { title: "observations", cadence: "q4h", item_kind: "observation" })];
      if (s.includes("radiology")) return [ins("page_staff", { to: "lab", text: "please scan" })];
      return [ins("schedule_follow_up", { clinic: "gopd", date: "2026-11-11" })];
    });
    port.admitted = true;
    const t = await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Please admit her as an emergency." });
    await rt.settled();
    await rt.say({ owner: NURSE, target: { admission_id: ADMIT }, text: "Add observations to the care plan." });
    await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Ask radiology to scan her." });
    await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Book her into GOPD next month." });
    await rt.settled();
    expect(port.writes).toHaveLength(0);
    const asked = rt.views().flatMap((v) => v.asked.map((q) => q.text));
    expect(asked.some((q) => q.startsWith("Which ward class"))).toBe(true);
    expect(asked.some((q) => q.startsWith("How often"))).toBe(true);
    expect(asked.some((q) => q.startsWith("Who should I page"))).toBe(true);
    expect(asked.some((q) => q.startsWith("Which day"))).toBe(true);
    expect(rt.view(t.task_id)!.state).toBe("waiting");
    await rt.stop();
  });

  it("refuses an order or a discharge spoken to it and counts the refusal on the owner's task", async () => {
    const { rt, port } = boot(() => [{ class: "instruction", kind: null, confidence: 0.9, asked_for: "order a full blood count" }]);
    port.admitted = true;
    const t = await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Order a full blood count for her." });
    await rt.settled();
    expect(rt.view(t.task_id)!.refusals).toHaveLength(1);
    expect(port.writes).toHaveLength(0);
    await rt.stop();
  });

  it("pauses on a spoken stop with the held action unwritten, makes no model call while away, and resumes with a digest", async () => {
    const { rt, port, seen } = boot((s) => (s.startsWith("Progress note") ? [ins("record_note", { note_type: "progress", text: "pain settling, abdomen soft" })] : [{ class: "aside" }]), { holdMs: 300 });
    port.admitted = true;
    const t = await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Progress note: pain settling, abdomen soft." });
    await until(() => (rt.view(t.task_id)?.actions.length ?? 0) === 1, 3000);
    await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Stop, I'll come back to this." }, t.task_id);
    const calls = seen.length;
    expect(rt.view(t.task_id)).toMatchObject({ state: "paused", reason: "called_away" });
    await new Promise((r) => setTimeout(r, 500));
    await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Chart her pulse as 120." }, t.task_id);
    port.pulse = 104;
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.length).toBe(calls);
    expect(port.writes).toHaveLength(0);
    expect(rt.view(t.task_id)!.actions[0]!.state).toBe("proposed");
    await rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Okay, where were we?" }, t.task_id);
    await rt.settled();
    expect(seen.length).toBe(calls);
    const v = rt.view(t.task_id)!;
    expect(v.digests).toHaveLength(1);
    expect(v.digests[0]!.text).toContain("pulse 90 to 104");
    expect(v.digests[0]!.text).toContain("I heard 1 line and did nothing with it");
    expect(v.digests[0]!.text).toContain("Write a progress note");
    expect(v.actions[0]!.state).toBe("completed");
    expect(port.writes.map((w) => w.kind)).toEqual(["record_note"]);
    await rt.stop();
  });

  it("drafts a handover for review and saves the draft only when the nurse says so", async () => {
    const { rt, port } = boot((s) => (s.startsWith("Draft") ? [ins("draft_handover")] : [ins("record_note", { note_type: "nursing", text: null })]));
    port.admitted = true;
    const t = await rt.say({ owner: NURSE, target: { admission_id: ADMIT }, text: "Draft my handover for the night nurse." });
    await rt.settled();
    let v = rt.view(t.task_id)!;
    expect(v.state).toBe("waiting");
    expect(v.questions[0]!.text).toContain("Handover draft for your review");
    expect(port.writes.map((w) => w.kind)).toEqual(["draft_handover"]);
    await rt.say({ owner: NURSE, target: { admission_id: ADMIT }, text: "That's fine, save the handover." }, t.task_id);
    await rt.settled();
    v = rt.view(t.task_id)!;
    expect(v.actions[1]).toMatchObject({ kind: "record_note", state: "completed", args: { note_type: "nursing", label: "handover", text: "Handover: Journey Patient, Ward A A1, pulse 90." } });
    await rt.stop();
  });

  it("watches the record with no model call, offers the pay link once when sign-off lands, and leaves a page unacted", async () => {
    const { rt, port, seen } = boot((s) => (s.includes("pay link") ? [ins("send_pay_link")] : [ins("prepare_bill")]), { watchMs: 30 });
    port.admitted = true;
    const t = await rt.open(ACC, { admission_id: ADMIT });
    await until(() => rt.view(t.task_id)!.watching !== null, 2000);
    expect(rt.view(t.task_id)!.watching).toMatchObject({ stage: "awaiting_sign_off" });
    port.inboxes[ACC] = [{ page_id: "p-1", subject: "Patient ready for her bill", at: new Date().toISOString(), patient_id: PAT }];
    port.stage = "signed_off";
    await until(() => rt.view(t.task_id)!.questions.length === 1, 2000);
    await new Promise((r) => setTimeout(r, 120));
    let v = rt.view(t.task_id)!;
    expect(v.changes.map((c) => [c.fact, c.from, c.to])).toEqual([["stage", "awaiting_sign_off", "signed_off"]]);
    expect(v.questions).toHaveLength(1);
    expect(v.pages.map((p) => p.page_id)).toEqual(["p-1"]);
    expect(v.notes.some((n) => n.text.includes("I have not acted on it"))).toBe(true);
    expect(seen).toHaveLength(0);
    expect(port.writes).toHaveLength(0);
    await rt.say({ owner: ACC, target: { admission_id: ADMIT }, text: "Get her bill ready." }, t.task_id);
    await rt.settled();
    await rt.say({ owner: ACC, target: { admission_id: ADMIT }, text: "Yes, send her the pay link." }, t.task_id);
    await rt.settled();
    v = rt.view(t.task_id)!;
    expect(v.actions.map((a) => [a.kind, a.state])).toEqual([["prepare_bill", "completed"], ["send_pay_link", "completed"]]);
    expect(v.notes.some((n) => n.text.startsWith("Bill: 10,000"))).toBe(true);
    // A pay link proved by the bill's read-back says what that proof does not show.
    expect(v.notes.some((n) => n.text === PAY_LINK_VERIFIED_NOTE)).toBe(true);
    await until(() => rt.view(t.task_id)!.watching?.["pay_link"] === "sent", 2000);
    expect(rt.views(DOC)).toHaveLength(0);
    expect(rt.views(ACC)).toHaveLength(1);
    await rt.stop();
  });

  it("serves one task stream per owner, opens a watched task with no words, and resumes from the strip", async () => {
    const root = emrRoot();
    const port = new WorkFake();
    port.admitted = true;
    let rt: EmrRuntime | null = null;
    const seen: string[] = [];
    const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater(() => [ins("record_note", { note_type: "progress", text: "pain settling" })], seen), taskStateOf: (id) => rt?.stateOf(id) ?? null });
    const s = await startEmrServe({ storeRoot: root, port, client, listenPort: 0, runtime: { holdMs: 2000 } });
    rt = s.runtime;
    const post = async (path: string, body: unknown) => { const r = await fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as Record<string, unknown> }; };
    const tasks = async (owner: string) => (await (await fetch(`${s.url}/tasks?owner=${owner}`)).json()) as { task_id: string; state: string }[];
    try {
      const w = await post("/tasks/watch", { owner: ACC, admissionId: ADMIT });
      expect(w.status).toBe(200);
      const d = await post("/tasks/say", { owner: DOC, admissionId: ADMIT, text: "Progress note: pain settling." });
      expect(d.status).toBe(202);
      await until(() => (rt!.view(String(d.body["task_id"]))?.actions.length ?? 0) === 1, 3000);
      await post(`/tasks/${String(d.body["task_id"])}/say`, { text: "Hold on, I'll come back to this." });
      expect((await tasks(DOC)).map((t) => t.state)).toEqual(["paused"]);
      expect((await tasks(ACC)).map((t) => t.task_id)).toEqual([w.body["task_id"]]);
      expect((await tasks(NURSE))).toEqual([]);
      expect((await post(`/tasks/${String(d.body["task_id"])}/resume`, { owner: ACC })).status).toBe(403);
      const r = await post(`/tasks/${String(d.body["task_id"])}/resume`, {});
      expect(r.body).toMatchObject({ resumed: true });
      await rt.settled();
      expect(rt.view(String(d.body["task_id"]))!.actions[0]!.state).toBe("completed");
      expect(seen).toHaveLength(1);
    } finally { await s.close(); }
  });

  it("reads pause, return, cadence and date phrases by rule", () => {
    for (const s of ["Stop, I'll come back to this.", "Hold on.", "Okay, stop.", "Sorry, I'll come back to this later."]) expect(SPOKEN_PAUSE.test(s), s).toBe(true);
    for (const s of ["Right, my decision is to stop the IV fluids and let her drink freely.", "Stop the paracetamol tomorrow.", "Don't stop the drip."]) expect(SPOKEN_PAUSE.test(s), s).toBe(false);
    for (const s of ["Okay, where were we?", "I'm back. Let's carry on."]) expect(SPOKEN_RESUME.test(s), s).toBe(true);
    expect(SPOKEN_RESUME.test("Where is the drip stand?")).toBe(false);
    expect(cadenceSaid("q4h", "Four-hourly observations please")).toBe(true);
    expect(cadenceSaid("q4h", "observations twice a day")).toBe(false);
    expect(dateSaid("2026-11-11", "on the 11th of November")).toBe(true);
    expect(dateSaid("2026-11-11", "on the eleventh of November")).toBe(true);
    expect(dateSaid("2026-11-12", "on the 11th of November")).toBe(false);
  });
});
