import { ModelClient } from "@hey-pisgah/model";
import { EmrRuntime } from "../src/emr/runtime.js";
import type { EmrCommit, EmrContext, EmrPort, EmrProof, EmrTarget, Provenance, SayableNames, WatchRead, WorkArgs } from "../src/emr/port.js";
import type { SpeechClass } from "../src/emr/gate.js";
import { emrRoot, gater, type C } from "./emr-helpers.js";

export const DOC = "doc-1", OTHER = "doc-2";
export const PAT = "aaaaaaaa-1111-4222-8333-444444444444";
export const VISIT = "bbbbbbbb-1111-4222-8333-444444444444";
export const ADMIT = "cccccccc-1111-4222-8333-444444444444";
export const CLERK_KINDS = ["record_observation", "open_consult", "record_clerking", "record_allergy", "admit_patient", "assign_bed", "schedule_review", "record_note", "add_care_plan_item"];

type Write = { kind: string; args: WorkArgs; key: string; prov: Provenance; id: string };
// A small hospital for the clerking doctor: an arrival that becomes an admission when the agent admits, and a test list a result can change.
export class ClerkFake implements EmrPort {
  readonly writeKinds = ["record_observation"] as const;
  readonly writes: Write[] = [];
  admitted = false;
  tests = "[]";
  kindsFor(): readonly string[] { return CLERK_KINDS; }
  refusedCount(): number { return 0; }
  names(): SayableNames { return { page_targets: {}, clinics: {}, wards: { a_and_e: ["A and E", "emergency ward"], childrens: ["children's ward"] } }; }
  resultFacts(): readonly string[] { return ["orders.tests"]; }
  async resolve(target: EmrTarget): Promise<EmrContext> {
    if (target.admission_id === ADMIT || (target.patient_id === PAT && this.admitted)) return { admission_id: ADMIT, patient_id: PAT, visit_id: VISIT, label: "Child Patient", facts: { ward: "Children's Ward", bed: "C1" }, keywords: [] };
    if (target.patient_id === PAT) return { admission_id: "", patient_id: PAT, visit_id: VISIT, label: "Child Patient", facts: { ward: null, bed: null }, keywords: [] };
    throw new Error("unknown target");
  }
  async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    const hit = this.writes.find((w) => w.key === key);
    if (!hit) {
      this.writes.push({ kind, args, key, prov, id: kind === "admit_patient" ? ADMIT : `${kind}-${this.writes.length + 1}` });
      if (kind === "admit_patient") this.admitted = true;
    }
    const w = this.writes.find((x) => x.key === key)!;
    return { ok: true, record_id: w.id, record_version: 1, event_ids: [`${kind}:${w.id}`], replayed: !!hit };
  }
  async prove(_k: string, _a: WorkArgs, written: { record_id: string; record_version: number; event_ids: string[] }): Promise<EmrProof | null> {
    return { ...written, record_hash: "0".repeat(64), verified_at: new Date().toISOString(), read: "fake" };
  }
  async watch(_owner: string, subject: EmrTarget & { visit_id?: string | null }): Promise<WatchRead | null> {
    return subject.visit_id ? { facts: { "orders.tests": this.tests }, labels: { "orders.tests": "Tests on the visit" } } : null;
  }
}

export type W = Omit<C, "class"> & { class: SpeechClass } & Record<string, unknown>;
export const ins = (kind: string, f: Record<string, unknown> = {}): W => ({ class: "instruction", kind, confidence: 0.95, ...f });
// A runtime over one store with a movable clock, so a test can restart it and move time past an obligation.
export function clerkBoot(script: (said: string) => W[], o: { root?: string; port?: ClerkFake; clock?: { now: number }; watchMs?: number } = {}) {
  const root = o.root ?? emrRoot();
  const port = o.port ?? new ClerkFake();
  const clock = o.clock ?? { now: Date.now() };
  let rt: EmrRuntime | null = null;
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater((s) => script(s) as unknown as C[]), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1, obligationTickMs: 20, wallNow: () => new Date(clock.now), ...(o.watchMs ? { watchMs: o.watchMs } : {}) });
  rt.start();
  return { rt, port, root, clock, client };
}
