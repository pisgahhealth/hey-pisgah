import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSIONS_STREAM } from "@hey-pisgah/agent";
import { loadV1 } from "@hey-pisgah/hospital";
import { openStream } from "@hey-pisgah/store";
import { Registry } from "@hey-pisgah/workflow";
import type { VersionsSpec } from "../src/profile.js";
import { adoptedForEmr } from "../src/versions.js";

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
