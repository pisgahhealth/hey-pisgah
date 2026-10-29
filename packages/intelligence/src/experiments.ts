import type { CaseFile } from "@hey-pisgah/cases";
import { Metric, definitionHash, hashJson, type Operation, type RunResult, type SimEvent, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { worldRules } from "@hey-pisgah/hospital";
import { behaviourNote, effectiveParams, externalSubLogHash, rulesHashFor, runDefinition, scheduleHash, type WorldRules } from "@hey-pisgah/simulator";
import { applyOperations, deriveDataIntegrityFences, type Facts } from "@hey-pisgah/workflow";
import { firstDivergence, rulesChanged, targetRow, type Divergence, type ExpectedChange, type TargetRow } from "./delivery.js";
import type { Deltas } from "./prediction.js";

export type Runner = typeof runDefinition;
export type MatchedOptions = { caseFacts: readonly Facts[]; world?: WorldRules; runner?: Runner; experimentId: string; expected?: ExpectedChange };
// What an experiment proves it changed: the rules edited, the named behaviour per case in both arms, and where the logs first part.
export type Receipt = { rules_changed: Record<string, unknown>; expected_change: ExpectedChange | null; target: TargetRow[]; delivered_cases: number; first_divergence: { case_id: string; first: Divergence }[] };

type Ok = Extract<RunResult, { outcome: "ok" }>;
export type ArmView = Record<string, unknown>;
export type CaseResult = {
  case_id: string;
  control: ArmView;
  intervention: ArmView;
  delta: Partial<Record<Metric, number | null>>;
  step_time_diffs: { step: string; control: [number | null, number | null]; intervention: [number | null, number | null] }[];
  action_diff: { key: string; control: number; intervention: number }[];
  event_logs_identical: boolean;
};
// What still gates one step the operations touched, read from the changed definition: data for the reader, never a verdict.
export type Gating = {
  step: string;
  required_when: unknown;
  start_edges: { edge_id: string; from: string; kind: string }[];
  complete_edges: { edge_id: string; from: string; kind: string }[];
  derived_complete_gates: { from: string }[];
  triggers: { when: unknown; condition: unknown }[];
};
export type Behaviour = { event_logs_identical_to_control: string; identical_cases: string[]; changed_cases: string[]; note: string | null; gating: Gating[] | null };
export type Matched =
  | { ok: false; stage: "static" | "schedule_hash"; errors: string[] }
  | { ok: true; aborted: { case_id: string; reason: string } | null; base_hash: string; intervention_hash: string; warnings: string[]; noop: boolean; cases: CaseResult[]; deltas: Deltas; behaviour: Behaviour | null; receipt: Receipt | null };

const METRICS = Metric.options;

function armView(r: Ok): ArmView {
  const m = r.metrics;
  return { ...Object.fromEntries(METRICS.map((k) => [k, m[k]])), terminal_state: m.terminal_state, agent_actions: m.agent_actions, staff_min_by_role: m.staff_min_by_role };
}

function actionCounts(events: readonly SimEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    if (!["step.completed", "document.revised", "check.repeated", "check.verified", "step.held", "action.refused"].includes(e.kind)) continue;
    const k = `${e.kind} ${e.subject ?? "-"}`;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

function compare(c: Ok, i: Ok, caseId: string): CaseResult {
  const delta: CaseResult["delta"] = {};
  for (const k of METRICS) {
    const a = c.metrics[k], b = i.metrics[k];
    delta[k] = a === null || b === null ? null : b - a;
  }
  const steps = [...new Set([...Object.keys(c.step_times), ...Object.keys(i.step_times)])].sort();
  const diffs: CaseResult["step_time_diffs"] = [];
  for (const s of steps) {
    const a = c.step_times[s], b = i.step_times[s];
    const ca: [number | null, number | null] = [a?.started_occ ?? null, a?.completed_occ ?? null];
    const ib: [number | null, number | null] = [b?.started_occ ?? null, b?.completed_occ ?? null];
    if (ca[0] !== ib[0] || ca[1] !== ib[1]) diffs.push({ step: s, control: ca, intervention: ib });
  }
  const ac = actionCounts(c.events), ai = actionCounts(i.events);
  const keys = [...new Set([...ac.keys(), ...ai.keys()])].sort();
  const action_diff = keys.filter((k) => (ac.get(k) ?? 0) !== (ai.get(k) ?? 0)).map((k) => ({ key: k, control: ac.get(k) ?? 0, intervention: ai.get(k) ?? 0 }));
  return { case_id: caseId, control: armView(c), intervention: armView(i), delta, step_time_diffs: diffs, action_diff, event_logs_identical: false };
}

// The steps each operation names as its target, in the definition the operation applies to.
export function targetedSteps(base: WD, ops: readonly Operation[]): string[] {
  const out = new Set<string>();
  for (const op of ops) {
    if (op.op === "remove_soft_edge") { const e = base.edges.find((x) => x.edge_id === op.edge_id); if (e) out.add(e.to.step); }
    if (op.op === "add_soft_edge") out.add(op.to.step);
    if (op.op === "move_step_after") out.add(op.step.step);
    if (op.op === "set_prep_trigger") out.add(op.target.step);
    if (op.op === "add_condition" && op.target !== "scope") out.add("step" in op.target ? op.target.step.step : op.target.trigger.step);
    if (op.op === "rebind_section") for (const st of base.steps) if (st.document_ref?.document_id === op.document_id) out.add(st.step_id);
  }
  return [...out].sort();
}

// Every edge, derived gate and trigger that holds back each step in a definition.
export function gatingOf(def: WD, steps: readonly string[]): Gating[] {
  const derived = deriveDataIntegrityFences(def);
  return steps.map((id) => ({
    step: id,
    required_when: def.steps.find((s) => s.step_id === id)?.required_when ?? null,
    start_edges: def.edges.filter((e) => e.to.step === id && e.gate === "start").map((e) => ({ edge_id: e.edge_id, from: e.from.step, kind: e.kind })),
    complete_edges: def.edges.filter((e) => e.to.step === id && e.gate === "complete").map((e) => ({ edge_id: e.edge_id, from: e.from.step, kind: e.kind })),
    derived_complete_gates: derived.filter((e) => e.to.step === id).map((e) => ({ from: e.from.step })),
    triggers: def.triggers.filter((t) => t.target.step === id).map((t) => ({ when: t.when, condition: t.condition }))
  }));
}

// Runs control and intervention on each case's frozen schedule with the world rules; any sub-log or hash mismatch aborts the experiment.
export function runMatched(base: WD, ops: readonly Operation[], files: readonly CaseFile[], o: MatchedOptions): Matched {
  const applied = applyOperations(base, ops, { caseFacts: o.caseFacts });
  if (!applied.ok) return { ok: false, stage: "static", errors: applied.errors.map((e) => `${e.code}: ${e.message}`) };
  for (const f of files) if (scheduleHash(f.schedule) !== f.schedule_hash) return { ok: false, stage: "schedule_hash", errors: [`schedule hash changed for ${f.case_id}`] };
  const world = o.world ?? worldRules();
  const runner = o.runner ?? runDefinition;
  const def = applied.definition;
  const cases: CaseResult[] = [];
  const deltas: Deltas = {};
  const pairs: { c: Ok; i: Ok }[] = [];
  let aborted: { case_id: string; reason: string } | null = null;
  for (const f of files) {
    const runId = `run-${hashJson({ experiment: o.experimentId, case_id: f.case_id }).slice(0, 8)}`;
    const c = runner(base, f.schedule, { world, run_id: runId });
    const i = runner(def, f.schedule, { world, run_id: runId });
    const expected = hashJson({ sim: rulesHashFor(effectiveParams(f.schedule.params)), world: world.rules_hash });
    if (c.outcome !== "ok" || i.outcome !== "ok") { aborted = { case_id: f.case_id, reason: "a run stopped on an invariant violation" }; break; }
    if (c.rules_hash !== expected || i.rules_hash !== expected) { aborted = { case_id: f.case_id, reason: "rules hash differs from the world rules" }; break; }
    if (c.schedule_hash !== f.schedule_hash || i.schedule_hash !== f.schedule_hash) { aborted = { case_id: f.case_id, reason: "schedule hash differs between the arms" }; break; }
    if (externalSubLogHash(c.events) !== externalSubLogHash(i.events)) { aborted = { case_id: f.case_id, reason: "external sub-log differs between the arms" }; break; }
    const r = compare(c, i, f.case_id);
    pairs.push({ c, i });
    cases.push(r);
    deltas[f.case_id] = r.delta;
  }
  let behaviour: Behaviour | null = null;
  let receipt: Receipt | null = null;
  if (!aborted) {
    const target = o.expected ? pairs.map((x, k) => targetRow(cases[k]!.case_id, x.c, x.i, o.expected!)) : [];
    receipt = { rules_changed: rulesChanged(base, def), expected_change: o.expected ?? null, target, delivered_cases: target.filter((t) => t.moved).length, first_divergence: pairs.map((x, k) => ({ case_id: cases[k]!.case_id, first: firstDivergence(x.c.events, x.i.events) })) };
    const b = behaviourNote(pairs.map((x) => x.c), pairs.map((x) => x.i));
    cases.forEach((r, k) => { r.event_logs_identical = b.identical[k] ?? false; });
    const same = cases.filter((r) => r.event_logs_identical).map((r) => r.case_id);
    behaviour = { event_logs_identical_to_control: `${same.length} of ${cases.length} cases`, identical_cases: same, changed_cases: cases.filter((r) => !r.event_logs_identical).map((r) => r.case_id), note: b.note, gating: same.length ? gatingOf(def, targetedSteps(base, ops)) : null };
  }
  return { ok: true, aborted, base_hash: definitionHash(base), intervention_hash: definitionHash(def), warnings: applied.warnings.map((w) => w.message), noop: applied.noop, cases: aborted ? [] : cases, deltas: aborted ? {} : deltas, behaviour, receipt };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const y = [...xs].sort((a, b) => a - b);
  const m = Math.floor(y.length / 2);
  return y.length % 2 ? y[m]! : (y[m - 1]! + y[m]!) / 2;
};

// Median delta per metric over the cases that observed it.
export function summarise(cases: readonly CaseResult[]): Record<string, number | null> {
  return Object.fromEntries(METRICS.map((k) => [k, median(cases.flatMap((c) => (c.delta[k] === null || c.delta[k] === undefined ? [] : [c.delta[k]!])))]));
}
