import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEmrServe, type EmrCommit, type EmrContext, type EmrPort, type EmrProof, type EmrRuntime, type EmrTarget, type Provenance, type SayableNames, type WatchOffer, type WatchRead, type WorkArgs } from "@hey-pisgah/agent";
import { journeyResults, loadJourney, type JourneyResults, type JourneyScript } from "@hey-pisgah/evaluator";
import { ModelClient, type MockResponder } from "@hey-pisgah/model";
import { ledgerOf, runJourney, type PersonCall } from "./journey.js";

export const FAKE = {
  patient: "a0000000-0000-4000-8000-000000000001", visit: "a0000000-0000-4000-8000-000000000002", admission: "a0000000-0000-4000-8000-000000000003",
  ward: "a0000000-0000-4000-8000-000000000004", bed: "a0000000-0000-4000-8000-000000000005",
  owners: { doctor: "fake-doctor", nurse: "fake-nurse", accounts: "fake-accounts" }
} as const;
const KINDS: Record<string, string[]> = {
  [FAKE.owners.doctor]: ["record_observation", "draft_consult_note", "request_admission", "record_note", "page_staff", "schedule_follow_up"],
  [FAKE.owners.nurse]: ["record_observation", "record_triage_vitals", "add_care_plan_item", "record_note", "draft_handover", "page_staff"],
  [FAKE.owners.accounts]: ["prepare_bill", "send_pay_link", "page_staff"]
};

// An in-memory hospital for the journey: one arriving patient, an admission the doctor's agent requests, and the stages the person steps move; it keeps every write in order.
export class JourneyFakeHospital implements EmrPort {
  readonly writeKinds = ["record_observation"] as const;
  readonly writes: { kind: string; args: WorkArgs; key: string; owner: string; id: string }[] = [];
  readonly refused: string[] = [];
  // Until D10 the EMR refuses an agent's draft of a consultation its owner holds; set true to play the ruling.
  agentMayDraft = false;
  state = { requested: false, accepted: false, bed: false, stage: "awaiting_sign_off", payLink: null as string | null, cleared: false, pulse: null as number | null, temp: null as string | null, notes: [] as string[], items: [] as string[] };
  kindsFor(owner: string): readonly string[] { return KINDS[owner] ?? []; }
  // Like the EMR, nothing reads a sent pay link back.
  unverifiable(kind: string): string | null { return kind === "send_pay_link" ? "the bill does not show pay links" : null; }
  refusedCount(): number { return this.refused.length; }
  names(): SayableNames { return { page_targets: { lab: ["lab", "laboratory"], pharmacy: ["pharmacy", "pharmacist"], accounts: ["accounts", "billing"] }, clinics: { gopd: ["GOPD", "general outpatients", "outpatients"] } }; }
  offers(owner: string): readonly WatchOffer[] {
    return owner === FAKE.owners.accounts ? [{ fact: "discharge.stage", equals: "signed_off", kind: "send_pay_link", ask: "Clinical sign-off is done for this patient. Say send the pay link when you want it sent." }] : [];
  }
  async resolve(target: EmrTarget, _p: Provenance): Promise<EmrContext> {
    const admitted = this.state.requested && (target.admission_id === FAKE.admission || target.patient_id === FAKE.patient);
    const facts = { ward: this.state.bed ? "Emergency Ward" : null, bed: this.state.bed ? "Bed 1" : null, pulse: this.state.pulse === null ? null : String(this.state.pulse), temp_c: this.state.temp };
    if (admitted) return { admission_id: FAKE.admission, patient_id: FAKE.patient, visit_id: FAKE.visit, label: "Journey Patient", facts, keywords: [] };
    if (target.patient_id === FAKE.patient) return { admission_id: "", patient_id: FAKE.patient, visit_id: FAKE.visit, label: "Journey Patient", facts, keywords: [] };
    throw new Error("unknown target");
  }
  async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    if (!this.kindsFor(prov.owner).includes(kind)) { this.refused.push(kind); return { ok: false, reason: "kind_not_held", status: null, retryable: false, counted: true }; }
    const hit = this.writes.find((w) => w.key === key);
    if (hit) return { ok: true, record_id: hit.id, record_version: 1, event_ids: [`${kind}:${hit.id}`], replayed: true };
    if (kind === "send_pay_link" && this.state.stage !== "signed_off") return { ok: false, reason: "door_409_conflict", status: 409, retryable: false, counted: false };
    if (kind === "draft_consult_note" && !this.agentMayDraft) return { ok: false, reason: "door_404_not_found_opaque", status: 404, retryable: false, counted: false };
    const id = kind === "request_admission" ? FAKE.admission : `${kind}-${this.writes.length + 1}`;
    this.writes.push({ kind, args, key, owner: prov.owner, id });
    if (kind === "request_admission") this.state.requested = true;
    if (kind === "record_observation" || kind === "record_triage_vitals") { if (typeof args["pulse"] === "number") this.state.pulse = args["pulse"]; if (typeof args["temp_c"] === "string") this.state.temp = args["temp_c"]; }
    if (kind === "record_note") this.state.notes.push(String(args["text"]));
    if (kind === "add_care_plan_item") this.state.items.push(String(args["title"]));
    if (kind === "send_pay_link") this.state.payLink = new Date().toISOString();
    const extra = kind === "draft_handover" ? { draft: `Handover for Journey Patient. Latest pulse ${this.state.pulse ?? "none"}, temperature ${this.state.temp ?? "none"}. Care plan: ${this.state.items.join(", ") || "none"}. Drafted by the agent from the record.` }
      : kind === "prepare_bill" ? { report: "Bill for Journey Patient: charged NGN 9000.00, paid NGN 4000.00, outstanding NGN 5000.00." } : {};
    return { ok: true, record_id: id, record_version: 1, event_ids: [`${kind}:${id}`], replayed: false, ...extra };
  }
  async prove(kind: string, _a: WorkArgs, written: { record_id: string; record_version: number; event_ids: string[] }): Promise<EmrProof | null> {
    if (kind === "send_pay_link") return null;
    return { ...written, record_hash: "0".repeat(64), verified_at: new Date().toISOString(), read: "in-memory hospital" };
  }
  async watch(owner: string, subject: EmrTarget, _p: Provenance): Promise<WatchRead | null> {
    if (!subject.admission_id || owner === FAKE.owners.nurse) return null;
    const facts: Record<string, string | null> = { "discharge.stage": this.state.stage };
    if (owner === FAKE.owners.accounts) Object.assign(facts, { "bill.pay_link": this.state.payLink, "bill.clearance": this.state.cleared ? "settled" : "unsettled" });
    return { facts, labels: { "discharge.stage": "Discharge stage", "bill.pay_link": "Pay link sent", "bill.clearance": "Clearance" } };
  }
  // The person steps: each moves the record the way the person's own screen would.
  person: PersonCall = async (op) => {
    const ok = (json: unknown = { ok: true }) => ({ ok: true, status: 200, json });
    switch (op) {
      case "open_consult": case "sign_consult": return ok();
      case "accept": if (!this.state.requested) return { ok: false, status: 409, json: null }; this.state.accepted = true; return ok();
      case "assign_bed": if (!this.state.accepted) return { ok: false, status: 409, json: null }; this.state.bed = true; return ok();
      case "sign_off": this.state.stage = "signed_off"; return ok();
      case "bill": return ok({ bill: { outstandingNgn: this.state.cleared ? "0.00" : "5000.00" } });
      case "settle": this.state.cleared = true; this.state.stage = "cleared"; return ok();
      default: return { ok: false, status: null, json: null, note: `no fake for ${op}` };
    }
  };
}

// Plays the journey through serve over a fresh in-memory hospital with the given gate answers, as CI does for a recorded run.
export async function replayJourney(gate: MockResponder, script: JourneyScript = loadJourney()): Promise<{ results: JourneyResults; hospital: JourneyFakeHospital }> {
  const root = mkdtempSync(join(tmpdir(), "hp-journey-"));
  const hospital = new JourneyFakeHospital();
  let rt: EmrRuntime | null = null;
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gate, taskStateOf: (id) => rt?.stateOf(id) ?? null });
  const s = await startEmrServe({ storeRoot: root, port: hospital, client, listenPort: 0, runtime: { holdMs: 400, proofRetryMs: 5, watchMs: 100 } });
  rt = s.runtime;
  try {
    const trace = await runJourney({
      script, serveUrl: s.url, mode: "replay", owners: { ...FAKE.owners }, seed: { patient_id: FAKE.patient, visit_id: FAKE.visit, ward_id: FAKE.ward, bed_id: FAKE.bed },
      person: hospital.person, ledger: () => ledgerOf(s.runtime, root), refusals: () => ({ prohibited: hospital.refusedCount(), door: hospital.refusedCount() }),
      settleMs: 10_000, offerMs: 3000
    });
    return { results: journeyResults(script, trace), hospital };
  } finally { await s.close(); }
}
