import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REQUIREMENT_VERSIONS, loadWardRequirements } from "@hey-pisgah/hospital";
import { CaseWorld } from "./world.js";

export const FIXTURE_CASES_DIR = new URL("../fixtures/cases/", import.meta.url).pathname;

// Reads one case file; a requirement set written as "r1" or "r2" means the hospital's published set of that version.
export function parseCaseFile(text: string): CaseWorld {
  const raw = JSON.parse(text) as { requirements?: { at: number; set: unknown }[] };
  const named = (v: unknown) => ((REQUIREMENT_VERSIONS as readonly unknown[]).includes(v) ? loadWardRequirements(v as (typeof REQUIREMENT_VERSIONS)[number]) : v);
  if (Array.isArray(raw.requirements)) raw.requirements = raw.requirements.map((r) => ({ ...r, set: named(r.set) }));
  return CaseWorld.parse(raw);
}

// The parts of a generated case file the agent's world needs; typed here by shape so the agent never imports the case generator.
export type GeneratedCaseFile = {
  case_id: string; schedule: CaseWorld["schedule"];
  initial_state: { notes: { note_id: string; author_role: string; occurred_at: number; recorded_at: number; untrusted_text: string }[] };
};
export type WorldSpec = { opened_at: number; requirements: { at: number; set: (typeof REQUIREMENT_VERSIONS)[number] | CaseWorld["requirements"][number]["set"] }[]; exception_confirm_after_min?: number };

// A generated case as the agent's world, in the on-disk form with requirement sets named by version.
export function caseWorldFile(file: GeneratedCaseFile, spec: WorldSpec): Record<string, unknown> {
  const out = {
    case_id: file.case_id, opened_at: spec.opened_at, schedule: file.schedule, requirements: spec.requirements,
    notes: file.initial_state.notes.map((n) => ({ note_id: n.note_id, author_role: n.author_role, occurred_at: n.occurred_at, recorded_at: n.recorded_at, text: n.untrusted_text })),
    ...(spec.exception_confirm_after_min !== undefined ? { exception_confirm_after_min: spec.exception_confirm_after_min } : {})
  };
  parseCaseFile(JSON.stringify(out));
  return out;
}

export function loadCases(dir: string = FIXTURE_CASES_DIR): Map<string, CaseWorld> {
  const out = new Map<string, CaseWorld>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const w = parseCaseFile(readFileSync(join(dir, f), "utf8"));
    out.set(w.case_id, w);
  }
  return out;
}

// The two demo cases as agent worlds: the step 5 case under r1, and the step 6 case whose Ward B requirements change to r2 at minute 600 as data.
export const DEMO_WORLDS: Record<string, WorldSpec> = {
  "c-110f6ad7": { opened_at: 480, requirements: [{ at: 0, set: "r1" }], exception_confirm_after_min: 10 },
  "c-2a14921a": { opened_at: 480, requirements: [{ at: 0, set: "r1" }, { at: 600, set: "r2" }], exception_confirm_after_min: 10 }
};
