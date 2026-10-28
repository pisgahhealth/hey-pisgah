import type { EmrCommit, EmrContext, EmrPort, EmrProof, EmrTarget, InboxPage, Provenance, SayableNames, WatchOffer, WatchRead, WorkArgs } from "../src/emr/port.js";

export const DOC = "doc-1", NURSE = "nurse-1", ACC = "acc-1";
export const PAT = "aaaaaaaa-1111-4222-8333-444444444444";
export const VISIT = "bbbbbbbb-1111-4222-8333-444444444444";
export const ADMIT = "cccccccc-1111-4222-8333-444444444444";

type Write = { kind: string; args: WorkArgs; key: string; prov: Provenance; id: string };
// A small hospital for several owners: kinds per owner, a patient who is admitted by the doctor's request, a discharge stage and a bill, and an inbox per owner.
export class WorkFake implements EmrPort {
  readonly writeKinds = ["record_observation"] as const;
  readonly writes: Write[] = [];
  readonly reads: { op: string; owner: string; evidence: string }[] = [];
  admitted = false;
  stage = "awaiting_sign_off";
  payLinkSent = false;
  pulse: number | null = 90;
  inboxes: Record<string, InboxPage[]> = {};
  private readonly kinds: Record<string, string[]> = {
    [DOC]: ["record_observation", "draft_consult_note", "request_admission", "record_note", "page_staff", "schedule_follow_up"],
    [NURSE]: ["record_observation", "record_triage_vitals", "add_care_plan_item", "record_note", "draft_handover", "page_staff"],
    [ACC]: ["prepare_bill", "send_pay_link", "page_staff"]
  };
  kindsFor(owner: string): readonly string[] { return this.kinds[owner] ?? []; }
  refusedCount(): number { return 0; }
  names(): SayableNames { return { page_targets: { lab: ["lab", "laboratory"], pharmacy: ["pharmacy"], accounts: ["accounts"] }, clinics: { gopd: ["GOPD", "outpatients"] } }; }
  offers(owner: string): readonly WatchOffer[] {
    return owner === ACC ? [{ fact: "stage", equals: "signed_off", kind: "send_pay_link", ask: "Clinical sign-off is done. Say send the pay link when you want it sent." }] : [];
  }
  async resolve(target: EmrTarget, prov: Provenance): Promise<EmrContext> {
    this.reads.push({ op: "resolve", owner: prov.owner, evidence: prov.evidence });
    if (target.admission_id === ADMIT || (target.patient_id === PAT && this.admitted)) {
      return { admission_id: ADMIT, patient_id: PAT, visit_id: VISIT, label: "Journey Patient", facts: { ward: "Ward A", bed: "A1", pulse: this.pulse === null ? null : String(this.pulse) }, keywords: [] };
    }
    if (target.patient_id === PAT) return { admission_id: "", patient_id: PAT, visit_id: VISIT, label: "Journey Patient", facts: { ward: null, bed: null }, keywords: [] };
    throw new Error("unknown target");
  }
  async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    const hit = this.writes.find((w) => w.key === key);
    if (!hit) {
      const id = kind === "request_admission" ? ADMIT : `${kind}-${this.writes.length + 1}`;
      this.writes.push({ kind, args, key, prov, id });
      if (kind === "request_admission") this.admitted = true;
      if (kind === "send_pay_link") this.payLinkSent = true;
      if (kind === "record_observation" && typeof args["pulse"] === "number") this.pulse = args["pulse"];
    }
    const w = this.writes.find((x) => x.key === key)!;
    const extra = kind === "draft_handover" ? { draft: "Handover: Journey Patient, Ward A A1, pulse 90." } : kind === "prepare_bill" ? { report: "Bill: 10,000 charged, 4,000 paid, 6,000 outstanding." } : {};
    return { ok: true, record_id: w.id, record_version: 1, event_ids: [`${kind}:${w.id}`], replayed: !!hit, ...extra };
  }
  async prove(kind: string, _a: WorkArgs, written: { record_id: string; record_version: number; event_ids: string[] }): Promise<EmrProof | null> {
    if (kind === "send_pay_link" && !this.payLinkSent) return null;
    return { ...written, record_hash: "0".repeat(64), verified_at: new Date().toISOString(), read: "fake" };
  }
  async watch(owner: string, subject: EmrTarget, prov: Provenance): Promise<WatchRead | null> {
    this.reads.push({ op: "watch", owner, evidence: prov.evidence });
    if (!subject.admission_id) return null;
    return { facts: { stage: this.stage, pay_link: this.payLinkSent ? "sent" : null }, labels: { stage: "Discharge stage", pay_link: "Pay link" } };
  }
  async inbox(owner: string): Promise<InboxPage[]> { return this.inboxes[owner] ?? []; }
}
