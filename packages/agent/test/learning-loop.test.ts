import { describe, expect, it } from "vitest";
import { loadV1 } from "@hey-pisgah/hospital";
import { ModelClient } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { Registry } from "@hey-pisgah/workflow";
import type { WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { EmrRuntime } from "../src/emr/runtime.js";
import type { EmrCommit, EmrContext, EmrPort, EmrProof, EmrTarget, Provenance, SayableNames, WatchRead, WorkArgs } from "../src/emr/port.js";
import { caseFacts, versionWiring, type Counterparts, type Encounter, type RequirementsNow } from "../src/emr/version-offers.js";
import { emrRoot, gater, until, type C } from "./emr-helpers.js";

const NURSE = "nurse-1";
const PAT_A = "aaaaaaaa-1111-4222-8333-00000000000a", PAT_B = "aaaaaaaa-1111-4222-8333-00000000000b";
const ADM_A = "cccccccc-1111-4222-8333-00000000000a", ADM_B = "cccccccc-1111-4222-8333-00000000000b";
const meta = { author: { kind: "model_session" as const, id: "p-test0005" }, proposal_id: "p-test0005", source_evidence: { event_ids: [], hypothesis_ids: [], experiment_ids: [], validation_report_id: null }, model_provenance: null };
// The change a person adopted for Ward A: the summary draft starts after the round entry instead of after sign-off.
const OPS = [{ op: "remove_soft_edge", edge_id: "e04" }, { op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st01" } } }];
const MAPPED: Counterparts = {
  steps: { st01: { fact: "stay.round", equals: "recorded" }, st05: { fact: "discharge.stage", equals: "clinical_done" } }, events: {},
  documents: { "discharge_summary.draft": { kind: "draft_stay_summary", ask: "The round entry is on the stay. Say draft the discharge summary when you want it drafted from the record." } }
};
const WARDS: Record<string, string> = { "Male Ward": "A", "Children's Ward": "B" };

// Two fresh stays on two wards; each writes its notes, and the nurse's agent drafts and saves the summary through the normal write path.
class StayFake implements EmrPort {
  readonly writeKinds = ["record_observation"] as const;
  readonly writes: { kind: string; args: WorkArgs; key: string; prov: Provenance; id: string }[] = [];
  readonly ward: Record<string, string> = { [ADM_A]: "Male Ward", [ADM_B]: "Children's Ward" };
  readonly notes: Record<string, string[]> = { [ADM_A]: [], [ADM_B]: [] };
  kindsFor(): readonly string[] { return ["record_observation", "record_note", "draft_stay_summary"]; }
  refusedCount(): number { return 0; }
  names(): SayableNames { return { page_targets: {}, clinics: {} }; }
  async resolve(target: EmrTarget): Promise<EmrContext> {
    const adm = target.admission_id === ADM_B || target.patient_id === PAT_B ? ADM_B : ADM_A;
    return { admission_id: adm, patient_id: adm === ADM_A ? PAT_A : PAT_B, visit_id: null, label: adm === ADM_A ? "Patient A" : "Patient B", facts: { ward: this.ward[adm]! }, keywords: [] };
  }
  async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    const adm = String(args["admission_id"]);
    let w = this.writes.find((x) => x.key === key);
    if (!w) { w = { kind, args, key, prov, id: `${kind}-${this.writes.length + 1}` }; this.writes.push(w); if (kind === "record_note") this.notes[adm]!.push(String(args["text"])); }
    const extra = kind === "draft_stay_summary" ? { draft: `Discharge summary draft for ${adm === ADM_A ? "Patient A" : "Patient B"}, ${this.ward[adm]}. Latest note: ${this.notes[adm]!.at(0) ?? "none"}. Drafted by the agent from the record for the nurse to check; not signed.` } : {};
    return { ok: true, record_id: w.id, record_version: 1, event_ids: [`${kind}:${w.id}`], replayed: false, ...extra };
  }
  async prove(kind: string, args: WorkArgs, written: { record_id: string; record_version: number; event_ids: string[] }): Promise<EmrProof | null> {
    if (kind === "record_note" && this.notes[String(args["admission_id"])]!.at(-1) !== args["text"]) return null;
    return { ...written, record_hash: "0".repeat(64), verified_at: new Date().toISOString(), read: "fake" };
  }
  async watch(_owner: string, subject: EmrTarget): Promise<WatchRead | null> {
    const adm = subject.admission_id;
    if (!adm) return null;
    return { facts: { "stay.round": this.notes[adm]!.length ? "recorded" : null, "stay.ward": this.ward[adm]!, "discharge.stage": "awaiting_sign_off" }, labels: { "stay.round": "Progress note on the stay", "stay.ward": "Ward", "discharge.stage": "Discharge stage" } };
  }
}

function adoptedFor(): { v1: WD; v2: WD } {
  const r = Registry.load([loadV1()]);
  const v2 = r.propose(1, OPS as never, meta, { scope: { wards: ["A"], condition: null }, fallback: 1 }).version!;
  return { v1: r.get(1), v2 };
}
const ins = (kind: string, f: Record<string, unknown> = {}): C => ({ class: "instruction", kind, confidence: 0.95, ...f });

function boot() {
  const { v1, v2 } = adoptedFor();
  const root = emrRoot();
  const port = new StayFake();
  const seen: string[] = [];
  const requirements = (enc?: Encounter): RequirementsNow | null => {
    const ward = WARDS[enc?.["stay.ward"] ?? ""];
    return ward ? { ward_id: ward, requirement_version: "r1", facts: caseFacts({ ward_id: ward, requirement_version: "r1", facts: { payer_type: "self_pay", expected_disposition: "home", has_take_home_order: "false" } }) } : null;
  };
  const resolve = (facts: Record<string, unknown>) => (facts["ward_id"] === "A" ? { def: v2, parent: v1 } : { def: v1, parent: null });
  let rt: EmrRuntime | null = null;
  const script = (s: string): C[] => (s.startsWith("Draft the discharge") ? [ins("draft_stay_summary")] : s.includes("Save the summary") ? [ins("record_note", { note_type: "nursing", text: null })] : [ins("record_note", { note_type: "progress", text: s })]);
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater(script, seen), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1, watchMs: 30, versions: versionWiring({ def: v2, parent: v1, counterparts: MAPPED, requirements, resolve: resolve as never, newest: { def: v2, parent: v1 } }) });
  rt.start();
  return { rt, port, root, seen };
}
const types = (root: string, taskId: string) => readStream(root, `emr/${taskId}`).map((e) => e.record_type);

describe("one learning loop on a fresh stay: offered at the round entry, drafted, saved and proved; withheld on the other ward with its reason", () => {
  it("offers the adopted change on a fresh ward A stay once the round entry is in, and saves the approved summary through the write path with provenance", async () => {
    const { rt, port, root } = boot();
    const t = await rt.open(NURSE, { admission_id: ADM_A });
    await until(() => rt.view(t.task_id)!.watching !== null, 2000);
    expect(rt.view(t.task_id)!.questions).toHaveLength(0);
    // The round entry lands on the stay.
    port.notes[ADM_A]!.push("Ward round: pain settling, abdomen soft.");
    await until(() => rt.view(t.task_id)!.questions.length === 1, 2000);
    expect(rt.view(t.task_id)!.questions[0]!.text).toContain("Say draft the discharge summary");
    expect(rt.view(t.task_id)!.version).toMatchObject({ version: 2 });
    await rt.say({ owner: NURSE, target: { admission_id: ADM_A }, text: "Draft the discharge summary." }, t.task_id);
    await rt.settled();
    let v = rt.view(t.task_id)!;
    expect(v.questions.at(-1)!.text).toContain("Summary draft for your review");
    expect(port.writes.map((w) => w.kind)).toEqual(["draft_stay_summary"]);
    const said = await rt.say({ owner: NURSE, target: { admission_id: ADM_A }, text: "That reads right. Save the summary." }, t.task_id);
    await rt.settled();
    v = rt.view(t.task_id)!;
    const saved = v.actions.find((a) => a.kind === "record_note")!;
    expect(saved).toMatchObject({ state: "completed", args: { label: "stay_summary", note_type: "nursing" } });
    expect(String(saved.args["text"])).toMatch(/^Discharge summary draft for Patient A/);
    // The saved note is the reviewed draft, written with the owner's line as its evidence and proved by a fresh read.
    const w = port.writes.find((x) => x.kind === "record_note")!;
    expect(w.prov).toMatchObject({ owner: NURSE, evidence: `transcript:${said.line_id}` });
    expect(port.notes[ADM_A]!.at(-1)).toBe(saved.args["text"]);
    expect(types(root, t.task_id).filter((x) => x === "offer.made" || x === "version.offer_withheld")).toEqual(["offer.made"]);
    await rt.stop();
  });

  it("withholds the same change on a ward B stay at the same trigger point, once, with the reason, and makes no offer", async () => {
    const { rt, port, root, seen } = boot();
    const t = await rt.open(NURSE, { admission_id: ADM_B });
    port.notes[ADM_B]!.push("Ward round: settling.");
    await until(() => types(root, t.task_id).includes("version.offer_withheld"), 2000);
    await new Promise((r) => setTimeout(r, 150));
    const v = rt.view(t.task_id)!;
    expect(v.version).toMatchObject({ version: 1 });
    expect(v.questions).toHaveLength(0);
    const rows = readStream(root, `emr/${t.task_id}`).filter((e) => e.record_type === "version.offer_withheld").map((e) => e.payload as Record<string, unknown>);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 2, in_force: 1, step_id: "st06", kind: "draft_stay_summary", ward_id: "B", reason: "version 2 is adopted for ward A and this patient is on ward B, so version 1 is in force" });
    expect(v.notes.map((n) => n.text)).toContain("Not offered: version 2 is adopted for ward A and this patient is on ward B, so version 1 is in force.");
    expect(port.writes).toHaveLength(0);
    expect(seen).toHaveLength(0);
    await rt.stop();
  });

  it("reads no version while the record names no mapped ward, so nothing is offered or withheld on a guess", async () => {
    const { rt, port, root } = boot();
    port.ward[ADM_A] = "A&E Ward";
    const t = await rt.open(NURSE, { admission_id: ADM_A });
    port.notes[ADM_A]!.push("Ward round.");
    await until(() => rt.view(t.task_id)!.watching !== null, 2000);
    await new Promise((r) => setTimeout(r, 200));
    expect(types(root, t.task_id).filter((x) => x.startsWith("version.") || x === "offer.made")).toEqual([]);
    await rt.stop();
  });
});
