import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSIONS_STREAM, adoptedVersion, caseFacts, versionWiring, type RequirementsNow, type VersionWiring } from "@hey-pisgah/agent";
import type { WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import type { VersionsSpec } from "./profile.js";

export type AdoptedForEmr = { def: WD; parent: WD | null; wiring: VersionWiring; log: { record_type: string; payload: unknown }[] };

// The requirement data in force, read again from the spec on every call.
export const requirementsNow = (spec: () => VersionsSpec): (() => RequirementsNow) => () => {
  const v = spec();
  return { ward_id: v.ward_id, requirement_version: v.requirement_version, facts: caseFacts(v) };
};

// Copies a person's version log into the run's store, replays it, and wires the version in force for this EMR's ward.
export function adoptedForEmr(storeRoot: string, versionLog: string, spec: () => VersionsSpec): AdoptedForEmr {
  const target = join(storeRoot, `${VERSIONS_STREAM}.jsonl`);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(versionLog, target);
  }
  const now = requirementsNow(spec);
  const { def, parent, log } = adoptedVersion(storeRoot, now().facts);
  const v = spec();
  return { def, parent, log, wiring: versionWiring({ def, parent, counterparts: { steps: v.steps, events: v.events, documents: v.documents }, requirements: now }) };
}
