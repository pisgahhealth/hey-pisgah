import { describe, expect, it } from "vitest";
import { encodeWav } from "@hey-pisgah/voice";
import { startEmrServe } from "../src/emr/serve.js";
import { EMERGENCY_KIND } from "../src/emr/entry.js";
import type { DelegationRead } from "../src/emr/delegate.js";
import type { EmrCommit, EmrContext, EmrPort, EmrProof, EmrTarget, Provenance, WorkArgs } from "../src/emr/port.js";
import { OWNER, emrRoot, mockClient, until } from "./emr-helpers.js";

const ARRIVAL = "aaaaaaaa-1111-4222-8333-444444444444";
const VISIT = "bbbbbbbb-1111-4222-8333-444444444444";
const PAGE_A = "cccccccc-1111-4222-8333-444444444444";
const PAGE_B = "eeeeeeee-1111-4222-8333-444444444444";
const TASK_B = "ffffffff-1111-4222-8333-444444444444";

// A hospital with one unnamed arrival to open, two named patients, an optional slow or refused arrival write and one task handed to this owner for patient B.
class ContextEmr implements EmrPort {
  readonly writeKinds = [EMERGENCY_KIND] as const;
  readonly writes: { kind: string; args: WorkArgs; key: string; prov: Provenance }[] = [];
  gate: Promise<void> | null = null;
  refuse = false;
  // Saves the arrival and loses the answer this many times.
  lose = 0;
  handed: DelegationRead[] = [];
  kindsFor(): readonly string[] { return [EMERGENCY_KIND, "record_triage_vitals"]; }
  refusedCount() { return 0; }
  async resolve(target: EmrTarget): Promise<EmrContext> {
    const id = target.patient_id ?? target.admission_id;
    if (id === ARRIVAL) return { admission_id: "", patient_id: ARRIVAL, visit_id: VISIT, label: "Unknown arrival 19:42", facts: {}, keywords: [] };
    if (id === PAGE_A) return { admission_id: "", patient_id: PAGE_A, visit_id: null, label: "Bassey Okon", facts: {}, keywords: [] };
    if (id === PAGE_B) return { admission_id: "", patient_id: PAGE_B, visit_id: null, label: "Ngozi Eze", facts: {}, keywords: [] };
    throw new Error("unknown patient");
  }
  async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    if (this.gate) await this.gate;
    if (this.refuse) return { ok: false, reason: "door_409_conflict", status: 409, retryable: false, counted: false };
    if (!this.writes.some((w) => w.key === key)) this.writes.push({ kind, args, key, prov });
    if (this.lose > 0) { this.lose -= 1; return { ok: false, reason: "timeout", status: null, retryable: true, counted: false }; }
    return { ok: true, record_id: ARRIVAL, record_version: 1, event_ids: [`patient:${ARRIVAL}`, `visit:${VISIT}`], replayed: false };
  }
  async prove(_k: string, _a: WorkArgs, w: { record_id: string; record_version: number; event_ids: string[] }): Promise<EmrProof> {
    return { ...w, record_hash: "0".repeat(64), verified_at: new Date().toISOString(), read: "board row" };
  }
  delegationSide() { return "assignee" as const; }
  delegationOwners() { return [OWNER]; }
  async delegations(): Promise<DelegationRead[]> { return this.handed; }
  async delegation(_o: string, id: string): Promise<DelegationRead | null> { return this.handed.find((d) => d.id === id) ?? null; }
}

const STRIP = "http://localhost:3311";
const post = async (url: string, b: unknown) => { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: STRIP }, body: JSON.stringify(b) }); return { status: r.status, body: (await r.json()) as any }; };
const chunk = () => encodeWav(new Float32Array(16000).map((_, i) => Math.sin(i / 3) * 0.3), 16000);
type Part = { session: string; seq: number; patientId?: string; capturedAt?: number };
const listen = async (url: string, p: Part) => {
  const f = new FormData();
  f.append("audio", new Blob([chunk()], { type: "audio/wav" }), "c.wav");
  f.append("owner", OWNER); f.append("session_id", p.session); f.append("seq", String(p.seq));
  if (p.patientId) f.append("patientId", p.patientId);
  if (p.capturedAt !== undefined) f.append("captured_at", String(p.capturedAt));
  return (await (await fetch(`${url}/tasks/listen?wait=1`, { method: "POST", body: f })).json()) as any;
};
const tracking = async (url: string) => ((await (await fetch(`${url}/tasks/tracking?owner=${OWNER}`)).json()) as any).target;

async function boot(heard: string[] = [], again?: { root: string; port: ContextEmr }, extra: { reconcileMs?: number[]; pendingMaxMs?: number } = {}) {
  const root = again?.root ?? emrRoot();
  const port = again?.port ?? new ContextEmr();
  const client = mockClient(root, () => ({ decision: "aside", summary: "x" }), () => null);
  const s = await startEmrServe({
    storeRoot: root, port, client, listenPort: 0, runtime: { holdMs: 0, proofRetryMs: 1, ...(extra.reconcileMs ? { reconcileMs: extra.reconcileMs } : {}) }, ears: "off", ...(extra.pendingMaxMs ? { pendingMaxMs: extra.pendingMaxMs } : {}),
    transcribe: async (_w, _k, sessionId) => ({ final: true, text: heard.shift() ?? "", audio_ms: 1000, session_id: sessionId, cost_usd: 0 })
  });
  return { s, port, root };
}
const lineIn = (s: Awaited<ReturnType<typeof boot>>["s"], taskId: string, text: string) => s.runtime.view(taskId)!.transcript.some((x) => x.text === text);

describe("the patient the clinician is with", () => {
  it("keeps a patient created by voice when a new listening session's first upload has no page patient", async () => {
    const { s } = await boot(["Okay she's, em, she's breathing better now, the pain has eased small."]);
    const arrival = await post(`${s.url}/tasks/emergency`, { owner: OWNER, spokenAt: new Date().toISOString() });
    await s.runtime.settled();
    expect(await tracking(s.url)).toEqual({ patient_id: ARRIVAL });
    const r = await listen(s.url, { session: "s-new", seq: 0 });
    expect(r.no_patient).toBeUndefined();
    expect(r.tracking).toEqual({ patient_id: ARRIVAL });
    expect(r.utterances[0]?.task_id).toBe(arrival.body.task_id);
    expect(await tracking(s.url)).toEqual({ patient_id: ARRIVAL });
    await s.close();
  });

  it("starts a new session with no patient when the one the agent is with was chosen long ago", async () => {
    const { s } = await boot(["Okay she's, em, she's breathing better now, the pain has eased small."]);
    await post(`${s.url}/tasks/emergency`, { owner: OWNER, spokenAt: new Date(Date.now() - 40 * 60_000).toISOString() });
    await s.runtime.settled();
    expect(await tracking(s.url)).toEqual({ patient_id: ARRIVAL });
    const r = await listen(s.url, { session: "s-later", seq: 0 });
    expect(r.no_patient).toBe(true);
    expect(await tracking(s.url)).toBeNull();
    await s.close();
  });

  it("never moves the active patient when a task for another patient is handed to this owner", async () => {
    const { s, port } = await boot(["Mama, how are you feeling this morning?", "Okay, the pain don reduce, good."]);
    const a = await listen(s.url, { session: "s-1", seq: 0, patientId: PAGE_A });
    expect(a.tracking).toEqual({ patient_id: PAGE_A });
    port.handed = [{
      id: TASK_B, kind: "review", title: "Surgical review", patient_id: PAGE_B, admission_id: null, visit_id: null, state: "assigned", assignee: null, rule: "on_duty", acknowledged_at: null, completed_at: null, completion_record_id: null,
      due_at: null, overdue: false, escalated_at: null, record: { status: "unsupported_or_incomplete", record_id: null, reason: null }, instruction: null, nudged: [], subject_id: null, subject_prepared: null, order_received: null, consult_finished: null
    }];
    await s.runtime.pollOnce();
    expect(s.runtime.openSubjects(OWNER).some((x) => x.target.patient_id === PAGE_B)).toBe(true);
    expect(await tracking(s.url)).toEqual({ patient_id: PAGE_A });
    const b = await listen(s.url, { session: "s-1", seq: 1, patientId: PAGE_A });
    expect(b.tracking).toEqual({ patient_id: PAGE_A });
    await s.close();
  });

  it("binds a delayed upload to the patient it was captured with, not one chosen after it was said", async () => {
    const { s } = await boot(["Abeg who moved the BP machine?"]);
    const before = Date.now() - 2000;
    await post(`${s.url}/tasks/emergency`, { owner: OWNER, spokenAt: new Date(before + 1000).toISOString() });
    await s.runtime.settled();
    expect(await tracking(s.url)).toEqual({ patient_id: ARRIVAL });
    // Captured with no patient before the phrase, uploaded after the arrival was confirmed: it is not the arrival's.
    const late = await listen(s.url, { session: "s-2", seq: 0, capturedAt: before });
    expect(late.tracking).toBeUndefined();
    expect(late.no_patient).toBe(true);
    // Captured on page A, uploaded after the agent moved to the arrival: it stays page A's.
    const { s: s2 } = await boot(["Oya let me see the chest, breathe in.", "Fine, fine, breathe out."]);
    const first = await listen(s2.url, { session: "s-3", seq: 0, patientId: PAGE_A, capturedAt: Date.now() - 3000 });
    expect(first.tracking).toEqual({ patient_id: PAGE_A });
    await post(`${s2.url}/tasks/emergency`, { owner: OWNER, spokenAt: new Date(Date.now() - 1000).toISOString() });
    await s2.runtime.settled();
    const delayed = await listen(s2.url, { session: "s-3", seq: 1, patientId: PAGE_A, capturedAt: Date.now() - 2000 });
    expect(delayed.tracking).toEqual({ patient_id: PAGE_A });
    await s.close();
    await s2.close();
  });

  it("buffers speech after the emergency phrase until the arrival is confirmed, then binds it to the arrival", async () => {
    const { s, port } = await boot(["Her name is Grace, Grace Okafor, the number is oh-eight-oh-three, one two three, four five six seven"]);
    let open!: () => void;
    port.gate = new Promise((r) => { open = r; });
    const arrival = await post(`${s.url}/tasks/emergency`, { owner: OWNER, spokenAt: new Date(Date.now() - 500).toISOString() });
    const heard = await listen(s.url, { session: "s-4", seq: 0, capturedAt: Date.now() });
    expect(heard.pending).toBe(true);
    const typed = await post(`${s.url}/tasks/say`, { owner: OWNER, text: "He's about forty, em, they found him by the roadside, no ID on him." });
    expect(typed.status).toBe(202);
    expect(typed.body.pending).toBe(true);
    // A second phrase while the first arrival is pending opens nothing more.
    const again = await post(`${s.url}/tasks/emergency`, { owner: OWNER, spokenAt: new Date().toISOString() });
    expect(again.body.task_id).toBe(arrival.body.task_id);
    open();
    await until(() => s.runtime.view(arrival.body.task_id)!.identities.length === 1 && lineIn(s, arrival.body.task_id, "He's about forty, em, they found him by the roadside, no ID on him."));
    await s.runtime.settled();
    expect(port.writes).toHaveLength(1);
    expect(s.runtime.view(arrival.body.task_id)!.identities[0]).toMatchObject({ name: "Grace Okafor", encounter: { patient_id: ARRIVAL } });
    await s.close();
  });

  it("drops the buffered speech and says so when the arrival is refused", async () => {
    const { s, port } = await boot(["Her name is Grace, Grace Okafor, the number is oh-eight-oh-three, one two three, four five six seven"]);
    let open!: () => void;
    port.gate = new Promise((r) => { open = r; });
    port.refuse = true;
    await post(`${s.url}/tasks/emergency`, { owner: OWNER, spokenAt: new Date().toISOString() });
    const heard = await listen(s.url, { session: "s-5", seq: 0, capturedAt: Date.now() });
    expect(heard.pending).toBe(true);
    open();
    await s.runtime.settled();
    await until(() => true);
    const st = (await (await fetch(`${s.url}/tasks/listen?owner=${OWNER}&session_id=s-5`)).json()) as any;
    expect(st.utterances.find((u: any) => u.seq === 0)).toMatchObject({ status: "failed" });
    expect(await tracking(s.url)).toBeNull();
    expect(s.runtime.taskIds().every((id) => s.runtime.view(id)!.identities.length === 0)).toBe(true);
    await s.close();
  });

  it("keeps the speech held for an arrival whose answer was lost twice until the arrival is known, then binds it there", async () => {
    const { s, port } = await boot(["Her name is Grace, Grace Okafor, the number is oh-eight-oh-three, one two three, four five six seven"], undefined, { reconcileMs: [400], pendingMaxMs: 50 });
    port.lose = 2;
    const arrival = await post(`${s.url}/tasks/emergency`, { owner: OWNER, spokenAt: new Date(Date.now() - 500).toISOString() });
    const heard = await listen(s.url, { session: "s-lost", seq: 0, capturedAt: Date.now() });
    expect(heard.pending).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(s.runtime.view(arrival.body.task_id)!.actions[0]!.state).toBe("uncertain");
    await until(() => s.runtime.view(arrival.body.task_id)!.identities.length === 1, 5000);
    await s.runtime.settled();
    expect(port.writes).toHaveLength(1);
    expect(s.runtime.view(arrival.body.task_id)!.identities[0]).toMatchObject({ name: "Grace Okafor", encounter: { patient_id: ARRIVAL } });
    const st = (await (await fetch(`${s.url}/tasks/listen?owner=${OWNER}&session_id=s-lost`)).json()) as any;
    expect(st.utterances.find((u: any) => u.seq === 0)?.status).not.toBe("failed");
    await s.close();
  });

  it("opens one arrival for one phrase when the device and the transcript both hear it", async () => {
    const { s, port } = await boot(["Hey Pisgah, emergency."]);
    const spoken = Date.now() - 300;
    const device = await post(`${s.url}/tasks/emergency`, { owner: OWNER, spokenAt: new Date(spoken).toISOString() });
    await s.runtime.settled();
    const f = new FormData();
    f.append("audio", new Blob([chunk()], { type: "audio/wav" }), "c.wav");
    f.append("owner", OWNER); f.append("session_id", "s-6"); f.append("seq", "0"); f.append("hint", "emergency"); f.append("captured_at", String(spoken - 1200));
    const heard = (await (await fetch(`${s.url}/tasks/listen`, { method: "POST", body: f })).json()) as any;
    expect(heard.entry).toBe("emergency");
    expect(heard.utterances[0].task_id).toBe(device.body.task_id);
    await s.runtime.settled();
    expect(port.writes).toHaveLength(1);
    await s.close();
  });

  it("opens the same pending arrival from the Emergency press, binds the words said after it, and one arrival per press", async () => {
    const { s, port } = await boot(["Her name is Grace, Grace Okafor, the number is oh-eight-oh-three, one two three, four five six seven"]);
    let open!: () => void;
    port.gate = new Promise((r) => { open = r; });
    const pressed = await post(`${s.url}/tasks/emergency`, { owner: OWNER, press: true, spokenAt: new Date().toISOString() });
    expect(pressed.status).toBe(202);
    const heard = await listen(s.url, { session: "s-7", seq: 0, capturedAt: Date.now() });
    expect(heard.pending).toBe(true);
    const twice = await post(`${s.url}/tasks/emergency`, { owner: OWNER, press: true, spokenAt: new Date().toISOString() });
    expect(twice.body.task_id).toBe(pressed.body.task_id);
    open();
    await until(() => s.runtime.view(pressed.body.task_id)!.identities.length === 1);
    await s.runtime.settled();
    const v = s.runtime.view(pressed.body.task_id)!;
    expect(v.transcript[0]).toMatchObject({ text: "Emergency button pressed", source: "text" });
    expect(port.writes).toHaveLength(1);
    expect(port.writes[0]!.args["reason"]).toBe("Emergency arrival, opened by a press; reason not yet stated");
    expect(port.writes[0]!.prov.evidence).toBe(`transcript:${pressed.body.line_id}`);
    // A press after the first arrival is confirmed is a new arrival.
    const next = await post(`${s.url}/tasks/emergency`, { owner: OWNER, press: true, spokenAt: new Date().toISOString() });
    await s.runtime.settled();
    expect(next.body.task_id).not.toBe(pressed.body.task_id);
    expect(port.writes).toHaveLength(2);
    await s.close();
  });

  it("remembers the patient the clinician is with across a serve restart, and the page it was last on", async () => {
    const first = await boot();
    await listen(first.s.url, { session: "s-r", seq: 0, patientId: PAGE_A });
    expect(await tracking(first.s.url)).toEqual({ patient_id: PAGE_A });
    await post(`${first.s.url}/tasks/emergency`, { owner: OWNER, spokenAt: new Date().toISOString() });
    await first.s.runtime.settled();
    expect(await tracking(first.s.url)).toEqual({ patient_id: ARRIVAL });
    await first.s.close();
    // Reproduced: a restarted serve forgot the arrival, and the same page then moved the agent back to patient A.
    const again = await boot([], first);
    expect(await tracking(again.s.url)).toEqual({ patient_id: ARRIVAL });
    const r = await listen(again.s.url, { session: "s-r2", seq: 0, patientId: PAGE_A });
    expect(r.tracking).toEqual({ patient_id: ARRIVAL });
    // Negative control: moving to another page after the restart still moves the agent.
    const b = await listen(again.s.url, { session: "s-r2", seq: 1, patientId: PAGE_B });
    expect(b.tracking).toEqual({ patient_id: PAGE_B });
    await again.s.close();
  });

  it("moves back to a named arrival by the name said for it, though its label still reads unknown", async () => {
    const { s } = await boot(["", "Okay, back to Blessing."]);
    await post(`${s.url}/tasks/emergency`, { owner: OWNER, spokenAt: new Date().toISOString() });
    await s.runtime.settled();
    const named = await post(`${s.url}/tasks/say`, { owner: OWNER, patientId: ARRIVAL, text: "Her name is Blessing, Blessing Adeyemi, the number is 08031234567." });
    expect(named.status).toBe(202);
    await s.runtime.settled();
    expect(s.runtime.views(OWNER).flatMap((v) => v.identities).map((i) => i.name)).toContain("Blessing Adeyemi");
    expect((await listen(s.url, { session: "s-name", seq: 0, patientId: PAGE_A })).tracking).toEqual({ patient_id: PAGE_A });
    // The words are a second long and dated from when they began, so they are said after the page opened, as on the ward.
    await new Promise((r) => setTimeout(r, 1300));
    await listen(s.url, { session: "s-name", seq: 1 });
    await s.runtime.settled();
    expect(await tracking(s.url)).toEqual({ patient_id: ARRIVAL });
    await s.close();
  });

  it("never gives the wake phrase to the gate after the device opened the arrival for it, so it cannot become note text (pass 10c B01)", async () => {
    const { s } = await boot(["Hep is the emergency", "Another one coming in, young man, motorcycle accident."]);
    const arrival = await post(`${s.url}/tasks/emergency`, { owner: OWNER, spokenAt: new Date().toISOString() });
    await s.runtime.settled();
    const lines = () => s.runtime.view(arrival.body.task_id)!.transcript.length;
    const opened = lines();
    await listen(s.url, { session: "s-wake2", seq: 0 });
    await s.runtime.settled();
    expect(lines()).toBe(opened);
    // Negative control: the words after the phrase still reach the arrival.
    await new Promise((r) => setTimeout(r, 1100));
    await listen(s.url, { session: "s-wake2", seq: 1 });
    await s.runtime.settled();
    expect(lines()).toBe(opened + 1);
    await s.close();
  });

  it("opens a second arrival from the phrase as the local ear writes it while a patient is open, and not from a bare hey emergency", async () => {
    const { s } = await boot(["", "Hey, emergency.", "Heape is the emergency"]);
    await listen(s.url, { session: "s-wake", seq: 0, patientId: PAGE_A });
    await s.runtime.settled();
    const before = s.runtime.views(OWNER).filter((v) => v.actions.some((a) => a.kind === EMERGENCY_KIND)).length;
    await new Promise((r) => setTimeout(r, 1100));
    await listen(s.url, { session: "s-wake", seq: 1, patientId: PAGE_A });
    await s.runtime.settled();
    expect(s.runtime.views(OWNER).filter((v) => v.actions.some((a) => a.kind === EMERGENCY_KIND)).length).toBe(before);
    await new Promise((r) => setTimeout(r, 1100));
    await listen(s.url, { session: "s-wake", seq: 2, patientId: PAGE_A });
    await s.runtime.settled();
    await until(() => s.runtime.views(OWNER).filter((v) => v.actions.some((a) => a.kind === EMERGENCY_KIND)).length === before + 1);
    await s.close();
  });
});
