import type { RunResult, SimEvent, WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { z } from "zod";

type Ok = Extract<RunResult, { outcome: "ok" }>;

// The behaviour an experiment names before it runs: one step's start minute, whether it runs at all, or its place in the order of step starts.
export const ExpectedChange = z.strictObject({ step: z.string().min(1).max(12), behaviour: z.enum(["start_time", "eligibility", "event_order"]) });
export type ExpectedChange = z.infer<typeof ExpectedChange>;

export type TargetView = { started: number | null; completed: number | null; ran: boolean; order: number | null };
export type TargetRow = { case_id: string; control: TargetView; intervention: TargetView; moved: boolean };
export type Divergence = { index: number; control: string | null; intervention: string | null } | null;

const line = (e: SimEvent | undefined): string | null => (e ? `${e.kind} ${e.subject ?? "-"} at ${e.occurred_at}` : null);

function view(r: Ok, step: string): TargetView {
  const t = r.step_times[step];
  const starts = r.events.filter((e) => e.kind === "step.started");
  const i = starts.findIndex((e) => e.subject === step);
  return { started: t?.started_occ ?? null, completed: t?.completed_occ ?? null, ran: (t?.started_occ ?? null) !== null, order: i >= 0 ? i + 1 : null };
}

// Whether the named behaviour moved between the two arms of one case.
export function moved(c: TargetView, i: TargetView, behaviour: ExpectedChange["behaviour"]): boolean {
  if (behaviour === "start_time") return c.started !== i.started;
  if (behaviour === "eligibility") return c.ran !== i.ran;
  return c.order !== i.order;
}

export function targetRow(caseId: string, c: Ok, i: Ok, x: ExpectedChange): TargetRow {
  const a = view(c, x.step), b = view(i, x.step);
  return { case_id: caseId, control: a, intervention: b, moved: moved(a, b, x.behaviour) };
}

// The first event where the two arms' logs differ in kind, subject or minute.
export function firstDivergence(c: readonly SimEvent[], i: readonly SimEvent[]): Divergence {
  const n = Math.max(c.length, i.length);
  for (let k = 0; k < n; k++) {
    const a = c[k], b = i[k];
    if (!a || !b || a.kind !== b.kind || a.subject !== b.subject || a.occurred_at !== b.occurred_at) return { index: k + 1, control: line(a), intervention: line(b) };
  }
  return null;
}

// The rules the change edits, read from the two definitions: edges added and removed, and each changed trigger set, requirement or binding.
export function rulesChanged(base: WD, next: WD): Record<string, unknown> {
  const ek = (e: WD["edges"][number]) => `${e.edge_id} ${e.from.step}>${e.to.step} ${e.gate} ${e.kind}`;
  const before = new Set(base.edges.map(ek)), after = new Set(next.edges.map(ek));
  const trig = (d: WD, s: string) => JSON.stringify(d.triggers.filter((t) => t.target.step === s).map((t) => ({ when: t.when, condition: t.condition })));
  const steps = base.steps.map((s) => s.step_id);
  const binds = (d: WD) => JSON.stringify(d.documents.map((x) => x.sections.map((s) => s.binding)));
  return {
    edges_removed: [...before].filter((e) => !after.has(e)),
    edges_added: [...after].filter((e) => !before.has(e)),
    triggers_changed: steps.filter((s) => trig(base, s) !== trig(next, s)).map((s) => ({ step: s, before: JSON.parse(trig(base, s)), after: JSON.parse(trig(next, s)) })),
    requirements_changed: steps.filter((s) => JSON.stringify(base.steps.find((x) => x.step_id === s)!.required_when) !== JSON.stringify(next.steps.find((x) => x.step_id === s)!.required_when)),
    bindings_changed: binds(base) !== binds(next),
    scope_changed: JSON.stringify(base.scope) !== JSON.stringify(next.scope)
  };
}

// The four outcomes of one experiment: rejected before running, run but not delivered, delivered with the outcome unchanged or worse, delivered and better.
export type OutcomeClass = "rejected" | "not_delivered" | "delivered_outcome_unchanged" | "delivered_outcome_worse" | "delivered_outcome_better";

// The outcome is read on the cases where the target behaviour moved: the sum of their wait deltas.
export function outcomeClass(delivered: boolean, movedWaitDeltas: readonly (number | null)[]): OutcomeClass {
  if (!delivered) return "not_delivered";
  const sum = movedWaitDeltas.reduce<number>((a, d) => a + (d ?? 0), 0);
  if (sum === 0) return "delivered_outcome_unchanged";
  return sum < 0 ? "delivered_outcome_better" : "delivered_outcome_worse";
}

// Only a delivered experiment may support or count against a hypothesis.
export const mayUpdate = (c: OutcomeClass): boolean => c.startsWith("delivered_");
