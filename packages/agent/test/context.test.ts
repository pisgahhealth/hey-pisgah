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

async function boot(heard: string[] = []) {
  const root = emrRoot();
  const port = new ContextEmr();
  const client = mockClient(root, () => ({ decision: "aside", summary: "x" }), () => null);
  const s = await startEmrServe({
    storeRoot: root, port, client, listenPort: 0, runtime: { holdMs: 0, proofRetryMs: 1 }, ears: "off",
    transcribe: async (_w, _k, sessionId) => ({ final: true, text: heard.shift() ?? "", audio_ms: 1000, session_id: sessionId, cost_usd: 0 })
  });
  return { s, port };
}
const lineIn = (s: Awaited<ReturnType<typeof boot>>["s"], taskId: string, text: string) => s.runtime.view(taskId)!.transcript.some((x) => x.text === text);

describe("the patient the clinician is with", () => {
  it("keeps a patient created by voice when a new listening session's first upload has no page patient", async () => {
    const { s } = await boot(["she is breathing comfortably now."]);
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

  it("never moves the active patient when a task for another patient is handed to this owner", async () => {
    const { s, port } = await boot(["first words on A.", "second words on A."]);
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
    const { s } = await boot(["words said before the emergency."]);
    const before = Date.now() - 2000;
    await post(`${s.url}/tasks/emergency`, { owner: OWNER, spokenAt: new Date(before + 1000).toISOString() });
    await s.runtime.settled();
    expect(await tracking(s.url)).toEqual({ patient_id: ARRIVAL });
    // Captured with no patient before the phrase, uploaded after the arrival was confirmed: it is not the arrival's.
    const late = await listen(s.url, { session: "s-2", seq: 0, capturedAt: before });
    expect(late.tracking).toBeUndefined();
    expect(late.no_patient).toBe(true);
    // Captured on page A, uploaded after the agent moved to the arrival: it stays page A's.
    const { s: s2 } = await boot(["said on A.", "said on A again."]);
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
    const { s, port } = await boot(["Her name is Grace Okafor, phone 0803 123 4567"]);
    let open!: () => void;
    port.gate = new Promise((r) => { open = r; });
    const arrival = await post(`${s.url}/tasks/emergency`, { owner: OWNER, spokenAt: new Date(Date.now() - 500).toISOString() });
    const heard = await listen(s.url, { session: "s-4", seq: 0, capturedAt: Date.now() });
    expect(heard.pending).toBe(true);
    const typed = await post(`${s.url}/tasks/say`, { owner: OWNER, text: "Male, about forty, found at the roadside." });
    expect(typed.status).toBe(202);
    expect(typed.body.pending).toBe(true);
    // A second phrase while the first arrival is pending opens nothing more.
    const again = await post(`${s.url}/tasks/emergency`, { owner: OWNER, spokenAt: new Date().toISOString() });
    expect(again.body.task_id).toBe(arrival.body.task_id);
    open();
    await until(() => s.runtime.view(arrival.body.task_id)!.identities.length === 1 && lineIn(s, arrival.body.task_id, "Male, about forty, found at the roadside."));
    await s.runtime.settled();
    expect(port.writes).toHaveLength(1);
    expect(s.runtime.view(arrival.body.task_id)!.identities[0]).toMatchObject({ name: "Grace Okafor", encounter: { patient_id: ARRIVAL } });
    await s.close();
  });

  it("drops the buffered speech and says so when the arrival is refused", async () => {
    const { s, port } = await boot(["Her name is Grace Okafor"]);
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
});
