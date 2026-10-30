import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSIONS_STREAM, adoptedRegistry, caseFacts, versionWiring, type Encounter, type RequirementsNow, type VersionWiring } from "@hey-pisgah/agent";
import type { WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import type { VersionsSpec } from "./profile.js";

export type AdoptedForEmr = { def: WD; parent: WD | null; wiring: VersionWiring; log: { record_type: string; payload: unknown }[] };

// The workflow ward an encounter is on: from the watched ward fact through the profile's ward map, or the profile's one ward when it maps none; null while the record names no mapped ward.
export function wardFor(v: VersionsSpec, encounter?: Encounter): string | null {
  if (!v.ward_fact || !v.wards) return v.ward_id;
  const label = encounter?.[v.ward_fact] ?? null;
  return label ? v.wards[label] ?? null : null;
}

// The requirement data in force for one encounter, read again from the spec on every call.
export const requirementsNow = (spec: () => VersionsSpec): ((encounter?: Encounter) => RequirementsNow | null) => (encounter) => {
  const v = spec();
  const ward = wardFor(v, encounter);
  if (!ward) return null;
  return { ward_id: ward, requirement_version: v.requirement_version, facts: caseFacts({ ...v, ward_id: ward }) };
};

// Copies a person's version log into the run's store, replays it, and wires the version in force per encounter for this EMR, with the newest adopted version's withheld offers.
export function adoptedForEmr(storeRoot: string, versionLog: string, spec: () => VersionsSpec): AdoptedForEmr {
  const target = join(storeRoot, `${VERSIONS_STREAM}.jsonl`);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(versionLog, target);
  }
  const now = requirementsNow(spec);
  const reg = adoptedRegistry(storeRoot);
  const v = spec();
  return { def: reg.newest.def, parent: reg.newest.parent, log: reg.log, wiring: versionWiring({ def: reg.newest.def, parent: reg.newest.parent, counterparts: { steps: v.steps, events: v.events, documents: v.documents }, requirements: now, resolve: reg.resolve, newest: reg.newest }) };
}
