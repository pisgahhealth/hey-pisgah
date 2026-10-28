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

// The parts of a generated case file the agent's world needs; typed here by shape so the agent never imports the case generator.
export type GeneratedCaseFile = {
  case_id: string; schedule: CaseWorld["schedule"];
  initial_state: { notes: { note_id: string; author_role: string; occurred_at: number; recorded_at: number; untrusted_text: string }[] };
};
export type WorldSpec = { opened_at: number; requirements: { at: number; set: "r1" | CaseWorld["requirements"][number]["set"] }[]; exception_confirm_after_min?: number };

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

