import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSIONS_STREAM, adoptedRegistry, caseFacts, versionWiring, type Encounter, type RequirementsNow, type VersionPick, type VersionSource, type VersionWiring } from "@hey-pisgah/agent";
import type { WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import type { VersionsSpec } from "./profile.js";

export type VersionRead = { log_hash: string; newest: VersionPick; latest: VersionPick; log: { record_type: string; payload: unknown }[]; source: VersionSource };
export type AdoptedForEmr = {
  readonly def: WD; readonly parent: WD | null; readonly log: { record_type: string; payload: unknown }[]; readonly log_hash: string | null; wiring: VersionWiring;
  // Reads the person's version log again and returns what stands now, or null when it cannot be read.
  refresh(): VersionRead | null;
};

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

// The person's version log is the authority: it is read on every use, mirrored into the run's store when its content changes, and replayed; a log that cannot be read leaves no version in use.
export function adoptedForEmr(storeRoot: string, versionLog: string, spec: () => VersionsSpec): AdoptedForEmr {
  const mirror = join(storeRoot, `${VERSIONS_STREAM}.jsonl`);
  let last: VersionRead | null = null;
  const refresh = (): VersionRead | null => {
    let bytes: Buffer;
    try { bytes = readFileSync(versionLog); } catch { last = null; return null; }
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (last?.log_hash === hash) return last;
    try {
      mkdirSync(dirname(mirror), { recursive: true });
      const tmp = `${mirror}.${process.pid}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, mirror);
      const reg = adoptedRegistry(storeRoot);
      last = { log_hash: hash, newest: reg.newest, latest: reg.latest, log: reg.log, source: { resolve: reg.resolve, newest: reg.latest, get: reg.get, reason: reg.reason!, log_hash: hash } };
    } catch {
      last = null;
    }
    return last;
  };
  const first = refresh();
  if (!first) throw new Error(`the version log ${versionLog} cannot be read or replayed`);
  const v = spec();
  const wiring = versionWiring({ def: first.newest.def, parent: first.newest.parent, counterparts: { steps: v.steps, events: v.events, documents: v.documents }, requirements: requirementsNow(spec), source: () => refresh()?.source ?? null });
  return {
    get def() { return (last ?? first).newest.def; },
    get parent() { return (last ?? first).newest.parent; },
    get log() { return (last ?? first).log; },
    get log_hash() { return last?.log_hash ?? null; },
    wiring, refresh
  };
}
