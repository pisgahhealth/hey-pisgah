import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSIONS_STREAM } from "@hey-pisgah/agent";
import { loadV1 } from "@hey-pisgah/hospital";
import { openStream } from "@hey-pisgah/store";
import { Registry } from "@hey-pisgah/workflow";
import type { VersionsSpec } from "../src/profile.js";
import { adoptedForEmr } from "../src/versions.js";
import { factValue } from "../src/port.js";

const A_PRIOR = (JSON.parse(readFileSync(new URL("../../agent/fixtures/proposals/a-prior.json", import.meta.url), "utf8")) as { proposal: { ops: unknown[]; scope: { wards: "all"; condition: null } } }).proposal;
const meta = { author: { kind: "model_session" as const, id: "p-test0003" }, proposal_id: "p-test0003", source_evidence: { event_ids: [], hypothesis_ids: [], experiment_ids: [], validation_report_id: null }, model_provenance: null };
const approver = { kind: "person", staff_id: "wm_test", role: "ward_manager", display_name: "Synthetic ward manager (test)" };

// A version log as a person's adoption leaves it: version 2 created from the A-prior change, then adopted.
function versionLog(): string {
  const root = mkdtempSync(join(tmpdir(), "vlog-"));
  const v2 = Registry.load([loadV1()]).propose(1, A_PRIOR.ops, meta, { scope: A_PRIOR.scope, fallback: 1 }).version!;
  const s = openStream(root, VERSIONS_STREAM, { writer: true });
  const at = { occurred_at: 0, recorded_at: 0, wall_at: "2026-10-28T12:00:00.000Z" };
  s.append("version.created", { version: 2, base_version: 1, ops: A_PRIOR.ops, scope: A_PRIOR.scope, meta, definition_hash: v2.definition_hash }, { recorded_at: 0, occurred_at: 0 });
  s.append("version.adopted", { version: 2, approver, at, scope: A_PRIOR.scope, definition_hash: v2.definition_hash }, { recorded_at: 0, occurred_at: 0 });
  s.close();
  return join(root, `${VERSIONS_STREAM}.jsonl`);
}
const spec = (over: Partial<VersionsSpec> = {}): VersionsSpec => ({
  ward_id: "A", requirement_version: "r1", facts: { payer_type: "self_pay", expected_disposition: "home", has_take_home_order: "false" }, facts_source: "test",
  steps: { st05: { fact: "stay.stage", equals: "signed" } }, events: {}, documents: {}, ...over
});

describe("the adopted version wired for an EMR", () => {
  it("replays a person's version log into the run's store and reads version 2 with nothing to offer a self-pay patient", () => {
    const store = mkdtempSync(join(tmpdir(), "emr-store-"));
    const a = adoptedForEmr(store, versionLog(), () => spec());
    expect([a.def.version, a.parent?.version]).toEqual([2, 1]);
    expect(a.log.map((r) => r.record_type)).toEqual(["version.created", "version.adopted"]);
    const r = a.wiring.rulesFor("owner", ["draft_note"])!;
    expect(r.lines).toEqual(["Nothing to offer under version 2 for a self-pay patient."]);
    expect(r.offers).toEqual([]);
    expect(Object.fromEntries(r.readings.map((x) => [x.step_id, x.status]))).toEqual({ st06: "no_counterpart", st14: "not_agent_work", st09a: "not_applicable", st17a: "no_counterpart" });
  });

  it("re-reads the requirement data at each check, so a planted ward B r2 blocks the summary offer", () => {
    let current = spec({ ward_id: "B", facts: { payer_type: "self_pay", expected_disposition: "home", has_take_home_order: "true" }, documents: { "discharge_summary.draft": { kind: "draft_note", ask: "Say draft the summary." } } });
    const a = adoptedForEmr(mkdtempSync(join(tmpdir(), "emr-store-")), versionLog(), () => current);
    const offer = a.wiring.rulesFor("owner", ["draft_note"])!.offers[0]!;
    expect(a.wiring.check(offer).ok).toBe(true);
    current = { ...current, requirement_version: "r2" };
    expect(a.wiring.check(offer)).toMatchObject({ ok: false, requirement_version: "r2" });
  });
});

// The summary draft after the round entry, adopted for ward A only, then suspended in the source by a person.
const ROUND_OPS = [{ op: "remove_soft_edge", edge_id: "e04" }, { op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st01" } } }];
const WARD_A = { wards: ["A"], condition: null };
function wardLog(): { root: string; file: string; suspend: (reason: string) => void } {
  const root = mkdtempSync(join(tmpdir(), "vlog-a-"));
  const v2 = Registry.load([loadV1()]).propose(1, ROUND_OPS as never, meta, { scope: WARD_A, fallback: 1 }).version!;
  const s = openStream(root, VERSIONS_STREAM, { writer: true });
  s.append("version.created", { version: 2, base_version: 1, ops: ROUND_OPS, scope: WARD_A, meta, definition_hash: v2.definition_hash }, { recorded_at: 0, occurred_at: 0 });
  s.append("version.adopted", { version: 2, approver, at: { occurred_at: 0, recorded_at: 0, wall_at: "2026-10-31T07:00:00.000Z" }, scope: WARD_A, definition_hash: v2.definition_hash }, { recorded_at: 0, occurred_at: 0 });
  s.close();
  const suspend = (reason: string) => {
    const w = openStream(root, VERSIONS_STREAM, { writer: true });
    w.append("version.suspended", { version: 2, by: approver, reason, at: { occurred_at: 1, recorded_at: 1, wall_at: "2026-10-31T08:15:00.000Z" }, proposal: null }, { recorded_at: 1, occurred_at: 1 });
    w.close();
  };
  return { root, file: join(root, `${VERSIONS_STREAM}.jsonl`), suspend };
}
const wardSpec = (): VersionsSpec => spec({
  ward_fact: "stay.ward", wards: { "Children's Ward": "A", "Private Ward": "B" },
  steps: { st01: { fact: "stay.round", equals: "recorded" }, st05: { fact: "discharge.stage", equals: "clinical_done" } },
  documents: { "discharge_summary.draft": { kind: "draft_stay_summary", ask: "Say draft the summary." } }
});
const WARD_A_STAY = { "stay.ward": "Children's Ward", "stay.round": "recorded", "discharge.stage": "awaiting_sign_off" };

describe("the version history is the authority for the running EMR", () => {
  it("resolves version 1 on the next reading after a person suspends version 2 in the source, says why, and a restart agrees", () => {
    const log = wardLog();
    const store = mkdtempSync(join(tmpdir(), "emr-store-"));
    const a = adoptedForEmr(store, log.file, wardSpec);
    expect(a.wiring.rulesFor("nurse", ["draft_stay_summary"], WARD_A_STAY)).toMatchObject({ version: 2, offers: [{ step_id: "st06", kind: "draft_stay_summary" }] });
    const before = a.log_hash;
    log.suspend("drafts waited past sign-off on a late round entry");
    const after = a.wiring.rulesFor("nurse", ["draft_stay_summary"], WARD_A_STAY)!;
    expect(after.version).toBe(1);
    // Version 1 offers the draft only at sign-off, not at the round entry.
    expect(after.offers.map((o) => o.key)).toEqual(["v1:st06:discharge.stage=clinical_done:draft_stay_summary"]);
    expect(after.log_hash).not.toBe(before);
    const why = "version 2 was suspended by Synthetic ward manager (test) on 31 Oct, 09:15 (drafts waited past sign-off on a late round entry), so version 1 is in force";
    expect(after.withheld).toMatchObject([{ version: 2, in_force: 1, step_id: "st06", reason: why }]);
    expect(a.wiring.withdrawReason?.(2, WARD_A_STAY)).toBe(why);
    // A restart reads the same source again rather than the copy it kept.
    const b = adoptedForEmr(store, log.file, wardSpec);
    expect(b.wiring.rulesFor("nurse", ["draft_stay_summary"], WARD_A_STAY)).toMatchObject({ version: 1, offers: [{ when: [{ fact: "discharge.stage" }] }] });
    expect(b.wiring.withdrawReason?.(2, WARD_A_STAY)).toBe(why);
  });

  it("offers nothing while the source cannot be read, and resumes when it can", () => {
    const log = wardLog();
    const a = adoptedForEmr(mkdtempSync(join(tmpdir(), "emr-store-")), log.file, wardSpec);
    const kept = readFileSync(log.file);
    rmSync(log.file);
    expect(a.wiring.rulesFor("nurse", ["draft_stay_summary"], WARD_A_STAY)).toBeNull();
    expect(a.wiring.withdrawReason?.(2, WARD_A_STAY)).toMatch(/cannot be read/);
    writeFileSync(log.file, kept);
    expect(a.wiring.rulesFor("nurse", ["draft_stay_summary"], WARD_A_STAY)).toMatchObject({ version: 2 });
  });
});

describe("watched facts that stand for a workflow event", () => {
  it("reads the round entry and the take-home order as present words, and nothing when the record has neither", () => {
    const stay = { latestNote: { body: "Seen on the round", timeLabel: "30 Oct · 09:10" } };
    const discharge = { stage: "clinical_pending", paperwork: { medicines: [{ takeHome: false }, { takeHome: true }] } };
    expect(factValue(stay, { path: "latestNote.timeLabel", present: "recorded" })).toBe("recorded");
    expect(factValue({ latestNote: null }, { path: "latestNote.timeLabel", present: "recorded" })).toBeNull();
    expect(factValue(discharge, { path: "paperwork.medicines[].takeHome", present: "ordered" })).toBe("ordered");
    expect(factValue({ paperwork: { medicines: [{ takeHome: false }] } }, { path: "paperwork.medicines[].takeHome", present: "ordered" })).toBeNull();
    expect(factValue({ paperwork: { medicines: [] } }, { path: "paperwork.medicines[].takeHome", present: "ordered" })).toBeNull();
    expect(factValue(discharge, { path: "stage" })).toBe("clinical_pending");
  });
});
