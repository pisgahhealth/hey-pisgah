import { canonical, type HypothesisRecord as HR, type Operation, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { isPreparingStep, type Facts } from "@hey-pisgah/workflow";
import { targetedSteps } from "./experiments.js";
import { checkBefore, pairDiagnostics } from "./prediction.js";
import { isStaticNoop, ruleChanges } from "./preconditions.js";

export type LintCode = "no_op" | "no_discrimination" | "already_run" | "unknown_step" | "not_preparable";

// Operations whose target step exists but is not a non-external preparing step, which no operation may target.
export function nonPreparableTargets(base: WD, ops: readonly Operation[]): { op_index: number; step: string }[] {
  const out: { op_index: number; step: string }[] = [];
  ops.forEach((op, i) => {
    const step = op.op === "set_prep_trigger" ? op.target.step : op.op === "add_soft_edge" ? op.to.step : op.op === "move_step_after" ? op.step.step : op.op === "add_condition" && op.target !== "scope" && "step" in op.target ? op.target.step.step : null;
    const s = step ? base.steps.find((x) => x.step_id === step) : undefined;
    if (s && (s.external || !isPreparingStep(s))) out.push({ op_index: i, step: s.step_id });
  });
  return out;
}
export type LintResult = { ok: boolean; reasons: LintCode[]; detail: Record<string, unknown> };
export type PriorRun = { experiment_id: string; intervention_hash: string; base_hash: string; case_ids: readonly string[] };

// The deterministic pre-run checks: the change can reach the engine, it tells two cited hypotheses apart on these cases, and it was not run before.
export function lintExperiment(o: { base: WD; next: WD; ops: readonly Operation[]; caseIds: readonly string[]; cited: readonly HR[]; previous: readonly PriorRun[]; factsOf: (id: string) => Facts | null; expectedStep: string; nextHash: string; baseHash: string }): LintResult {
  const reasons: LintCode[] = [];
  const detail: Record<string, unknown> = {};
  const all = ruleChanges(o.base, o.next);
  const scopeChanged = canonical(o.base.scope) !== canonical(o.next.scope);
  const touched = new Set([...targetedSteps(o.base, o.ops), o.expectedStep]);
  detail.rules = all.filter((c) => touched.has(c.step)).map((c) => ({ step: c.step, start_before: c.start_before, start_after: c.start_after, start_equivalent: c.start_equivalent, complete_before: c.complete_before, complete_after: c.complete_after, complete_equivalent: c.complete_equivalent, bindings_changed: c.bindings_changed }));
  if (!o.base.steps.some((s) => s.step_id === o.expectedStep)) reasons.push("unknown_step");
  if (o.nextHash === o.baseHash || isStaticNoop(all, scopeChanged)) reasons.push("no_op");
  const named = all.find((c) => c.step === o.expectedStep);
  detail.named_step_rule_changed = named ? !(named.start_equivalent === true && named.complete_equivalent === true && !named.bindings_changed) : false;
  const pairs = checkBefore(o.cited, o.caseIds, o.factsOf).distinguishes;
  detail.distinguishes = pairs;
  if (pairs.length === 0) {
    reasons.push("no_discrimination");
    detail.pairs = pairDiagnostics(o.cited, o.caseIds, o.factsOf);
  }
  const sameCases = (a: readonly string[]) => canonical([...a].sort()) === canonical([...o.caseIds].sort());
  const hit = o.previous.find((p) => p.intervention_hash === o.nextHash && p.base_hash === o.baseHash && sameCases(p.case_ids));
  if (hit) { reasons.push("already_run"); detail.already_run = hit.experiment_id; }
  return { ok: reasons.length === 0, reasons, detail };
}
