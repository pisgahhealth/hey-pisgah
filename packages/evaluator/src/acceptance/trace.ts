import type { RunResult, SimEvent, Step, WorkflowDefinition } from "@hey-pisgah/contracts";
import type { ExternalSchedule } from "@hey-pisgah/simulator";
import { boundRecordKinds, evalCondition, isPreparingStep, type Facts } from "@hey-pisgah/workflow";

export type OkRun = Extract<RunResult, { outcome: "ok" }>;
type Payload = Record<string, unknown>;

export const payloadOf = (e: SimEvent): Payload => (e.payload !== null && typeof e.payload === "object" ? (e.payload as Payload) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

// The step an event is about: the payload's step id, else the subject for revisions and checks.
export function stepOf(e: SimEvent): string | null {
  return str(payloadOf(e)["step_id"]) ?? (e.kind === "document.revised" || e.kind.startsWith("check.") ? e.subject : null);
}

// Strict event order: occurred time first, then seq.
export const before = (a: SimEvent, b: SimEvent): boolean => a.seq < b.seq && a.occurred_at <= b.occurred_at;

export function finalFacts(run: OkRun): Facts {
  const fs = (run.final_state as { facts?: unknown } | null)?.facts;
  return fs !== null && typeof fs === "object" ? (fs as Facts) : {};
}

// A step is required when its condition holds and, inside an alternative group, it is the member the schedule selects.
export function isRequired(def: WorkflowDefinition, s: Step, facts: Facts, schedule: ExternalSchedule | null): boolean {
  if (s.required_when !== null && !evalCondition(s.required_when, facts)) return false;
  if (s.alternative_group === null) return true;
  const members = def.steps.filter((x) => x.alternative_group === s.alternative_group).map((x) => x.step_id).sort();
  return (schedule?.alternatives[s.alternative_group] ?? members[0]) === s.step_id;
}

// Replays one run's event log to answer what each prepared stage cited and what each record's version was at any point.
export class Trace {
  readonly events: readonly SimEvent[];
  private readonly versionLog: { seq: number; kind: string; version: number }[] = [];
  private readonly captures = new Map<string, { seq: number; captured: Record<string, number> }[]>();

  constructor(readonly run: OkRun, readonly def: WorkflowDefinition) {
    this.events = [...run.events].sort((a, b) => a.seq - b.seq);
    const steps = new Map(def.steps.map((s) => [s.step_id, s]));
    for (const e of this.events) {
      const p = payloadOf(e);
      if (e.kind === "record.versioned") this.versionLog.push({ seq: e.seq, kind: String(p["record_kind"]), version: Number(p["version"]) });
      const sid = stepOf(e);
      const s = sid === null ? undefined : steps.get(sid);
      if (!s || !isPreparingStep(s)) continue;
      if (e.kind === "step.started" || e.kind === "document.revised") {
        const list = this.captures.get(s.step_id) ?? [];
        list.push({ seq: e.seq, captured: this.versionsAt(e.seq, boundRecordKinds(def, s)) });
        this.captures.set(s.step_id, list);
      }
    }
  }

  // Record versions in force just after the event with this seq.
  versionsAt(seq: number, kinds: readonly string[]): Record<string, number> {
    const out: Record<string, number> = Object.fromEntries(kinds.map((k) => [k, 0]));
    for (const v of this.versionLog) if (v.seq <= seq && v.kind in out) out[v.kind] = v.version;
    return out;
  }

  // The versions a prepared stage cited as of this seq, or null if it had not started.
  capturedAt(prepStepId: string, seq: number): Record<string, number> | null {
    const list = (this.captures.get(prepStepId) ?? []).filter((c) => c.seq <= seq);
    return list.at(-1)?.captured ?? null;
  }

  ofStep(stepId: string, kind: string): SimEvent[] {
    return this.events.filter((e) => e.kind === kind && stepOf(e) === stepId);
  }

  completion(stepId: string): SimEvent | undefined {
    return this.ofStep(stepId, "step.completed")[0];
  }

  // The preparing step behind a citing step such as a check or a handover.
  preparerOf(s: Step): Step | undefined {
    const ref = s.document_ref;
    if (!ref || isPreparingStep(s)) return undefined;
    return this.def.steps.find((x) => isPreparingStep(x) && x.document_ref!.document_id === ref.document_id && x.document_ref!.stage === ref.stage);
  }
}
