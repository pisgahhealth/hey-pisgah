import { definitionHash, type RunResult, type SimEvent, type WorkflowDefinition } from "@hey-pisgah/contracts";
import { loadPool, type CaseFile, type Manifest } from "@hey-pisgah/cases";
import { loadV1 } from "@hey-pisgah/hospital";
import type { AcInput, VersionContext } from "../src/acceptance/checks.js";
import type { OkRun } from "../src/acceptance/trace.js";
import { loadManifests } from "../src/data.js";
import { runCase } from "../src/pipeline.js";

export const v1 = loadV1();
export const caseOf = (pool: "dev" | "variation", id: string): { file: CaseFile; manifest: Manifest } => {
  const file = loadPool(pool).find((c) => c.case_id === id);
  const manifest = loadManifests(pool).get(id);
  if (!file || !manifest) throw new Error(`no case ${id}`);
  return { file, manifest };
};
export const ok = (r: RunResult): OkRun => { if (r.outcome !== "ok") throw new Error("aborted"); return r; };
export const adopted = (def: WorkflowDefinition): VersionContext => ({ status: "adopted", version_hash: definitionHash(def), in_scope: true, fallback_hash: null, adopted_at_min: null });

type Edit = (events: SimEvent[], run: OkRun) => void;
export function input(pool: "dev" | "variation", id: string, defOrEdit?: WorkflowDefinition | Edit, editArg?: Edit): AcInput {
  const def = typeof defOrEdit === "function" || defOrEdit === undefined ? v1 : defOrEdit;
  const edit = typeof defOrEdit === "function" ? defOrEdit : editArg;
  const c = caseOf(pool, id);
  const run = structuredClone(ok(runCase(def, c.file.schedule)));
  if (edit) {
    const events = [...run.events];
    edit(events, run);
    run.events = events.map((e, i) => ({ ...e, seq: i + 1 }));
  }
  return { run, manifest: c.manifest, requirement_version: c.manifest.requirement_version, definition: def, schedule: c.file.schedule, version: adopted(def) };
}

// Finds one event by kind and step, failing loudly so a fixture never silently tests nothing.
export function find(events: readonly SimEvent[], kind: string, step: string): SimEvent {
  const e = events.find((x) => x.kind === kind && ((x.payload as Record<string, unknown> | null)?.["step_id"] === step || x.subject === step));
  if (!e) throw new Error(`no ${kind} for ${step}`);
  return e;
}
export const indexOf = (events: readonly SimEvent[], e: SimEvent) => events.findIndex((x) => x.event_id === e.event_id);
export const fake = (base: SimEvent, over: Partial<SimEvent>): SimEvent => ({ ...base, ...over });
