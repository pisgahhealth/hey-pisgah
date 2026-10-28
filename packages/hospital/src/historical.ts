import { readFileSync } from "node:fs";
import { z } from "zod";
import type { WorkflowDefinition } from "@hey-pisgah/contracts";
import { loadV1 } from "./definition.js";
import { stubEngine, type DischargeEngine, type EngineRun, type Practice } from "./engine-seam.js";
import { loadWardRequirements } from "./requirements.js";
import { loadWorldBindings, loadWorldParameters, type Schedule } from "./world.js";

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

// How v1 is practised on the ward, as a function of the hidden habits; practice may drop a soft edge but never a fence.
export function practiceFor(def: WorkflowDefinition, schedule: Schedule, staff: StaffFile): { def: WorkflowDefinition; practice: Practice } {
  const byId = new Map(staff.profiles.map((p) => [p.staff_id, p]));
  const nurse = byId.get(schedule.staff.nurse ?? "");
  const out = structuredClone(def);
  const practice: Practice = {
    // The folder and medicines leave with the patient once accounts clear the bill (observed flow).
    start_after: { st14: ["st13"], st15: ["st13"] },
    entry_lag: ({ actor_id }) => { const p = byId.get(actor_id); return p ? staff.entry_defaults[p.entry_habit] ?? null : null; }
  };
  if (nurse?.prep_habit === "early_draft") {
    const soft = out.edges.find((e) => e.kind === "soft" && e.to.step === "st06");
    if (soft) out.edges = out.edges.filter((e) => e !== soft);
    practice.triggers = { st06: { on: "discharge.expected_recorded" } };
  }
  return { def: out, practice };
}

// Historical executor: v1 as practised, driven by the engine; the default engine is the local stub until the simulator lands.
export function runHistorical(schedule: Schedule, engine: DischargeEngine = stubEngine): EngineRun {
  const { def, practice } = practiceFor(loadV1(), schedule, loadStaff());
  const world = { bindings: loadWorldBindings(), requirements: loadWardRequirements() };
  return engine.run(def, world, schedule, { preparer: "staff", parameters: loadWorldParameters(), practice });
}
