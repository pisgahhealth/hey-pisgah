import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadV1 } from "@hey-pisgah/hospital";
import { ModelClient } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { Registry } from "@hey-pisgah/workflow";
import type { WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { EmrRuntime } from "../src/emr/runtime.js";
import { caseFacts, changedSteps, checkOffer, deployCheck, readVersion, versionWiring, type Counterparts, type RequirementsNow } from "../src/emr/version-offers.js";
import { emrRoot, gater, until } from "./emr-helpers.js";
import { ADMIT, NURSE, WorkFake } from "./work-helpers.js";

const A_PRIOR = (JSON.parse(readFileSync(new URL("../fixtures/proposals/a-prior.json", import.meta.url), "utf8")) as { proposal: { ops: unknown[]; scope: { wards: "all"; condition: null } } }).proposal;
const meta = { author: { kind: "model_session" as const, id: "p-test0002" }, proposal_id: "p-test0002", source_evidence: { event_ids: [], hypothesis_ids: [], experiment_ids: [], validation_report_id: null }, model_provenance: null };

function versions(): { v1: WD; v2: WD } {
  const r = Registry.load([loadV1()]);
  const v2 = r.propose(1, A_PRIOR.ops, meta, { scope: A_PRIOR.scope, fallback: 1 }).version!;
  return { v1: r.get(1), v2 };
}

// A made-up EMR: a stay stage shows sign-off and departure, a nurse's kind prepares the summary draft, and a clerk's kind the claim draft.
const C: Counterparts = {
  steps: { st05: { fact: "stage", equals: "signed_off" }, st16: { fact: "stage", equals: "left" } },
  events: {},
  documents: {
    "discharge_summary.draft": { kind: "draft_handover", ask: "Sign-off is done. Say draft the summary when you want it." },
    "hmo_claim_cover.draft": { kind: "prepare_bill", ask: "Sign-off is done. Say prepare the claim cover when you want it." }
  }
};
const facts = (payer: string, ward = "A", rv = "r1", extra: Record<string, string> = {}) =>
  caseFacts({ ward_id: ward, requirement_version: rv, facts: { payer_type: payer, expected_disposition: "home", has_take_home_order: "false", ...extra } });

describe("an adopted version read as EMR watches and offers", () => {
  it("reads v1 for a self-pay patient: the summary draft is offered at sign-off, the claim cover does not apply, hand-over is a person's", () => {
    const { v1 } = versions();
    const r = readVersion(v1, null, C, facts("self_pay"));
    const by = Object.fromEntries(r.readings.map((x) => [x.step_id, x.status]));
    expect(by).toEqual({ st06: "offer", st14: "not_agent_work", st09a: "not_applicable", st17a: "no_counterpart" });
    expect(r.offers.map((o) => [o.step_id, o.kind, o.when])).toEqual([["st06", "draft_handover", [{ fact: "stage", equals: "signed_off" }]]]);
    expect(r.lines).toEqual([]);
    expect(r.readings.find((x) => x.step_id === "st17a")!.reason).toContain("refund_voucher draft");
  });

  it("finds exactly the step v2 changed, and says there is nothing to offer under it for a self-pay patient", () => {
    const { v1, v2 } = versions();
    expect([...changedSteps(v2, v1)]).toEqual(["st09a"]);
    const r = readVersion(v2, v1, C, facts("self_pay"));
    expect(r.lines).toEqual(["Nothing to offer under version 2 for a self-pay patient."]);
    expect(r.offers.map((o) => o.step_id)).toEqual(["st06"]);
    expect(r.offers.every((o) => !o.changed)).toBe(true);
  });

  it("offers v2's change to an HMO patient at sign-off, where v1 had no watched trigger point for it", () => {
    const { v1, v2 } = versions();
    const old = readVersion(v1, null, C, facts("hmo"));
    expect(old.readings.find((x) => x.step_id === "st09a")).toMatchObject({ status: "no_counterpart" });
    const r = readVersion(v2, v1, C, facts("hmo"));
    expect(r.lines).toEqual([]);
    expect(r.offers.find((o) => o.step_id === "st09a")).toMatchObject({ kind: "prepare_bill", changed: true, when: [{ fact: "stage", equals: "signed_off" }] });
  });

  it("says a change has no counterpart when the EMR cannot prepare the changed document", () => {
    const { v1, v2 } = versions();
    const bare: Counterparts = { ...C, documents: { "discharge_summary.draft": C.documents["discharge_summary.draft"]! } };
    const r = readVersion(v2, v1, bare, facts("hmo"));
    expect(r.lines).toEqual(["Nothing to offer under version 2: no work kind in this EMR prepares the hmo_claim_cover draft."]);
  });

  it("the monitor passes an offer under ward A r1 and blocks it under ward B r2 with the conflict and a revision", () => {
    const { v2 } = versions();
    const offer = readVersion(v2, null, C, facts("self_pay")).offers[0]!;
    expect(checkOffer(v2, offer, { ward_id: "A", requirement_version: "r1", facts: facts("self_pay") }).ok).toBe(true);
    const b2 = facts("self_pay", "B", "r2", { has_take_home_order: "true" });
    const c = checkOffer(v2, offer, { ward_id: "B", requirement_version: "r2", facts: b2 });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.failures.map((f) => [f.section_id, f.expected.record_kind, f.found?.record_kind])).toEqual([["medicines", "dispense_record", "take_home_order"]]);
    expect(c.revision_ops).toEqual([{ op: "rebind_section", document_id: "discharge_summary", section_id: "medicines", source: { record_kind: "dispense_record", field_path: "items", version_policy: "current" } }]);
    expect(c.conflict).toContain("Conflict raised for a person to decide");
  });
});

describe("version offers in the EMR runtime", () => {
  function boot(now: () => RequirementsNow, def: WD, parent: WD | null) {
    const root = emrRoot();
    const port = new WorkFake();
    port.admitted = true;
    const seen: string[] = [];
    let rt: EmrRuntime | null = null;
    const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater(() => [], seen), taskStateOf: (id) => rt?.stateOf(id) ?? null });
    rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1, watchMs: 30, versions: versionWiring({ def, parent, counterparts: C, requirements: now }) });
    rt.start();
    return { rt, port, seen, root };
  }
  const types = (root: string, taskId: string) => readStream(root, `emr/${taskId}`).map((e) => e.record_type);

  it("asks once at the trigger point under ward A r1, writes nothing, and calls no model", async () => {
    const { v1, v2 } = versions();
    const req = { ward_id: "A", requirement_version: "r1", facts: facts("self_pay") };
    const { rt, port, seen, root } = boot(() => req, v2, v1);
    const t = await rt.open(NURSE, { admission_id: ADMIT });
    await until(() => rt.view(t.task_id)!.version !== null, 2000);
    let v = rt.view(t.task_id)!;
    expect(v.version).toMatchObject({ version: 2, offers: ["v2:st06:stage=signed_off:draft_handover"], lines: ["Nothing to offer under version 2 for a self-pay patient."] });
    expect(v.notes.map((n) => n.text)).toContain("Nothing to offer under version 2 for a self-pay patient.");
    expect(v.questions).toHaveLength(0);
    port.stage = "signed_off";
    await until(() => rt.view(t.task_id)!.questions.length === 1, 2000);
    await new Promise((r) => setTimeout(r, 120));
    v = rt.view(t.task_id)!;
    expect(v.questions.map((q) => q.text)).toEqual(["Sign-off is done. Say draft the summary when you want it."]);
    expect(types(root, t.task_id).filter((x) => x === "offer.made" || x === "version.rules")).toEqual(["version.rules", "offer.made"]);
    expect(port.writes).toHaveLength(0);
    expect(seen).toHaveLength(0);
    await rt.stop();
  });

  it("blocks the offer when ward B r2 is in force at the trigger point, and raises the conflict in the strip", async () => {
    const { v1, v2 } = versions();
    let req: RequirementsNow = { ward_id: "B", requirement_version: "r1", facts: facts("self_pay", "B", "r1", { has_take_home_order: "true" }) };
    const { rt, port, root } = boot(() => req, v2, v1);
    const t = await rt.open(NURSE, { admission_id: ADMIT });
    await until(() => rt.view(t.task_id)!.version !== null, 2000);
    req = { ward_id: "B", requirement_version: "r2", facts: facts("self_pay", "B", "r2", { has_take_home_order: "true" }) };
    port.stage = "signed_off";
    await until(() => (rt.view(t.task_id)!.version?.blocked.length ?? 0) === 1, 2000);
    await new Promise((r) => setTimeout(r, 120));
    const v = rt.view(t.task_id)!;
    expect(v.questions).toHaveLength(0);
    expect(v.version!.blocked[0]).toMatchObject({ offer: "v2:st06:stage=signed_off:draft_handover", requirement_version: "r2" });
    expect(v.notes.some((n) => n.text.includes("Conflict raised for a person to decide") && n.text.includes("dispense record"))).toBe(true);
    const ty = types(root, t.task_id);
    expect(ty.filter((x) => x.startsWith("version.") || x === "offer.made")).toEqual(["version.rules", "version.check_failed", "version.revision_proposed"]);
    expect(port.writes).toHaveLength(0);
    await rt.stop();
  });
});

// The change a person adopted for Ward A on 30 Oct: the summary draft starts after the round entry instead of after sign-off.
const ADOPTED_OPS = [{ op: "remove_soft_edge", edge_id: "e04" }, { op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st01" } } }];
function adopted(): { v1: WD; v2: WD } {
  const r = Registry.load([loadV1()]);
  const v2 = r.propose(1, ADOPTED_OPS as never, meta, { scope: { wards: ["A"], condition: null }, fallback: 1 }).version!;
  return { v1: r.get(1), v2 };
}
// The counterparts the EMR profile held before this lane: sign-off and clearance only, and no work kind for any document.
const SIGNOFF_ONLY: Counterparts = { steps: { st05: { fact: "discharge.stage", equals: "clinical_done" }, st13: { fact: "discharge.stage", equals: "cleared" } }, events: {}, documents: {} };
// The round entry, the take-home order and sign-off each mapped to a watched EMR fact, and a nurse's kind that drafts the summary.
const MAPPED: Counterparts = {
  steps: { st01: { fact: "stay.round", equals: "recorded" }, st02: { fact: "discharge.take_home", equals: "ordered" }, ...SIGNOFF_ONLY.steps },
  events: {},
  documents: { "discharge_summary.draft": { kind: "draft_discharge_summary", ask: "The round entry is in. Say draft the summary when you want it." } }
};
const OWNERS = [{ id: "nurse", kinds: ["record_observation", "draft_discharge_summary"] }, { id: "doctor", kinds: ["record_note"] }];

describe("the adopted version against this EMR's events", () => {
  it("reproduces the review: under the old counterparts the adopted version yields no offer, and the deploy check says why", () => {
    const { v1, v2 } = adopted();
    const r = readVersion(v2, v1, SIGNOFF_ONLY, facts("self_pay"));
    expect(r.offers).toHaveLength(0);
    expect(r.lines).toEqual(["Nothing to offer under version 2: no watched fact in this EMR shows after st01."]);
    const d = deployCheck(v2, v1, SIGNOFF_ONLY, OWNERS);
    expect(d.deployable).toBe(false);
    expect(d.changed).toMatchObject([{ step_id: "st06", status: "no_trigger_counterpart", event: "round entry" }]);
  });

  it("offers the summary draft at the round entry once the round entry, take-home order and sign-off are mapped, and the version deploys", () => {
    const { v1, v2 } = adopted();
    const r = readVersion(v2, v1, MAPPED, facts("self_pay"));
    expect(r.offers.map((o) => [o.step_id, o.kind, o.when, o.changed])).toEqual([["st06", "draft_discharge_summary", [{ fact: "stay.round", equals: "recorded" }], true]]);
    expect(r.lines).toEqual([]);
    const d = deployCheck(v2, v1, MAPPED, OWNERS);
    expect(d).toMatchObject({ deployable: true, changed: [{ step_id: "st06", status: "deployable", event: "round entry", owners: ["nurse"] }] });
    // Version 1 offers the same draft only at sign-off, so the two versions differ in the EMR exactly where the change says.
    expect(readVersion(v1, null, MAPPED, facts("self_pay")).offers.map((o) => o.when)).toEqual([[{ fact: "discharge.stage", equals: "clinical_done" }]]);
  });

  it("fails the deploy check when no owner's agent holds the kind, or the change touches a person's step", () => {
    const { v1, v2 } = adopted();
    expect(deployCheck(v2, v1, MAPPED, [{ id: "doctor", kinds: ["record_note"] }]).changed[0]).toMatchObject({ status: "no_owner" });
    expect(deployCheck(v2, v1, { ...MAPPED, documents: {} }, OWNERS).changed[0]).toMatchObject({ status: "no_document_counterpart" });
    const r = Registry.load([loadV1()]);
    const person = r.propose(1, [{ op: "remove_soft_edge", edge_id: "e05" }] as never, meta, { scope: { wards: "all", condition: null }, fallback: 1 }).version!;
    expect(deployCheck(person, r.get(1), MAPPED, OWNERS)).toMatchObject({ deployable: false, changed: [{ step_id: "st14", status: "not_agent_work" }] });
    expect(deployCheck(r.get(1), r.get(1), MAPPED, OWNERS)).toMatchObject({ deployable: false, reason: "version 1 changes no step against its parent" });
  });
});
