import { z } from "zod";
import { AGENT_ALLOWED_KINDS, CaseId, DocumentId, type RunResult, type SimEvent, type Step, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { WardRequirementSet, wardRequires, type Facts as HospitalFacts } from "@hey-pisgah/hospital";
import { ExternalSchedule, HORIZON_MIN, runDefinition, type ExternalSchedule as Schedule, type WorldRules } from "@hey-pisgah/simulator";
import { isPreparingStep } from "@hey-pisgah/workflow";

const Minute = z.number().int().min(0).max(HORIZON_MIN);

// One case the agent works on: the frozen world schedule plus the ward requirement versions in force over time.
export const CaseWorld = z.strictObject({
  case_id: CaseId,
  opened_at: Minute,
  schedule: ExternalSchedule,
  requirements: z.array(z.strictObject({ at: Minute, set: WardRequirementSet })).min(1)
}).superRefine((w, ctx) => {
  if (w.schedule.case_id !== w.case_id) ctx.addIssue({ code: "custom", message: "schedule case_id differs from the case" });
  if (w.requirements[0]!.at !== 0) ctx.addIssue({ code: "custom", message: "the first requirement set applies from minute 0" });
  for (let i = 1; i < w.requirements.length; i++) {
    if (w.requirements[i]!.at <= w.requirements[i - 1]!.at) ctx.addIssue({ code: "custom", message: "requirement changes must be in time order" });
  }
});
export type CaseWorld = z.infer<typeof CaseWorld>;

// A port write the engine must perform: the agent's preparing step starts at effect_at.
export type EngineCommit = { step_id: string; effect_at: number };

export class PortError extends Error {
  constructor(readonly code: "world_aborted" | "world_mismatch" | "clock_backwards" | "unknown_case", message: string) {
    super(message);
  }
}

// Steps the agent may take in this version: preparing steps where the role, the permission row and the document all name the agent.
export function agentSteps(def: WD): Step[] {
  return def.steps.filter((s) => isAgentStep(def, s));
}
export function isAgentStep(def: WD, s: Step): boolean {
  if (!isPreparingStep(s) || s.external) return false;
  if (!s.actor_roles.includes("agent") || !AGENT_ALLOWED_KINDS.has(s.action_kind)) return false;
  if (!(def.permissions[s.action_kind] ?? []).includes("agent")) return false;
  const doc = def.documents.find((d) => d.document_id === s.document_ref!.document_id);
  return doc !== undefined && doc.preparable_by.includes("agent");
}

export function requirementsAt(world: CaseWorld, minute: number): { index: number; set: WardRequirementSet; at: number } {
  let index = 0;
  for (let i = 0; i < world.requirements.length; i++) if (world.requirements[i]!.at <= minute) index = i;
  const r = world.requirements[index]!;
  return { index, set: r.set, at: r.at };
}

function hospitalFacts(facts: Record<string, string | readonly string[]>): HospitalFacts {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(facts)) if (typeof v === "string") out[k] = v;
  return out as HospitalFacts;
}

// The ward_requires list for a ward under one requirement set, from the structured list only.
export function wardRequiresList(set: WardRequirementSet, facts: Record<string, string | readonly string[]>): string[] {
  const ward = facts["ward_id"];
  if (typeof ward !== "string") return [];
  const hf = hospitalFacts(facts);
  return DocumentId.options.filter((d) => wardRequires(set, ward, d, hf));
}

// The schedule the engine runs: agent steps are blocked until a port write starts them at its effect minute.
export function engineSchedule(world: CaseWorld, def: WD, commits: readonly EngineCommit[]): Schedule {
  const s = structuredClone(world.schedule);
  s.facts = { ...s.facts, ward_requires: wardRequiresList(world.requirements[0]!.set, s.facts) };
  for (const step of agentSteps(def)) {
    const c = commits.find((x) => x.step_id === step.step_id);
    const { blocked: _b, not_before: _n, ...draw } = s.steps[step.step_id] ?? {};
    s.steps[step.step_id] = c ? { ...draw, not_before: c.effect_at } : { ...draw, blocked: true };
  }
  return s;
}

export type OkRun = Extract<RunResult, { outcome: "ok" }>;

export function engineRun(world: CaseWorld, def: WD, commits: readonly EngineCommit[], runId: string, rules: WorldRules | null): OkRun {
  const r = runDefinition(def, engineSchedule(world, def, commits), { run_id: runId, executor: "definition", use_agent: true, ...(rules ? { world: rules } : {}) });
  if (r.outcome !== "ok") throw new PortError("world_aborted", `the world run aborted: ${r.invariant_violations.join("; ")}`);
  return r;
}

export type ViewEvent = SimEvent & { source: "engine" | "port" | "requirements" };
export const HORIZON = HORIZON_MIN;
