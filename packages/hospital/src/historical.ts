import { readFileSync } from "node:fs";
import { z } from "zod";
import { SOFT_EDGE_NOTE, WorkflowDefinition, type RunResult, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { entryLagKey, runDefinition, type ExternalSchedule } from "@hey-pisgah/simulator";
import { applyOperations } from "@hey-pisgah/workflow";
import { loadV1 } from "./definition.js";
import { worldRules } from "./world.js";

// Staff profiles are hidden: only this module reads them, and no tool or the main entry re-exports them.
const EntryHabit = z.enum(["realtime", "batch_after_round", "paper_then_type"]);
export const StaffProfile = z.strictObject({
  staff_id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  role: z.enum(["nurse", "doctor"]),
  ward_id: z.string().regex(/^[A-Z][A-Za-z0-9_]*$/),
  prep_habit: z.enum(["after_signoff", "early_draft"]).nullable(),
  entry_habit: EntryHabit
}).refine((p) => (p.role === "nurse") === (p.prep_habit !== null), { message: "only nurses carry a prep habit" });
export type StaffProfile = z.infer<typeof StaffProfile>;
export const StaffFile = z.strictObject({
  profiles: z.array(StaffProfile).min(1),
  entry_defaults: z.record(EntryHabit, z.strictObject({ lag_min: z.number().int().min(0).max(1440), reason: z.string().max(200).nullable() }))
});
export type StaffFile = z.infer<typeof StaffFile>;

export const loadStaff = (): StaffFile => StaffFile.parse(JSON.parse(readFileSync(new URL("./hidden/staff.json", import.meta.url), "utf8")));

// Habit lags apply to the round entry and the departure entry, the two records a ward commonly writes up later.
const LAGGED_STEPS: readonly [string, string][] = [["st01", "doctor"], ["st16", "nurse"]];

// v1 as practised: habits become a practised definition and schedule entry lags; practice adds or drops soft edges only.
export function practiceFor(def: WD, schedule: ExternalSchedule, staff: StaffFile): { def: WD; schedule: ExternalSchedule } {
  const byId = new Map(staff.profiles.map((p) => [p.staff_id, p]));
  let out = structuredClone(def);
  if (byId.get(schedule.actors["nurse"] ?? "")?.prep_habit === "early_draft") {
    const r = applyOperations(out, [{ op: "remove_soft_edge", edge_id: "e04" }, { op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st01" } } }]);
    if (!r.ok) throw new Error(`practice refused: ${r.errors.map((e) => e.message).join("; ")}`);
    out = r.definition;
  }
  // The folder and the medicines leave with the patient once accounts clear the bill (observed flow).
  const soft = (edge_id: string, to: string) => ({ edge_id, from: { step: "st13" }, to: { step: to }, gate: "start" as const, kind: "soft" as const, origin: "ward_procedure" as const, immutable: false, note: SOFT_EDGE_NOTE });
  out.edges = [...out.edges, soft("e28", "st14"), soft("e29", "st15")];
  const sched = structuredClone(schedule);
  for (const [step, role] of LAGGED_STEPS) {
    const actor = sched.actors[role];
    const habit = actor ? byId.get(actor)?.entry_habit : undefined;
    const lag = habit ? staff.entry_defaults[habit] : undefined;
    const key = actor ? entryLagKey("step.completed", step, actor, 1) : null;
    if (key && lag && lag.lag_min > 0 && !(key in sched.entry_lag)) sched.entry_lag[key] = { lag_min: lag.lag_min, reason: lag.reason };
  }
  return { def: WorkflowDefinition.parse(out) as WD, schedule: sched };
}

// Historical executor: v1 as practised, run by the simulator with staff preparing and the hospital world rules.
export function runHistorical(schedule: ExternalSchedule): RunResult {
  const p = practiceFor(loadV1(), schedule, loadStaff());
  return runDefinition(p.def, p.schedule, { executor: "historical", use_agent: false, world: worldRules() });
}
