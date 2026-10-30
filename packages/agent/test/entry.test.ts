import { describe, expect, it } from "vitest";
import { encodeWav } from "@hey-pisgah/voice";
import { startEmrServe } from "../src/emr/serve.js";
import { EMERGENCY_KIND, EMERGENCY_LINE, emergencyHeardLoosely, identityFrom, spokenPatient } from "../src/emr/entry.js";
import { gatePrompt } from "../src/emr/gate.js";
import type { EmrCommit, EmrContext, EmrPort, EmrProof, EmrTarget, Provenance, WorkArgs } from "../src/emr/port.js";
import { OWNER, emrRoot, mockClient } from "./emr-helpers.js";

const PATIENT = "aaaaaaaa-1111-4222-8333-444444444444";
const VISIT = "bbbbbbbb-1111-4222-8333-444444444444";
const OTHER = "cccccccc-1111-4222-8333-444444444444";
const CLINIC = "dddddddd-1111-4222-8333-444444444444";

// A hospital that opens one unnamed arrival and knows one other named patient.
class EntryEmr implements EmrPort {
  readonly writeKinds = [EMERGENCY_KIND] as const;
  readonly writes: { kind: string; args: WorkArgs; key: string; prov: Provenance }[] = [];
  readonly reads: EmrTarget[] = [];
  kindsFor(): readonly string[] { return [EMERGENCY_KIND, "record_triage_vitals"]; }
  screenPage(_o: string, kind: string) { return kind === EMERGENCY_KIND ? "doctor_workspace" : undefined; }
  pageHref(page: string) { return page === "doctor_workspace" ? "/worklist-page" : undefined; }
  refusedCount() { return 0; }
  async resolve(target: EmrTarget): Promise<EmrContext> {
    this.reads.push(target);
    if (target.patient_id === PATIENT) return { admission_id: "", patient_id: PATIENT, visit_id: VISIT, label: "Unknown arrival 19:42", facts: {}, keywords: [] };
    if (target.patient_id === OTHER) return { admission_id: "", patient_id: OTHER, visit_id: null, label: "Bassey Okon", facts: {}, keywords: [] };
    throw new Error("unknown patient");
  }
  async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    if (!this.writes.some((w) => w.key === key)) this.writes.push({ kind, args, key, prov });
    return { ok: true, record_id: PATIENT, record_version: 1, event_ids: [`patient:${PATIENT}`, `visit:${VISIT}`], replayed: false };
  }
  async prove(_k: string, _a: WorkArgs, w: { record_id: string; record_version: number; event_ids: string[] }): Promise<EmrProof> {
    return { ...w, record_hash: "0".repeat(64), verified_at: new Date().toISOString(), read: "board row" };
  }
}

const STRIP = "http://localhost:3311";
const post = async (url: string, b: unknown) => { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: STRIP }, body: JSON.stringify(b) }); return { status: r.status, body: (await r.json()) as any }; };
const chunk = (said: string) => encodeWav(new Float32Array(16000).map((_, i) => Math.sin(i / 3) * (said ? 0.3 : 0)), 16000);

async function boot(heard: string[] = []) {
  const root = emrRoot();
  const port = new EntryEmr();
  let calls = 0;
  const client = mockClient(root, () => { calls += 1; return { decision: "aside", summary: "x" }; }, () => null);
  const s = await startEmrServe({
    storeRoot: root, port, client, listenPort: 0, runtime: { holdMs: 0, proofRetryMs: 1 }, emergencyClinicId: CLINIC, ears: "off",
    transcribe: async (_w, _k, sessionId) => ({ final: true, text: heard.shift() ?? "", audio_ms: 1000, session_id: sessionId, cost_usd: 0 })
  });
  return { s, port, calls: () => calls };
}

describe("hands-free entry rules", () => {
  it("hears the emergency phrase as transcribed, and not the word emergency in passing", () => {
    for (const yes of ["hey Pisgah, emergency", "Hey Pisgah emergency, male about forty", "Okay, Pisgah. Emergency.", "hey pizgah emergency"]) expect(EMERGENCY_LINE.test(yes)).toBe(true);
    for (const no of ["this is an emergency admission", "page the emergency team", "hey there emergency", "Pisgah"]) expect(EMERGENCY_LINE.test(no)).toBe(false);
  });

  it("accepts a loose transcript only for audio the device heard as emergency", () => {
    for (const yes of ["Hypiska,Hey, emergency!", "Hey Pisgah emergency", "hi pizga, emergency", "Hey, emergency.", "Heape is the emergency"]) expect(emergencyHeardLoosely(yes)).toBe(true);
    for (const no of ["page the emergency team", "this is an emergency admission", "emergency", "the patient is stable", "hey nurse, emergency bay three", "help us, emergency", "happy that it is not an emergency"]) expect(emergencyHeardLoosely(no)).toBe(false);
  });

  it("takes a spoken name and phone only from a naming phrase", () => {
    expect(identityFrom("Her name is Grace Okafor, phone 0803 123 4567")).toEqual({ name: "Grace Okafor", phone: "08031234567", words: "Her name is Grace Okafor" });
    expect(identityFrom("he says his name is Emeka John Obi")).toMatchObject({ name: "Emeka John Obi", phone: null });
    expect(identityFrom("the patient is Ngozi Eze and her number is +234 805 000 1111")).toMatchObject({ name: "Ngozi Eze", phone: "08050001111" });
    expect(identityFrom("Her name is Grace Okafor, phone zero eight zero three one two three four five six seven")).toMatchObject({ phone: "08031234567" });
    expect(identityFrom("her name is grace")).toBeNull();
    expect(identityFrom("pulse 110, BP 90 over 60")).toBeNull();
  });

  it("takes a name and phone said the way people say them, hesitations and repeats included", () => {
    expect(identityFrom("Her name is Grace, Grace Okafor, the number is oh-eight-oh-three, one two three, four five six seven.")).toMatchObject({ name: "Grace Okafor", phone: "08031234567" });
    expect(identityFrom("Em, her name na Grace Okafor, her number na zero eight zero three one two three four five six seven")).toMatchObject({ name: "Grace Okafor", phone: "08031234567" });
    // The local streaming ear hears "her name na" as "her name now" (rehearsal, 30 Oct).
    expect(identityFrom("She's talking small now. Her name now blessing. Blessing Adie me. The number is over eight oh three")).toMatchObject({ name: "Blessing Adie" });
    expect(identityFrom("She's talking small now. Her name no Blessing Adimi. The number is over eight over three, one two three four five six seven.")).toMatchObject({ name: "Blessing Adimi", phone: "08031234567" });
    expect(identityFrom("His name is Amika, Emikonvosu. Phone is zero eight zero six")).toMatchObject({ name: "Amika Emikonvosu" });
    expect(identityFrom("Her name is Grace, Grace Okafor")).toMatchObject({ name: "Grace Okafor" });
    // "over" alone, or in a short run, is never a digit.
    expect(identityFrom("Her name is Grace Okafor, she has been ill over three days")).toMatchObject({ name: "Grace Okafor", phone: null });
    expect(identityFrom("the bystander said she's called, eh, Blessing... Blessing Adeyemi")).toMatchObject({ name: "Blessing Adeyemi", phone: null });
    expect(identityFrom("They call him Chukwuemeka Obi, he no get phone")).toMatchObject({ name: "Chukwuemeka Obi", phone: null });
    // A first name alone, or a name nobody gave for this patient, is not taken.
    expect(identityFrom("her name is Grace, we don't know the surname yet")).toBeNull();
    expect(identityFrom("call Dr Ime Udo for the review")).toBeNull();
  });

  it("moves to a patient only when one known name matches after a switch phrase", () => {
    const known = [{ label: "Bassey Okon", target: { patient_id: OTHER } }, { label: "Unknown arrival 19:42", target: { patient_id: PATIENT } }];
    expect(spokenPatient("now Mr Okon, his pulse is 90", known)?.target).toEqual({ patient_id: OTHER });
    expect(spokenPatient("Okon is on the list", known)).toBeNull();
    expect(spokenPatient("now Mrs Adeyemi", known)).toBeNull();
  });

  it("keeps the emergency kind out of the speech gate's prompt", () => {
    expect(gatePrompt(["record_triage_vitals"])).not.toContain(EMERGENCY_KIND);
  });

});

describe("the unidentified arrival through serve", () => {
  it("opens an unnamed arrival with no patient open, with provenance, a speed log, a bound screen and no model call", async () => {
    const { s, port, calls } = await boot();
    const spokenAt = new Date(Date.now() - 300).toISOString();
    const r = await post(`${s.url}/tasks/emergency`, { owner: OWNER, spokenAt, wake: { latency_ms: 420 } });
    expect(r.status).toBe(202);
    await s.runtime.settled();
    expect(port.writes).toHaveLength(1);
    const w = port.writes[0]!;
    expect(w.kind).toBe(EMERGENCY_KIND);
    expect(w.args).toMatchObject({ reason: expect.stringContaining("Emergency arrival"), clinic_id: CLINIC, unidentified_ref: expect.stringMatching(/^Unknown arrival \d\d:\d\d$/) });
    expect(w.prov).toEqual({ owner: OWNER, evidence: `transcript:${r.body.line_id}`, spoken_at: spokenAt });
    const v = s.runtime.view(r.body.task_id)!;
    expect(v).toMatchObject({ patient_id: PATIENT, visit_id: VISIT, unidentified: true, state: "done" });
    expect(v.actions[0]).toMatchObject({ state: "completed", proof: { record_id: PATIENT }, screen: { page: "doctor_workspace", href: "/worklist-page", command_id: r.body.action_id, owner_id: OWNER, encounter: { patient_id: PATIENT, visit_id: VISIT } } });
    expect(v.speed.rows).toHaveLength(1);
    expect(v.speed.rows[0]).toMatchObject({ action_id: r.body.action_id, from: spokenAt });
    expect(v.speed.rows[0]!.ms).toBeGreaterThanOrEqual(0);
    expect(calls()).toBe(0);
    expect((await post(`${s.url}/tasks/tracking?owner=${OWNER}`, {})).status).toBe(404);
    const tr = await (await fetch(`${s.url}/tasks/tracking?owner=${OWNER}`)).json();
    expect(tr).toEqual({ owner: OWNER, target: { patient_id: PATIENT } });
    await s.close();
  });

  it("holds the spoken identity as an obligation and writes nothing to the record", async () => {
    const { s, port, calls } = await boot();
    const r = await post(`${s.url}/tasks/emergency`, { owner: OWNER, spokenAt: new Date().toISOString() });
    await s.runtime.settled();
    const said = await post(`${s.url}/tasks/say`, { owner: OWNER, text: "Her name is Grace Okafor, phone 0803 123 4567" });
    expect(said.status).toBe(202);
    expect(said.body.task_id).toBe(r.body.task_id);
    await s.runtime.settled();
    const v = s.runtime.view(r.body.task_id)!;
    expect(v.identities).toEqual([expect.objectContaining({ kind: "identity_pending", state: "open", name: "Grace Okafor", phone: "08031234567", said_by: OWNER, line_id: said.body.line_id, completes_by: "receptionist", encounter: { patient_id: PATIENT, visit_id: VISIT } })]);
    expect(v.transcript.find((x) => x.id === said.body.line_id)).toMatchObject({ kept: true, text: "Her name is Grace Okafor, phone 0803 123 4567" });
    expect(port.writes).toHaveLength(1);
    expect(calls()).toBe(0);
    await s.close();
  });

  it("finishes the phrase from the words just after the device heard the wake word, and not otherwise", async () => {
    const { s, port } = await boot(["Emergency.", "Emergency."]);
    const form = (seq: number, hint?: string) => { const f = new FormData(); f.append("audio", new Blob([chunk("x")], { type: "audio/wav" }), "c.wav"); f.append("owner", OWNER); f.append("session_id", "s-2"); f.append("seq", String(seq)); if (hint) f.append("hint", hint); return f; };
    const plain = await (await fetch(`${s.url}/tasks/listen`, { method: "POST", body: form(0) })).json() as any;
    expect(plain.no_patient).toBe(true);
    const after = await (await fetch(`${s.url}/tasks/listen`, { method: "POST", body: form(1, "after_wake") })).json() as any;
    expect(after.entry).toBe("emergency");
    await s.runtime.settled();
    expect(port.writes).toHaveLength(1);
    await s.close();
  });

  it("refuses a typed line with no patient unless it is the emergency phrase, and opens on the phrase", async () => {
    const { s, port } = await boot();
    expect((await post(`${s.url}/tasks/say`, { owner: OWNER, text: "pulse 110" })).status).toBe(400);
    expect(port.writes).toHaveLength(0);
    expect((await post(`${s.url}/tasks/say`, { owner: OWNER, text: "hey Pisgah, emergency, young man after a road accident" })).status).toBe(202);
    await s.runtime.settled();
    expect(port.writes[0]!.args["reason"]).toBe("Emergency arrival: young man after a road accident");
    await s.close();
  });

  it("listens with no patient: the phrase heard in a transcript opens the arrival, other words are dropped, and the page's patient is tracked", async () => {
    const { s, port } = await boot(["the ward is busy today", "hey Pisgah emergency"]);
    const form = (seq: number, patientId?: string) => { const f = new FormData(); f.append("audio", new Blob([chunk("x")], { type: "audio/wav" }), "c.wav"); f.append("owner", OWNER); f.append("session_id", "s-1"); f.append("seq", String(seq)); if (patientId) f.append("patientId", patientId); return f; };
    const a = await (await fetch(`${s.url}/tasks/listen`, { method: "POST", body: form(0) })).json() as any;
    expect(a).toMatchObject({ no_patient: true, utterances: [] });
    expect(s.runtime.taskIds()).toHaveLength(0);
    const b = await (await fetch(`${s.url}/tasks/listen`, { method: "POST", body: form(1) })).json() as any;
    expect(b.entry).toBe("emergency");
    await s.runtime.settled();
    expect(port.writes).toHaveLength(1);
    const tr = await (await fetch(`${s.url}/tasks/tracking?owner=${OWNER}`)).json() as any;
    expect(tr.target).toEqual({ patient_id: PATIENT });
    // Opening another patient's page moves the agent to that patient; it never stops listening.
    await fetch(`${s.url}/tasks/listen`, { method: "POST", body: form(2, OTHER) });
    expect(((await (await fetch(`${s.url}/tasks/tracking?owner=${OWNER}`)).json()) as any).target).toEqual({ patient_id: OTHER });
    await s.close();
  });
});
