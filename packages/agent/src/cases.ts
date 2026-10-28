import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadWardRequirements } from "@hey-pisgah/hospital";
import { CaseWorld } from "./world.js";

export const FIXTURE_CASES_DIR = new URL("../fixtures/cases/", import.meta.url).pathname;

// Reads one case file; a requirement set written as "r1" means the hospital's published r1 set.
export function parseCaseFile(text: string): CaseWorld {
  const raw = JSON.parse(text) as { requirements?: { at: number; set: unknown }[] };
  const r1 = loadWardRequirements();
  if (Array.isArray(raw.requirements)) raw.requirements = raw.requirements.map((r) => ({ ...r, set: r.set === "r1" ? r1 : r.set }));
  return CaseWorld.parse(raw);
}

export function loadCases(dir: string = FIXTURE_CASES_DIR): Map<string, CaseWorld> {
  const out = new Map<string, CaseWorld>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const w = parseCaseFile(readFileSync(join(dir, f), "utf8"));
    out.set(w.case_id, w);
  }
  return out;
}
