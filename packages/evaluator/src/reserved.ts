import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RunId } from "@hey-pisgah/contracts";
import { caseIdFor, type GeneratedCase } from "@hey-pisgah/cases";
import { RESERVED_CANARIES, generateReserved, seedList } from "@hey-pisgah/cases/reserved";
import { assertAllowedPath, syncDir } from "@hey-pisgah/store";
import { RESERVED_HASH_FILE } from "./data.js";

// Sealed: the only module that reaches the reserved generator; everything it makes stays in memory or under reserved-runs.
export const storeRoot = (root: string) => join(root, ".hey-pisgah", "store");
export const runsRoot = (root: string) => join(root, ".hey-pisgah", "runs");
export const reservedRunsRoot = (root: string) => join(root, ".hey-pisgah", "reserved-runs");
// The serve process opens only these roots; reserved outputs sit outside both.
export const serveAllowlist = (root: string): readonly string[] => [storeRoot(root), runsRoot(root)];
export const reservedRunFile = (root: string) => join(root, "evaluation", "reserved", "RUN.json");

export class ReservedRunRefused extends Error {
  readonly code = "reserved_run_refused";
  constructor(readonly reason: "ci" | "run_recorded") { super(`the reserved run is refused: ${reason}`); }
}

// The one reserved run may not start in CI or once its RUN.json exists.
export function reservedRunRefusal(root: string, env: NodeJS.ProcessEnv = process.env): ReservedRunRefused | null {
  if (env["CI"] === "true") return new ReservedRunRefused("ci");
  if (existsSync(reservedRunFile(root))) return new ReservedRunRefused("run_recorded");
  return null;
}

// Reserved or spare cases in memory, for the sealed G checks; refuses when the committed seed hash does not match.
export function reservedCasesInMemory(set: "reserved" | "spare", hashFile = RESERVED_HASH_FILE): GeneratedCase[] {
  return generateReserved(hashFile, set);
}

// Reserved cases for the one reserved run: the run guard first, then the seal.
export function sealedReservedCases(root: string, opts: { env?: NodeJS.ProcessEnv; hashFile?: string; set?: "reserved" | "spare" } = {}): GeneratedCase[] {
  const refused = reservedRunRefusal(root, opts.env);
  if (refused) throw refused;
  return reservedCasesInMemory(opts.set ?? "reserved", opts.hashFile);
}

// Writes one reserved-run output once, by temp file and rename, and only under reserved-runs.
export function writeReservedArtifact(root: string, runId: string, name: string, data: unknown): string {
  RunId.parse(runId);
  if (!/^[a-z0-9_.-]+$/.test(name) || name.startsWith(".")) throw new Error("artifact names are plain file names");
  const base = reservedRunsRoot(root);
  const file = assertAllowedPath([base], join(base, runId, name));
  if (existsSync(file)) throw new Error("a reserved artifact is written once");
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  renameSync(tmp, file);
  syncDir(dirname(file));
  return file;
}

// The tokens a non-reserved transcript must never contain: reserved and spare case ids and the canary surnames.
export function reservedTokens(): { ids: string[]; canaries: string[] } {
  return { ids: seedList().map((e) => caseIdFor(e.seed)), canaries: [...RESERVED_CANARIES] };
}

// The uniform answer for any id an agent-facing lookup will not reveal: unknown, reserved and dev-validation ids look the same.
export const UNKNOWN_ID = Object.freeze({ ok: false as const, error: "unknown_id" as const, message: "No record has that id." });
export type Lookup<T> = (id: unknown) => { ok: true; value: T } | typeof UNKNOWN_ID;

// Answers only from the visible map; anything else, of any shape, gets the same frozen object.
export function visibleLookup<T>(visible: ReadonlyMap<string, T>): Lookup<T> {
  return (id) => {
    if (typeof id !== "string" || !visible.has(id)) return UNKNOWN_ID;
    return { ok: true, value: visible.get(id)! };
  };
}
