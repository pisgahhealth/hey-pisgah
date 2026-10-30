import type { ConditionExpr, EventPredicate, WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { boundRecordKinds, deriveDataIntegrityFences } from "@hey-pisgah/workflow";

// A start or completion rule as a formula over atoms: a step being done (or not required), an event seen, a condition holding.
export type Formula = { t: "and" | "or"; xs: Formula[] } | { t: "atom"; k: string } | { t: "true" };

const T: Formula = { t: "true" };
const atom = (k: string): Formula => ({ t: "atom", k });
const and = (all: Formula[]): Formula => { const xs = all.filter((x) => x.t !== "true"); return xs.length === 0 ? T : xs.length === 1 ? xs[0]! : { t: "and", xs }; };
const or = (xs: Formula[]): Formula => (xs.some((x) => x.t === "true") ? T : xs.length === 1 ? xs[0]! : { t: "or", xs });

// An after predicate reads a step's state; an on predicate reads the event log, so the two stay separate atoms.
function predicate(p: EventPredicate): Formula {
  if ("after" in p) return atom(`done ${p.after.step}`);
  if ("on" in p) {
    const where = p.where ?? {};
    const keys = Object.keys(where).sort();
    return atom(`seen ${p.on} ${JSON.stringify(Object.fromEntries(keys.map((k) => [k, where[k]])))}`);
  }
  return "all_of" in p ? and(p.all_of.map(predicate)) : or(p.any_of.map(predicate));
}

const cond = (c: ConditionExpr | null): Formula => (c === null ? T : atom(`holds ${JSON.stringify(c)}`));

// The executor's start rule for one step: required, every start edge's source done, and one trigger fired when the step has any.
export function startRule(def: WD, step: string): Formula {
  const s = def.steps.find((x) => x.step_id === step);
  if (!s) return T;
  const edges = [...new Set(def.edges.filter((e) => e.to.step === step && e.gate === "start").map((e) => e.from.step))].sort();
  const trig = def.triggers.filter((t) => t.target.step === step).map((t) => and([predicate(t.when), cond(t.condition)]));
  return and([cond(s.required_when), ...edges.map((f) => atom(`done ${f}`)), ...(trig.length ? [or(trig)] : [])]);
}

// The executor's completion rule for one step: every complete edge's source and every derived gate's source done.
export function completeRule(def: WD, step: string): Formula {
  const from = [...def.edges.filter((e) => e.to.step === step && e.gate === "complete").map((e) => e.from.step), ...deriveDataIntegrityFences(def).filter((e) => e.to.step === step).map((e) => e.from.step)];
  return and([...new Set(from)].sort().map((f) => atom(`done ${f}`)));
}

function atoms(f: Formula, out = new Set<string>()): Set<string> {
  if (f.t === "atom") out.add(f.k);
  if (f.t === "and" || f.t === "or") for (const x of f.xs) atoms(x, out);
  return out;
}

function evalF(f: Formula, v: Map<string, boolean>): boolean {
  if (f.t === "true") return true;
  if (f.t === "atom") return v.get(f.k)!;
  return f.t === "and" ? f.xs.every((x) => evalF(x, v)) : f.xs.some((x) => evalF(x, v));
}

export function render(f: Formula): string {
  if (f.t === "true") return "always";
  if (f.t === "atom") return f.k;
  return `(${f.xs.map(render).join(f.t === "and" ? " and " : " or ")})`;
}

// Steps that are done whenever a step is done, through start edges both definitions share.
function implications(a: WD, b: WD): Map<string, Set<string>> {
  const key = (e: WD["edges"][number]) => `${e.from.step}>${e.to.step}>${e.gate}`;
  const inB = new Set(b.edges.map(key));
  const direct = new Map<string, Set<string>>();
  for (const e of a.edges) if (e.gate === "start" && inB.has(key(e))) { const s = direct.get(e.to.step) ?? new Set<string>(); s.add(e.from.step); direct.set(e.to.step, s); }
  const out = new Map<string, Set<string>>();
  for (const s of direct.keys()) {
    const seen = new Set<string>();
    const stack = [...direct.get(s)!];
    while (stack.length) { const x = stack.pop()!; if (seen.has(x)) continue; seen.add(x); stack.push(...(direct.get(x) ?? [])); }
    out.set(s, seen);
  }
  return out;
}

// Two rules are equivalent when they agree on every consistent assignment of their atoms; null when there are too many atoms to check.
export function equivalent(f: Formula, g: Formula, implied: Map<string, Set<string>> = new Map()): boolean | null {
  const names = [...new Set([...atoms(f), ...atoms(g)])].sort();
  if (names.length > 14) return null;
  for (let m = 0; m < 1 << names.length; m++) {
    const v = new Map(names.map((n, i) => [n, ((m >> i) & 1) === 1]));
    const consistent = names.every((n) => !n.startsWith("done ") || !v.get(n) || [...(implied.get(n.slice(5)) ?? [])].every((p) => !v.has(`done ${p}`) || v.get(`done ${p}`)));
    if (consistent && evalF(f, v) !== evalF(g, v)) return false;
  }
  return true;
}

export type StepRuleChange = { step: string; start_before: string; start_after: string; complete_before: string; complete_after: string; bindings_changed: boolean; start_equivalent: boolean | null; complete_equivalent: boolean | null };

// For each step, whether the change leaves its start rule, completion rule and bound records equivalent; the linter's no-op test.
export function ruleChanges(base: WD, next: WD, steps: readonly string[] = base.steps.map((s) => s.step_id)): StepRuleChange[] {
  const implied = implications(base, next);
  return steps.map((step) => {
    const sb = startRule(base, step), sa = startRule(next, step), cb = completeRule(base, step), ca = completeRule(next, step);
    const bb = JSON.stringify(boundRecordKinds(base, base.steps.find((s) => s.step_id === step)!));
    const ba = JSON.stringify(boundRecordKinds(next, next.steps.find((s) => s.step_id === step)!));
    return { step, start_before: render(sb), start_after: render(sa), complete_before: render(cb), complete_after: render(ca), bindings_changed: bb !== ba, start_equivalent: equivalent(sb, sa, implied), complete_equivalent: equivalent(cb, ca, implied) };
  });
}

// True when no step's start rule, completion rule or bound records change in any way the engine can act on.
export function isStaticNoop(changes: readonly StepRuleChange[], scopeChanged: boolean): boolean {
  return !scopeChanged && changes.every((c) => c.start_equivalent === true && c.complete_equivalent === true && !c.bindings_changed);
}

// The engine's rules each operation can touch, as one row per operation kind; the same text for every definition.
export const ENGINE_RULES = {
  start: "A step starts when it is required, the source of every start edge into it is done or not required, and, if it has triggers, one trigger has fired (its when predicate holds and its condition is true).",
  complete: "A prepared step completes when the source of every complete edge into it and of every derived data gate is done or not required, and its bound records are current.",
  trigger: "A trigger fires once and stays fired; an after predicate holds when its step is done or not required; an on predicate holds once a matching event has been emitted."
} as const;

export const PRECONDITION_TABLE = [
  { op: "remove_soft_edge", changes: "the start edges or complete edges of the edge's target", has_effect_only_if: "the target's start rule (or completion rule, for a complete edge) is no longer equivalent once the edge is gone: no other start edge, and not every trigger, of the target still waits on the same source or on a step that is done only after it", rule: "start" },
  { op: "add_soft_edge", changes: "the start edges or complete edges of the target", has_effect_only_if: "the new source is not already implied by the target's rule and is done after the target would otherwise start or complete", rule: "start" },
  { op: "move_step_after", changes: "replaces every incoming soft edge of the moved step with one edge from the named step", has_effect_only_if: "the moved step's start rule changes after the replacement; its triggers are untouched, so a trigger that still waits on the old source keeps the old start", rule: "start" },
  { op: "set_prep_trigger", changes: "replaces every trigger of the target with one trigger on the new predicate, keeping the first trigger's condition", has_effect_only_if: "the target's start rule changes: no start edge into the target still waits on the old trigger's step or on a later one, and the new predicate holds at a different minute", rule: "trigger" },
  { op: "add_condition", changes: "the target step's required_when, every trigger condition on the target, or the scope condition", has_effect_only_if: "the condition is false for some case at the minute the engine reads it; a condition true for every case changes nothing", rule: "start" },
  { op: "rebind_section", changes: "one section binding of a document, and so the derived data gates of the steps that prepare it", has_effect_only_if: "the new record kind is produced at a different minute than the old one, so the derived completion gate or the stale-record revision moves", rule: "complete" }
] as const;

export function preconditionTable(): Record<string, unknown> {
  return { engine_rules: ENGINE_RULES, operations: PRECONDITION_TABLE, method: "Each row lists the rule an operation edits and when that edit can reach the engine; run_experiment applies the same test to a request before it runs and refuses one that leaves every rule equivalent." };
}
