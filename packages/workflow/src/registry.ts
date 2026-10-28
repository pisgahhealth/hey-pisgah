import {
  WorkflowDefinition, definitionHash, fencesHash, permissionsHash, structureHash,
  type Clocks, type WorkflowDefinition as WD
} from "@hey-pisgah/contracts";
import { inScope, type Facts } from "./conditions.js";
import { applyOperations, type ApplyOptions, type ApplyResult } from "./operations.js";

export class RegistryError extends Error {
  constructor(readonly code: "invalid_definition" | "hash_mismatch" | "duplicate_version" | "unknown_version" | "bad_transition" | "adoption_requires_person" | "no_current_version", message: string) {
    super(message);
  }
}

export type DefinitionHashes = { definition_hash: string; fences_hash: string; permissions_hash: string; structure_hash: string };

// The four content hashes of a definition, computed fresh.
export function hashDefinition(def: WD): DefinitionHashes {
  return { definition_hash: definitionHash(def), fences_hash: fencesHash(def), permissions_hash: permissionsHash(def), structure_hash: structureHash(def) };
}

// Only a person may adopt, suspend or revert; the role is fixed to the ward manager by the contract.
export type PersonApprover = { kind: "person"; staff_id: string; role: "ward_manager"; display_name: string };

export type VersionSummary = { version: number; parent_version: number | null; status: WD["status"]; definition_hash: string; adopted_at: Clocks | null };

type ProposeMeta = Pick<WD["metadata"], "author" | "proposal_id" | "source_evidence" | "model_provenance">;

function deepFreeze<T>(x: T): T {
  if (x && typeof x === "object") {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}

function requirePerson(p: { kind: string }): void {
  if (p.kind !== "person") throw new RegistryError("adoption_requires_person", "only a person may change a version's standing");
}

// In-memory version registry over definitions passed in as parsed JSON; it never touches the filesystem.
export class Registry {
  private readonly versions = new Map<number, WD>();

  static load(definitions: readonly unknown[]): Registry {
    const r = new Registry();
    for (const d of definitions) r.add(d);
    return r;
  }

  // Parses a definition, checks every stored hash against a fresh computation and stores a frozen copy.
  add(raw: unknown): WD {
    const p = WorkflowDefinition.safeParse(typeof raw === "string" ? JSON.parse(raw) : raw);
    if (!p.success) throw new RegistryError("invalid_definition", p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const def = p.data as WD;
    const h = hashDefinition(def);
    const stored = { definition_hash: def.definition_hash, fences_hash: def.metadata.fences_hash, permissions_hash: def.metadata.permissions_hash, structure_hash: def.metadata.structure_hash };
    for (const k of Object.keys(h) as (keyof DefinitionHashes)[]) {
      if (h[k] !== stored[k]) throw new RegistryError("hash_mismatch", `version ${def.version}: stored ${k} does not match its content`);
    }
    if (this.versions.has(def.version)) throw new RegistryError("duplicate_version", `version ${def.version} already exists`);
    if (def.parent_version !== null && !this.versions.has(def.parent_version)) throw new RegistryError("unknown_version", `parent ${def.parent_version} is not loaded`);
    this.versions.set(def.version, deepFreeze(structuredClone(def)));
    return this.get(def.version);
  }

  get(version: number): WD {
    const d = this.versions.get(version);
    if (!d) throw new RegistryError("unknown_version", `version ${version} does not exist`);
    return structuredClone(d);
  }

  list(): VersionSummary[] {
    return [...this.versions.values()]
      .sort((a, b) => a.version - b.version)
      .map((d) => ({ version: d.version, parent_version: d.parent_version, status: d.status, definition_hash: d.definition_hash, adopted_at: d.metadata.adopted_at }));
  }

  // Applies operations to a base version and stores the result as a new proposed version.
  propose(base: number, ops: readonly unknown[], meta: ProposeMeta, opts: ApplyOptions = {}): { result: ApplyResult; version: WD | null } {
    const parent = this.get(base);
    const result = applyOperations(parent, ops, opts);
    if (!result.ok || result.noop) return { result, version: null };
    const next = Math.max(...this.versions.keys()) + 1;
    const def: WD = {
      ...result.definition,
      version: next,
      parent_version: base,
      status: "proposed",
      fallback_version: parent.fallback_version,
      metadata: {
        ...parent.metadata,
        ...meta,
        change_ops: structuredClone([...ops]),
        approver: null,
        adopted_at: null,
        effective_from: null,
        supersedes: null,
        suspended: null,
        reverted: null
      }
    };
    return { result, version: this.add(def) };
  }

  private replace(version: number, change: (d: WD) => WD): WD {
    const next = change(this.get(version));
    this.versions.set(version, deepFreeze(next));
    return this.get(version);
  }

  // Records the evaluator's dev verdict on a proposed version.
  setValidation(version: number, status: "dev_validated" | "dev_failed" | "rejected"): WD {
    const d = this.get(version);
    if (d.status !== "proposed" && !(status === "rejected" && d.status === "dev_failed")) throw new RegistryError("bad_transition", `${d.status} cannot become ${status}`);
    return this.replace(version, (x) => ({ ...x, status }));
  }

  // A person adopts a dev-validated version; content stays frozen and only the standing fields change.
  adopt(version: number, approver: PersonApprover, at: Clocks, effective_from: number | null = null): WD {
    requirePerson(approver);
    const d = this.get(version);
    if (d.status !== "dev_validated") throw new RegistryError("bad_transition", `${d.status} cannot be adopted`);
    const prior = this.adoptedVersions().filter((v) => v.version !== version).at(-1);
    return this.replace(version, (x) => ({
      ...x,
      status: "adopted",
      metadata: {
        ...x.metadata,
        approver: { staff_id: approver.staff_id, role: approver.role, display_name: approver.display_name },
        adopted_at: structuredClone(at),
        effective_from,
        supersedes: prior?.version ?? null
      }
    }));
  }

  suspend(version: number, by: PersonApprover, reason: string, at: Clocks): WD {
    requirePerson(by);
    const d = this.get(version);
    if (d.status !== "adopted") throw new RegistryError("bad_transition", `${d.status} cannot be suspended`);
    return this.replace(version, (x) => ({ ...x, status: "suspended", metadata: { ...x.metadata, suspended: { by: by.staff_id, reason, at: structuredClone(at) } } }));
  }

  revert(version: number, by: PersonApprover, reason: string, at: Clocks): WD {
    requirePerson(by);
    const d = this.get(version);
    if (d.status !== "adopted" && d.status !== "suspended") throw new RegistryError("bad_transition", `${d.status} cannot be reverted`);
    return this.replace(version, (x) => ({ ...x, status: "reverted", metadata: { ...x.metadata, reverted: { by: by.staff_id, reason, at: structuredClone(at) } } }));
  }

  // Adopted versions in adoption order (occurred clock, then recorded, then version number).
  adoptedVersions(): WD[] {
    return [...this.versions.values()]
      .filter((d) => d.status === "adopted")
      .sort((a, b) => (a.metadata.adopted_at?.occurred_at ?? -1) - (b.metadata.adopted_at?.occurred_at ?? -1)
        || (a.metadata.adopted_at?.recorded_at ?? -1) - (b.metadata.adopted_at?.recorded_at ?? -1)
        || a.version - b.version)
      .map((d) => structuredClone(d));
  }

  // The latest adopted version whose scope covers these facts, falling back along fallback_version.
  current(facts: Facts): WD {
    const adopted = this.adoptedVersions();
    for (let i = adopted.length - 1; i >= 0; i--) {
      let d: WD | undefined = adopted[i];
      const seen = new Set<number>();
      while (d && !seen.has(d.version)) {
        seen.add(d.version);
        if (inScope(d, facts)) return d;
        const fb: number | null = d.fallback_version;
        d = fb === null ? undefined : this.versions.has(fb) ? this.get(fb) : undefined;
      }
    }
    throw new RegistryError("no_current_version", "no adopted version covers this case");
  }
}
