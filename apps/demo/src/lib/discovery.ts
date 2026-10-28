import { readdirSync } from "node:fs";
import { join } from "node:path";
import { stepLabels } from "./labels.js";
import { readJson } from "./paths.js";

type HistEvent = { event_id: string; kind: string; occurred_at: number; recorded_at: number; actor_role: string | null; payload: Record<string, unknown> };
type CaseFile = {
  case_id: string;
  initial_state: { ward_id: string; bed: string; payer_type: string; admission_reason: string; patient: { name: string; age_years: number; sex: string } };
  history?: { events: HistEvent[] };
};

export type Milestone = { event_id: string; step_id: string; label: string; role: string | null; occurred_at: number; recorded_at: number };
export type BoardCase = {
  case_id: string; ward: string; bed: string; payer: string; patient: string; age: number; sex: string; reason: string;
  start: number; end: number; milestones: Milestone[]; entered_later: number;
};
export type WardBoard = { source: string; cases: BoardCase[]; span: { start: number; end: number } };

export const DISCOVERY_DIR = ["packages", "cases", "fixtures", "discovery"] as const;

// Builds the ward board from the committed discovery fixtures, as recorded, with no cause labels.
export function loadWardBoard(root: string): WardBoard {
  const dir = join(root, ...DISCOVERY_DIR);
  const labels = stepLabels(root);
  const cases = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f): BoardCase => {
    const c = readJson(join(dir, f)) as CaseFile;
    const evs = (c.history?.events ?? []).filter((e) => e.kind === "step.completed");
    const milestones = evs.map((e): Milestone => {
      const step = String(e.payload["step_id"] ?? "");
      return { event_id: e.event_id, step_id: step, label: labels.get(step) ?? step, role: e.actor_role, occurred_at: e.occurred_at, recorded_at: e.recorded_at };
    }).sort((a, b) => a.occurred_at - b.occurred_at || a.recorded_at - b.recorded_at);
    const all = (c.history?.events ?? []).flatMap((e) => [e.occurred_at, e.recorded_at]);
    const s = c.initial_state;
    return {
      case_id: c.case_id, ward: s.ward_id, bed: s.bed, payer: s.payer_type, patient: s.patient.name, age: s.patient.age_years, sex: s.patient.sex, reason: s.admission_reason,
      start: all.length ? Math.min(...all) : 0, end: all.length ? Math.max(...all) : 0, milestones,
      entered_later: milestones.filter((m) => m.recorded_at > m.occurred_at).length
    };
  }).sort((a, b) => a.ward.localeCompare(b.ward) || a.bed.localeCompare(b.bed));
  const start = Math.min(...cases.map((c) => c.start));
  const end = Math.max(...cases.map((c) => c.end));
  return { source: DISCOVERY_DIR.join("/"), cases, span: { start: Math.floor(start / 60) * 60, end: Math.ceil(end / 60) * 60 } };
}

export const PAYER_LABEL: Record<string, string> = { self_pay: "Self pay", hmo: "HMO", corporate: "Corporate" };
