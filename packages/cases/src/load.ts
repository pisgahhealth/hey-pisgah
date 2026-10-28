import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CaseFile } from "./types.js";

export const FIXTURES_ROOT = new URL("../fixtures/", import.meta.url).pathname;
export const COMMITTED_POOLS = ["discovery", "dev", "dev/held", "variation", "demo"] as const;
export type CommittedPool = (typeof COMMITTED_POOLS)[number];

// Reads one committed pool folder; reserved cases are never on disk, so they cannot be read here.
export function loadPool(pool: CommittedPool): CaseFile[] {
  const dir = join(FIXTURES_ROOT, pool);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^c-[a-z0-9]{8}\.json$/.test(f)).sort().map((f) => CaseFile.parse(JSON.parse(readFileSync(join(dir, f), "utf8"))));
}

export function findCase(caseId: string): { pool: CommittedPool; file: CaseFile } | null {
  for (const pool of COMMITTED_POOLS) {
    const p = join(FIXTURES_ROOT, pool, `${caseId}.json`);
    if (existsSync(p)) return { pool, file: CaseFile.parse(JSON.parse(readFileSync(p, "utf8"))) };
  }
  return null;
}

export const loadSubsets = (): { pools: Record<string, string[]>; demo: { step5: string; step6: string }; fr4: { dev: string[]; demo: string[] }; infra_fault: string[] } =>
  JSON.parse(readFileSync(join(FIXTURES_ROOT, "subsets.json"), "utf8"));
