import { definitionHash, type RunMetrics, type RunResult, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { loadPool, type InitialState, type Manifest } from "@hey-pisgah/cases";
import type { ExternalSchedule } from "@hey-pisgah/simulator";
import { inScope, type Facts } from "@hey-pisgah/workflow";
import { runAcceptance, type AcId, type VersionContext } from "../acceptance/checks.js";
import { recordStateFromRun, verifyCompletion } from "../completion.js";
import { loadManifests, type ManifestPool } from "../data.js";
import { runCase } from "../pipeline.js";

// One case an arm runs on: the frozen schedule, the evaluator's manifest and the case's opening record.
export type ArmCase = { schedule: ExternalSchedule; schedule_hash: string; manifest: Manifest; initial_state: InitialState };

export function poolCases(pool: ManifestPool): ArmCase[] {
  const manifests = loadManifests(pool);
  return loadPool(pool === "dev_held" ? "dev/held" : pool).map((f) => {
    const manifest = manifests.get(f.case_id);
    if (!manifest) throw new Error(`no manifest for ${f.case_id}`);
    return { schedule: f.schedule, schedule_hash: f.schedule_hash, manifest, initial_state: f.initial_state };
  });
}

export type ArmRow = {
  case_id: string; family: string; should_apply: boolean; in_scope: boolean;
  outcome: RunResult["outcome"]; pass: boolean; failing: AcId[]; verifier_pass: boolean;
  metrics: RunMetrics | null; decided_by: { model: number; runtime: number; person: number } | null;
  effect_set_hash: string | null; version_hash: string;
};
export type ArmResult = { arm: string; definition_hash: string; executor: "definition"; rows: ArmRow[]; runs: Map<string, RunResult> };

// Runs one arm's definition on the definition executor; out-of-scope cases run the fallback, as the pipeline does.
export function runArm(arm: string, def: WD, base: WD, cases: readonly ArmCase[]): ArmResult {
  const defHash = definitionHash(def);
  const baseHash = definitionHash(base);
  const rows: ArmRow[] = [];
  const runs = new Map<string, RunResult>();
  for (const c of cases) {
    const scoped = def.fallback_version === null ? true : inScope(def, c.schedule.facts as Facts);
    const ran = scoped ? def : base;
    const run = runCase(ran, c.schedule);
    runs.set(c.manifest.case_id, run);
    const version: VersionContext = defHash === baseHash || def.fallback_version === null
      ? { status: "adopted", version_hash: defHash, in_scope: true, fallback_hash: null, adopted_at_min: null }
      : { status: "adopted", version_hash: defHash, in_scope: scoped, fallback_hash: baseHash, adopted_at_min: null };
    const ac = runAcceptance({ run, manifest: c.manifest, requirement_version: c.manifest.requirement_version, definition: ran, schedule: c.schedule, version });
    const verdict = verifyCompletion(ran, recordStateFromRun(run, ran, c.manifest), c.manifest.case_id);
    rows.push({
      case_id: c.manifest.case_id, family: c.manifest.family, should_apply: c.manifest.should_apply.value, in_scope: scoped,
      outcome: run.outcome, pass: ac.pass, failing: ac.failing, verifier_pass: verdict.pass,
      metrics: run.outcome === "ok" ? run.metrics : null, decided_by: run.outcome === "ok" ? run.decided_by_counts : null,
      effect_set_hash: run.outcome === "ok" ? run.effect_set_hash : null, version_hash: run.version_hash
    });
  }
  return { arm, definition_hash: defHash, executor: "definition", rows, runs };
}
