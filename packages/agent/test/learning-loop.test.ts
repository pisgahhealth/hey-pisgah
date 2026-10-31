import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadV1 } from "@hey-pisgah/hospital";
import { ModelClient } from "@hey-pisgah/model";
import { openStream, readStream } from "@hey-pisgah/store";
import { Registry } from "@hey-pisgah/workflow";
import type { WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { EmrRuntime } from "../src/emr/runtime.js";
import type { EmrCommit, EmrContext, EmrPort, EmrProof, EmrTarget, Provenance, SayableNames, WatchRead, WorkArgs } from "../src/emr/port.js";
import { adoptedRegistry, caseFacts, deployCheck, readVersion, versionWiring, type Counterparts, type Encounter, type RequirementsNow, type VersionSource } from "../src/emr/version-offers.js";
import { VERSIONS_STREAM } from "../src/versions.js";
import { emrRoot, gater, until, type C } from "./emr-helpers.js";

const NURSE = "nurse-1";
const PAT_A = "aaaaaaaa-1111-4222-8333-00000000000a", PAT_B = "aaaaaaaa-1111-4222-8333-00000000000b", PAT_C = "aaaaaaaa-1111-4222-8333-00000000000c";
const ADM_A = "cccccccc-1111-4222-8333-00000000000a", ADM_B = "cccccccc-1111-4222-8333-00000000000b", ADM_C = "cccccccc-1111-4222-8333-00000000000c";
const meta = { author: { kind: "model_session" as const, id: "p-test0005" }, proposal_id: "p-test0005", source_evidence: { event_ids: [], hypothesis_ids: [], experiment_ids: [], validation_report_id: null }, model_provenance: null };
// The change a person adopted for Ward A: the summary draft starts after the round entry instead of after sign-off.
const OPS = [{ op: "remove_soft_edge", edge_id: "e04" }, { op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st01" } } }];
const MAPPED: Counterparts = {
  steps: { st01: { fact: "stay.round", equals: "recorded" }, st05: { fact: "discharge.stage", equals: "clinical_done" } }, events: {},
  documents: { "discharge_summary.draft": { kind: "draft_stay_summary", ask: "The round entry is on the stay. Say draft the discharge summary when you want it drafted from the record.", asks: { st05: "Sign-off is on the stay and no round entry is yet. Say draft the discharge summary when you want it drafted from the record." } } }
};
const WARDS: Record<string, string> = { "Male Ward": "A", "Children's Ward": "B" };

// Two fresh stays on two wards; each writes its notes, and the nurse's agent drafts and saves the summary through the normal write path.
class StayFake implements EmrPort {
  readonly writeKinds = ["record_observation"] as const;
  readonly writes: { kind: string; args: WorkArgs; key: string; prov: Provenance; id: string }[] = [];
  readonly ward: Record<string, string> = { [ADM_A]: "Male Ward", [ADM_B]: "Children's Ward", [ADM_C]: "Male Ward" };
  readonly notes: Record<string, string[]> = { [ADM_A]: [], [ADM_B]: [], [ADM_C]: [] };
  readonly stage: Record<string, string> = {};
  kindsFor(): readonly string[] { return ["record_observation", "record_note", "draft_stay_summary"]; }
  refusedCount(): number { return 0; }
  names(): SayableNames { return { page_targets: {}, clinics: {} }; }
  async resolve(target: EmrTarget): Promise<EmrContext> {
    const adm = target.admission_id === ADM_B || target.patient_id === PAT_B ? ADM_B : target.admission_id === ADM_C || target.patient_id === PAT_C ? ADM_C : ADM_A;
    const pat = { [ADM_A]: PAT_A, [ADM_B]: PAT_B, [ADM_C]: PAT_C }[adm]!;
    return { admission_id: adm, patient_id: pat, visit_id: null, label: adm === ADM_A ? "Patient A" : adm === ADM_B ? "Patient B" : "Patient C", facts: { ward: this.ward[adm]! }, keywords: [] };
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
    return { facts: { "stay.round": this.notes[adm]!.length ? "recorded" : null, "stay.ward": this.ward[adm]!, "discharge.stage": this.stage[adm] ?? "awaiting_sign_off" }, labels: { "stay.round": "Progress note on the stay", "stay.ward": "Ward", "discharge.stage": "Discharge stage" } };
  }
}

function adoptedFor(): { v1: WD; v2: WD } {
  const r = Registry.load([loadV1()]);
  const v2 = r.propose(1, OPS as never, meta, { scope: { wards: ["A"], condition: null }, fallback: 1 }).version!;
  return { v1: r.get(1), v2 };
}
const ins = (kind: string, f: Record<string, unknown> = {}): C => ({ class: "instruction", kind, confidence: 0.95, ...f });

const MANAGER = { kind: "person", staff_id: "wm_test", role: "ward_manager", display_name: "Synthetic ward manager (test)" };
// A person's version log with version 2 adopted for ward A, and the suspension they may write into it later.
function versionLog(): { root: string; suspend: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hp-vlog-"));
  const { v2 } = adoptedFor();
  const s = openStream(root, VERSIONS_STREAM, { writer: true });
  s.append("version.created", { version: 2, base_version: 1, ops: OPS, scope: { wards: ["A"], condition: null }, meta, definition_hash: v2.definition_hash }, { recorded_at: 0, occurred_at: 0 });
  s.append("version.adopted", { version: 2, approver: MANAGER, at: { occurred_at: 0, recorded_at: 0, wall_at: "2026-10-31T07:00:00.000Z" }, scope: { wards: ["A"], condition: null }, definition_hash: v2.definition_hash }, { recorded_at: 0, occurred_at: 0 });
  s.close();
  return {
    root,
    suspend: () => {
      const w = openStream(root, VERSIONS_STREAM, { writer: true });
      w.append("version.suspended", { version: 2, by: MANAGER, reason: "the draft waited past sign-off on a late round entry", at: { occurred_at: 1, recorded_at: 1, wall_at: "2026-10-31T08:15:00.000Z" }, proposal: null }, { recorded_at: 1, occurred_at: 1 });
      w.close();
    }
  };
}
// The history read again on every use, as the EMR adapter reads a person's log.
const liveSource = (logRoot: string) => (): VersionSource => { const r = adoptedRegistry(logRoot); return { ...r, newest: r.latest }; };
const SUSPENDED = "version 2 was suspended by Synthetic ward manager (test) on 31 Oct, 09:15 (the draft waited past sign-off on a late round entry), so version 1 is in force";

// The narrowed revision: the draft starts at the round entry or at sign-off, whichever the record shows first.
const EITHER = [{ op: "remove_soft_edge", edge_id: "e04" }, { op: "set_prep_trigger", target: { step: "st06" }, when: { any_of: [{ after: { step: "st01" } }, { after: { step: "st05" } }] } }];
function revisionFor(): { v1: WD; v3: WD } {
  const r = Registry.load([loadV1()]);
  return { v1: r.get(1), v3: r.propose(1, EITHER as never, meta, { scope: { wards: ["A"], condition: null }, fallback: 1 }).version! };
}

function boot(o: { source?: () => VersionSource | null; holdMs?: number; watchMs?: number; root?: string; port?: StayFake; adopted?: { v1: WD; v2: WD } } = {}) {
  const { v1, v2 } = o.adopted ?? adoptedFor();
  const root = o.root ?? emrRoot();
  const port = o.port ?? new StayFake();
  const seen: string[] = [];
  const requirements = (enc?: Encounter): RequirementsNow | null => {
    const ward = WARDS[enc?.["stay.ward"] ?? ""];
    return ward ? { ward_id: ward, requirement_version: "r1", facts: caseFacts({ ward_id: ward, requirement_version: "r1", facts: { payer_type: "self_pay", expected_disposition: "home", has_take_home_order: "false" } }) } : null;
  };
  const resolve = (facts: Record<string, unknown>) => (facts["ward_id"] === "A" ? { def: v2, parent: v1 } : { def: v1, parent: null });
  let rt: EmrRuntime | null = null;
  const script = (s: string): C[] => (s.startsWith("Draft the discharge") ? [ins("draft_stay_summary")] : s.includes("Save the summary") ? [ins("record_note", { note_type: "nursing", text: null })] : [ins("record_note", { note_type: "progress", text: s })]);
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater(script, seen), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: o.holdMs ?? 0, proofRetryMs: 1, watchMs: o.watchMs ?? 30, versions: versionWiring({ def: v2, parent: v1, counterparts: MAPPED, requirements, resolve: resolve as never, newest: { def: v2, parent: v1 }, ...(o.source ? { source: o.source } : {}) }) });
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

describe("the running agent follows the version history a person writes", () => {
  it("withdraws a pending offer with the reason when a person suspends version 2, and the next fresh ward A stay is offered nothing, with the suspension as the reason", async () => {
    const log = versionLog();
    const { rt, port, root } = boot({ source: liveSource(log.root) });
    const t = await rt.open(NURSE, { admission_id: ADM_A });
    port.notes[ADM_A]!.push("Ward round: pain settling.");
    await until(() => rt.view(t.task_id)!.questions.length === 1, 2000);
    expect(rt.view(t.task_id)!.version).toMatchObject({ version: 2 });
    log.suspend();
    await until(() => types(root, t.task_id).includes("version.offer_withdrawn"), 2000);
    const v = rt.view(t.task_id)!;
    expect(v.questions).toHaveLength(0);
    expect(v.version).toMatchObject({ version: 1, withdrawn: [{ version: 2, reason: SUSPENDED, actions: [] }] });
    expect(v.notes.map((n) => n.text)).toContain(`Withdrawn: ${SUSPENDED}. The offer from version 2 is closed.`);
    // A fresh ward A stay reaches the same trigger point after the suspension.
    const t2 = await rt.open(NURSE, { admission_id: ADM_C });
    port.notes[ADM_C]!.push("Ward round: comfortable.");
    await until(() => types(root, t2.task_id).includes("version.offer_withheld"), 2000);
    await new Promise((r) => setTimeout(r, 150));
    const v2 = rt.view(t2.task_id)!;
    expect(v2.questions).toHaveLength(0);
    expect(v2.version).toMatchObject({ version: 1 });
    expect(v2.notes.map((n) => n.text)).toContain(`Not offered: ${SUSPENDED}.`);
    expect(types(root, t2.task_id).filter((x) => x === "offer.made")).toEqual([]);
    expect(port.writes).toHaveLength(0);
    await rt.stop();
  });

  it("cancels the nurse's held draft before it is sent when version 2 is suspended during the hold", async () => {
    const log = versionLog();
    const { rt, port, root } = boot({ source: liveSource(log.root), holdMs: 400, watchMs: 0 });
    const t = await rt.open(NURSE, { admission_id: ADM_A });
    port.notes[ADM_A]!.push("Ward round: pain settling.");
    await rt.pollOnce();
    expect(rt.view(t.task_id)!.questions).toHaveLength(1);
    await rt.say({ owner: NURSE, target: { admission_id: ADM_A }, text: "Draft the discharge summary." }, t.task_id);
    await until(() => !!rt.view(t.task_id)!.actions.find((a) => a.kind === "draft_stay_summary"), 2000);
    const draft = rt.view(t.task_id)!.actions.find((a) => a.kind === "draft_stay_summary")!;
    expect(draft.state).toBe("proposed");
    log.suspend();
    await rt.settled();
    const v = rt.view(t.task_id)!;
    expect(v.actions.find((a) => a.action_id === draft.action_id)).toMatchObject({ state: "cancelled", reason: "version_withdrawn" });
    expect(port.writes).toHaveLength(0);
    expect(readStream(root, `emr/${t.task_id}`).find((e) => e.record_type === "version.offer_withdrawn")?.payload).toMatchObject({ version: 2, reason: SUSPENDED, actions: [draft.action_id] });
    await rt.stop();
  });

  it("leaves the nurse's own later request alone once the offered summary was saved, even after the suspension", async () => {
    const log = versionLog();
    const { rt, port, root } = boot({ source: liveSource(log.root), watchMs: 0 });
    const t = await rt.open(NURSE, { admission_id: ADM_A });
    port.notes[ADM_A]!.push("Ward round: pain settling.");
    await rt.pollOnce();
    await rt.say({ owner: NURSE, target: { admission_id: ADM_A }, text: "Draft the discharge summary." }, t.task_id);
    await rt.settled();
    await rt.say({ owner: NURSE, target: { admission_id: ADM_A }, text: "That reads right. Save the summary." }, t.task_id);
    await rt.settled();
    expect(rt.view(t.task_id)!.actions.find((a) => a.kind === "record_note")).toMatchObject({ state: "completed" });
    log.suspend();
    await rt.pollOnce();
    expect(types(root, t.task_id)).not.toContain("version.offer_withdrawn");
    await rt.say({ owner: NURSE, target: { admission_id: ADM_A }, text: "Draft the discharge summary again." }, t.task_id);
    await rt.settled();
    const drafts = rt.view(t.task_id)!.actions.filter((a) => a.kind === "draft_stay_summary");
    expect(drafts.map((a) => a.state)).toEqual(["completed", "completed"]);
    expect(types(root, t.task_id)).not.toContain("version.offer_withdrawn");
    await rt.stop();
  });

  it("a restart after the suspension withdraws the offer the stopped agent left open", async () => {
    const log = versionLog();
    const first = boot({ source: liveSource(log.root), watchMs: 0 });
    const t = await first.rt.open(NURSE, { admission_id: ADM_A });
    first.port.notes[ADM_A]!.push("Ward round: pain settling.");
    await first.rt.pollOnce();
    expect(first.rt.view(t.task_id)!.questions).toHaveLength(1);
    await first.rt.stop();
    log.suspend();
    const again = boot({ source: liveSource(log.root), watchMs: 0, root: first.root, port: first.port });
    await again.rt.pollOnce();
    const v = again.rt.view(t.task_id)!;
    expect(v.questions).toHaveLength(0);
    expect(types(first.root, t.task_id).filter((x) => x === "version.offer_withdrawn")).toHaveLength(1);
    await again.rt.pollOnce();
    expect(types(first.root, t.task_id).filter((x) => x === "version.offer_withdrawn")).toHaveLength(1);
    await again.rt.stop();
  });
});

describe("a trigger met either way is offered once, at whichever the record shows first", () => {
  it("reads the revision as two ways to the same offer, each with its own question, and this EMR can carry it", () => {
    const { v1, v3 } = revisionFor();
    const r = readVersion(v3, v1, MAPPED, caseFacts({ ward_id: "A", requirement_version: "r1", facts: { payer_type: "self_pay", expected_disposition: "home", has_take_home_order: "false" } }));
    expect(r.offers.filter((x) => x.step_id === "st06").map((x) => [x.when[0]!.fact, x.ask.slice(0, 20), x.changed])).toEqual([["stay.round", "The round entry is o", true], ["discharge.stage", "Sign-off is on the s", true]]);
    expect(deployCheck(v3, v1, MAPPED, [{ id: NURSE, kinds: ["draft_stay_summary"] }])).toMatchObject({ deployable: true });
  });

  it("offers the draft at sign-off when the round entry is not in the record yet, and not again when the round entry lands", async () => {
    const { v1, v3 } = revisionFor();
    const { rt, port, root } = boot({ adopted: { v1, v2: v3 } });
    const t = await rt.open(NURSE, { admission_id: ADM_A });
    await until(() => rt.view(t.task_id)!.watching !== null, 2000);
    port.stage[ADM_A] = "clinical_done";
    await until(() => rt.view(t.task_id)!.questions.length === 1, 2000);
    expect(rt.view(t.task_id)!.questions[0]!.text).toMatch(/^Sign-off is on the stay and no round entry is yet/);
    port.notes[ADM_A]!.push("Ward round: entered late from the paper notes.");
    await new Promise((r) => setTimeout(r, 200));
    expect(readStream(root, `emr/${t.task_id}`).filter((e) => e.record_type === "offer.made").map((e) => (e.payload as { offer: string }).offer)).toEqual(["v2:st06:discharge.stage=clinical_done:draft_stay_summary"]);
    expect(rt.view(t.task_id)!.questions).toHaveLength(1);
    await rt.stop();
  });
});
