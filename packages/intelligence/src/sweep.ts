import { FACT_VALUES, canonical, type ConditionExpr, type Operation, type RunResult, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import type { CaseFile } from "@hey-pisgah/cases";
import { worldRules } from "@hey-pisgah/hospital";
import { runDefinition, type WorldRules } from "@hey-pisgah/simulator";
import { applyOperations, isPreparingStep, type Facts } from "@hey-pisgah/workflow";
import { targetedSteps } from "./experiments.js";
import { isStaticNoop, ruleChanges } from "./preconditions.js";

export const OP_KINDS = ["remove_soft_edge", "add_soft_edge", "move_step_after", "set_prep_trigger", "add_condition", "rebind_section"] as const;
export type OpKind = (typeof OP_KINDS)[number];

// The sweep's scope rule, stated over any definition: it names no step, edge or document.
export const SWEEP_RULE = [
  "scope steps: both steps of each of the top_k critical segments in the derived statistics, or the target_steps given",
  "remove_soft_edge: every soft edge whose source or target is a scope step",
  "add_soft_edge and move_step_after: a non-external preparing scope step as the target, every other step as the source, gate start and complete",
  "set_prep_trigger: a non-external preparing scope step as the target, after every other step",
  "add_condition: on the requirement and on the triggers of a non-external preparing scope step, one eq atom per fact value",
  "rebind_section: every section of a document a preparing scope step prepares, to every record kind some step produces",
  "every single operation of the named kinds, then every pair of them, on the same recorded cases and the same seeds; a cell the definition rules refuse is skipped, and a cell the static test calls a no-op is not run"
] as const;
export const SWEEP_LIMITS = { singles: 60, cases: 6, sweeps: 3, rows: 20 } as const;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// The single operations of the named kinds that touch the scope steps, in a fixed order.
export function scopedOperations(def: WD, scope: ReadonlySet<string>, kinds: readonly OpKind[], wards: readonly string[]): Operation[] {
  const steps = [...def.steps].sort((a, b) => cmp(a.step_id, b.step_id));
  const targets = steps.filter((s) => !s.external && isPreparingStep(s) && scope.has(s.step_id));
  const want = new Set(kinds);
  const out: Operation[] = [];
  if (want.has("remove_soft_edge")) for (const e of [...def.edges].filter((x) => x.kind === "soft" && (scope.has(x.from.step) || scope.has(x.to.step))).sort((a, b) => cmp(a.edge_id, b.edge_id))) out.push({ op: "remove_soft_edge", edge_id: e.edge_id });
  for (const kind of ["add_soft_edge", "move_step_after"] as const) {
    if (!want.has(kind)) continue;
    for (const t of targets) for (const s of steps) if (s.step_id !== t.step_id) for (const gate of ["start", "complete"] as const) out.push(kind === "add_soft_edge" ? { op: kind, from: { step: s.step_id }, to: { step: t.step_id }, gate } : { op: kind, step: { step: t.step_id }, after: { step: s.step_id }, gate });
  }
  if (want.has("set_prep_trigger")) for (const t of targets) for (const s of steps) if (s.step_id !== t.step_id) out.push({ op: "set_prep_trigger", target: { step: t.step_id }, when: { after: { step: s.step_id } } });
  if (want.has("add_condition")) {
    const atoms: ConditionExpr[] = [];
    for (const [fact, values] of Object.entries(FACT_VALUES).sort(([a], [b]) => cmp(a, b))) for (const v of Array.isArray(values) ? values : [...wards].sort()) atoms.push({ fact, eq: v } as ConditionExpr);
    for (const t of targets) {
      const tg = [{ step: { step: t.step_id } }, ...(def.triggers.some((x) => x.target.step === t.step_id) ? [{ trigger: { step: t.step_id } }] : [])];
      for (const target of tg) for (const condition of atoms) out.push({ op: "add_condition", target, condition } as Operation);
    }
  }
  if (want.has("rebind_section")) {
    const produced = [...new Set(steps.flatMap((s) => s.produces))].sort();
    for (const d of [...new Set(targets.map((t) => t.document_ref!.document_id))].sort()) {
      for (const sec of def.documents.find((x) => x.document_id === d)!.sections) for (const rk of produced) if (rk !== sec.binding.record_kind) out.push({ op: "rebind_section", document_id: d, section_id: sec.section_id, source: { record_kind: rk, field_path: sec.binding.field_path, version_policy: "current" } });
    }
  }
  return out;
}

type Ok = Extract<RunResult, { outcome: "ok" }>;
export type SweepCell = { ops: Operation[]; size: number; static_noop: boolean; delivered: boolean; median_wait_delta: number | null; sum_wait_delta: number; cases_better: number; cases_worse: number; shifted_steps: string[]; per_case: (number | null)[] };
export type SweepOutput = { cells: SweepCell[]; singles: number; pairs: number; invalid: number; static_noops: number; simulations: number };

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const y = [...xs].sort((a, b) => a - b);
  const m = Math.floor(y.length / 2);
  return y.length % 2 ? y[m]! : (y[m - 1]! + y[m]!) / 2;
};

// Runs one cell on matched cases against cached controls: the wait deltas, which steps' starts moved, and whether a targeted step moved.
export function evaluateCell(base: WD, ops: readonly Operation[], files: readonly CaseFile[], controls: readonly Ok[], o: { caseFacts: readonly Facts[]; world: WorldRules }): SweepCell | null {
  const r = applyOperations(base, ops, { caseFacts: o.caseFacts });
  if (!r.ok) return null;
  const size = ops.length;
  if (r.noop || isStaticNoop(ruleChanges(base, r.definition), canonical(base.scope) !== canonical(r.definition.scope))) return { ops: [...ops], size, static_noop: true, delivered: false, median_wait_delta: 0, sum_wait_delta: 0, cases_better: 0, cases_worse: 0, shifted_steps: [], per_case: files.map(() => 0) };
  const targets = new Set(targetedSteps(base, ops));
  const deltas: number[] = [];
  const perCase: (number | null)[] = [];
  const shifted = new Set<string>();
  let delivered = false;
  files.forEach((f, k) => {
    const c = controls[k]!;
    const i = runDefinition(r.definition, f.schedule, { world: o.world, run_id: c.run_id }) as RunResult;
    if (i.outcome !== "ok") { perCase.push(null); return; }
    const a = c.metrics.post_signoff_wait_min, b = i.metrics.post_signoff_wait_min;
    perCase.push(a !== null && b !== null ? b - a : null);
    if (a !== null && b !== null) deltas.push(b - a);
    for (const [s, t] of Object.entries(i.step_times)) {
      const u = c.step_times[s];
      if ((u?.started_occ ?? null) !== (t.started_occ ?? null) || (u?.completed_occ ?? null) !== (t.completed_occ ?? null)) { shifted.add(s); if (targets.has(s)) delivered = true; }
    }
  });
  return { ops: [...ops], size, static_noop: false, delivered, median_wait_delta: median(deltas), sum_wait_delta: deltas.reduce((x, y) => x + y, 0), cases_better: deltas.filter((d) => d < 0).length, cases_worse: deltas.filter((d) => d > 0).length, shifted_steps: [...shifted].sort(), per_case: perCase };
}

// Every single operation in the list and every pair of them, each alike, on the same cases.
export function sweep(base: WD, singles: readonly Operation[], files: readonly CaseFile[], o: { caseFacts: readonly Facts[]; world?: WorldRules; pairs?: boolean }): SweepOutput {
  const world = o.world ?? worldRules();
  const controls = files.map((f, k) => runDefinition(base, f.schedule, { world, run_id: `run-${String(k).padStart(4, "0")}5eed` }) as Ok);
  const cells: SweepCell[] = [];
  let invalid = 0;
  let simulations = files.length;
  const add = (ops: Operation[]) => {
    const c = evaluateCell(base, ops, files, controls, { caseFacts: o.caseFacts, world });
    if (!c) { invalid += 1; return; }
    if (!c.static_noop) simulations += files.length;
    cells.push(c);
  };
  for (const op of singles) add([op]);
  let pairs = 0;
  if (o.pairs !== false) for (let i = 0; i < singles.length; i++) for (let j = i + 1; j < singles.length; j++) { pairs += 1; add([singles[i]!, singles[j]!]); }
  return { cells, singles: singles.length, pairs, invalid, static_noops: cells.filter((c) => c.static_noop).length, simulations };
}

// The model's view of a sweep: counts, the best cells by summed wait delta, and the delivered cells whose outcome did not move.
export function sweepView(out: SweepOutput, scope: readonly string[]): Record<string, unknown> {
  const row = (c: SweepCell) => ({ ops: c.ops, delivered: c.delivered, median_wait_delta: c.median_wait_delta, sum_wait_delta: c.sum_wait_delta, cases_better: c.cases_better, cases_worse: c.cases_worse, shifted_steps: c.shifted_steps.slice(0, 8) });
  const ran = out.cells.filter((c) => !c.static_noop);
  const best = [...ran].sort((a, b) => a.sum_wait_delta - b.sum_wait_delta || a.size - b.size).slice(0, SWEEP_LIMITS.rows);
  return {
    scope_steps: scope, singles: out.singles, pairs: out.pairs, cells_refused_by_rules: out.invalid, cells_static_noop: out.static_noops, cells_run: ran.length,
    cells_delivered: ran.filter((c) => c.delivered).length, cells_better: ran.filter((c) => c.sum_wait_delta < 0).length, cells_worse: ran.filter((c) => c.sum_wait_delta > 0).length, simulations: out.simulations,
    best_by_wait: best.map(row),
    delivered_outcome_unchanged: ran.filter((c) => c.delivered && c.sum_wait_delta === 0).slice(0, 10).map(row)
  };
}
