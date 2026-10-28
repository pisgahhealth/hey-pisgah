import {
  CONDITION_MAX_ATOMS, OPS_PER_REQUEST_MAX, Operation, PREDICATE_MAX_DEPTH, PREDICATE_MAX_LEAVES, SOFT_EDGE_NOTE, WorkflowDefinition,
  countAtoms, definitionHash, fencesHash, permissionsHash, predicateShape, structureHash,
  type ConditionExpr, type DerivedEdge, type Edge, type EventPredicate, type RecordKind, type Step, type StepRef, type Trigger,
  type WorkflowDefinition as WD
} from "@hey-pisgah/contracts";
import { andCondition, evalCondition, type Facts } from "./conditions.js";
import { SIM_EVENT_KIND_SET } from "./events.js";
import { allPrecedences, deriveDataIntegrityFences, findCycle, isPreparingStep } from "./graph.js";

export type IssueCode =
  | "schema" | "too_many_ops" | "unknown_id" | "bad_target" | "fence_changed" | "permissions_changed" | "structure_changed"
  | "cycle" | "grammar_cap" | "single_case_condition" | "invalid_definition" | "no_op";
export type Issue = { code: IssueCode; op_index: number | null; message: string };

export type ApplyOptions = {
  // Facts of the cases in the pool the request draws from; when given, a condition true for exactly one of them is refused.
  caseFacts?: readonly Facts[];
  // Lifts the per-request cap for generic transformers that are not model requests.
  maxOps?: number;
};

export type ApplyResult =
  | { ok: true; definition: WD; derived: DerivedEdge[]; warnings: Issue[]; noop: boolean }
  | { ok: false; errors: Issue[]; warnings: Issue[] };

class OpError extends Error {
  constructor(readonly code: IssueCode, message: string) { super(message); }
}

const clone = <T>(x: T): T => structuredClone(x);
const sameRef = (a: StepRef, b: StepRef) => a.step === b.step && a.stage === b.stage;

function stepOf(w: WD, ref: StepRef): Step {
  const s = w.steps.find((x) => x.step_id === ref.step);
  if (!s) throw new OpError("unknown_id", `step ${ref.step} does not exist`);
  if (ref.stage !== undefined && s.document_ref?.stage !== ref.stage) throw new OpError("unknown_id", `step ${ref.step} has no stage ${ref.stage}`);
  return s;
}

// A model-reachable target: a non-external step that prepares a document stage.
function preparableTarget(w: WD, ref: StepRef): Step {
  const s = stepOf(w, ref);
  if (s.external || !isPreparingStep(s)) throw new OpError("bad_target", `step ${s.step_id} is not a non-external preparable step`);
  return s;
}

function nextEdgeId(w: WD): string {
  const nums = w.edges.map((e) => Number.parseInt(e.edge_id.slice(1, 3), 10));
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  if (n > 99) throw new OpError("grammar_cap", "no edge ids left");
  return `e${String(n).padStart(2, "0")}`;
}

function learnedEdge(w: WD, from: StepRef, to: StepRef, gate: "start" | "complete"): Edge {
  return { edge_id: nextEdgeId(w), from: clone(from), to: clone(to), gate, kind: "soft", origin: "learned", immutable: false, note: SOFT_EDGE_NOTE };
}

function checkPredicateIds(w: WD, p: EventPredicate): void {
  if ("after" in p) { stepOf(w, p.after); return; }
  if ("on" in p) {
    if (!SIM_EVENT_KIND_SET.has(p.on)) throw new OpError("unknown_id", `event kind ${p.on} is never emitted`);
    const sid = p.where?.["step_id"];
    if (sid !== undefined && !w.steps.some((s) => s.step_id === sid)) throw new OpError("unknown_id", `step ${sid} does not exist`);
    return;
  }
  for (const x of "all_of" in p ? p.all_of : p.any_of) checkPredicateIds(w, x);
}

// Record kinds a section may be bound to: those a step produces or those the base definition already binds.
function allowedSources(base: WD, w: WD): Set<RecordKind> {
  const out = new Set<RecordKind>();
  for (const s of w.steps) for (const rk of s.produces) out.add(rk);
  for (const d of base.documents) for (const sec of d.sections) out.add(sec.binding.record_kind);
  return out;
}

function applyOne(base: WD, w: WD, op: Operation, conditions: ConditionExpr[], warn: (m: string) => void): void {
  switch (op.op) {
    case "remove_soft_edge": {
      const e = w.edges.find((x) => x.edge_id === op.edge_id);
      if (!e) throw new OpError("unknown_id", `edge ${op.edge_id} does not exist`);
      if (e.kind !== "soft") throw new OpError("bad_target", `edge ${op.edge_id} is a fence`);
      w.edges = w.edges.filter((x) => x.edge_id !== op.edge_id);
      return;
    }
    case "add_soft_edge": {
      stepOf(w, op.from);
      preparableTarget(w, op.to);
      if (op.from.step === op.to.step) throw new OpError("bad_target", "an edge needs two different steps");
      if (w.edges.some((e) => e.kind === "soft" && sameRef(e.from, op.from) && sameRef(e.to, op.to) && e.gate === op.gate)) {
        warn(`soft edge ${op.from.step} to ${op.to.step} already exists`);
        return;
      }
      w.edges = [...w.edges, learnedEdge(w, op.from, op.to, op.gate)];
      return;
    }
    case "move_step_after": {
      preparableTarget(w, op.step);
      stepOf(w, op.after);
      if (op.step.step === op.after.step) throw new OpError("bad_target", "a step cannot follow itself");
      w.edges = w.edges.filter((e) => !(e.kind === "soft" && e.to.step === op.step.step));
      w.edges = [...w.edges, learnedEdge(w, op.after, op.step, op.gate)];
      return;
    }
    case "set_prep_trigger": {
      preparableTarget(w, op.target);
      checkPredicateIds(w, op.when);
      const existing = w.triggers.filter((t) => t.target.step === op.target.step);
      const next: Trigger = { target: clone(op.target), when: clone(op.when), condition: existing[0]?.condition ?? null };
      w.triggers = [...w.triggers.filter((t) => t.target.step !== op.target.step), next];
      return;
    }
    case "add_condition": {
      const t = op.target;
      if (t === "scope") {
        w.scope = { ...w.scope, condition: andCondition(w.scope.condition, op.condition) };
        conditions.push(w.scope.condition as ConditionExpr);
      } else if ("step" in t) {
        const s = preparableTarget(w, t.step);
        s.required_when = andCondition(s.required_when, op.condition);
        conditions.push(s.required_when);
      } else {
        stepOf(w, t.trigger);
        const hits = w.triggers.filter((x) => x.target.step === t.trigger.step);
        if (hits.length === 0) throw new OpError("unknown_id", `no trigger targets ${t.trigger.step}`);
        for (const h of hits) { h.condition = andCondition(h.condition, op.condition); conditions.push(h.condition); }
      }
      return;
    }
    case "rebind_section": {
      const doc = w.documents.find((d) => d.document_id === op.document_id);
      if (!doc) throw new OpError("unknown_id", `document ${op.document_id} does not exist`);
      const sec = doc.sections.find((s) => s.section_id === op.section_id);
      if (!sec) throw new OpError("unknown_id", `section ${op.section_id} does not exist on ${op.document_id}`);
      if (!allowedSources(base, w).has(op.source.record_kind)) throw new OpError("bad_target", `${op.source.record_kind} is not an allowed source`);
      if (sec.binding.record_kind === op.source.record_kind && sec.binding.field_path === op.source.field_path) {
        warn(`section ${op.section_id} is already bound to that source`);
        return;
      }
      sec.binding = clone(op.source);
      return;
    }
  }
}

function grammarIssues(w: WD): Issue[] {
  const out: Issue[] = [];
  const cond = (c: ConditionExpr | null, where: string) => {
    if (c !== null && countAtoms(c) > CONDITION_MAX_ATOMS) out.push({ code: "grammar_cap", op_index: null, message: `${where} exceeds ${CONDITION_MAX_ATOMS} atoms` });
  };
  cond(w.scope.condition, "scope condition");
  for (const s of w.steps) cond(s.required_when, `required_when of ${s.step_id}`);
  for (const t of w.triggers) {
    cond(t.condition, `trigger condition on ${t.target.step}`);
    const sh = predicateShape(t.when);
    if (sh.depth > PREDICATE_MAX_DEPTH || sh.leaves > PREDICATE_MAX_LEAVES) out.push({ code: "grammar_cap", op_index: null, message: `trigger on ${t.target.step} exceeds depth ${PREDICATE_MAX_DEPTH} or ${PREDICATE_MAX_LEAVES} leaves` });
  }
  return out;
}

// Applies up to three operations; validation runs in the plan's order and the first failing stage is reported.
export function applyOperations(def: WD, ops: readonly unknown[], opts: ApplyOptions = {}): ApplyResult {
  const warnings: Issue[] = [];
  const fail = (errors: Issue[]): ApplyResult => ({ ok: false, errors, warnings });
  const max = opts.maxOps ?? OPS_PER_REQUEST_MAX;
  if (ops.length === 0 || ops.length > max) return fail([{ code: "too_many_ops", op_index: null, message: `between 1 and ${max} operations` }]);

  const parsed: Operation[] = [];
  for (const [i, raw] of ops.entries()) {
    const r = Operation.safeParse(raw);
    if (!r.success) return fail([{ code: "schema", op_index: i, message: r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") }]);
    parsed.push(r.data);
  }

  const base = clone(def);
  const w = clone(def);
  const conditions: ConditionExpr[] = [];
  for (const [i, op] of parsed.entries()) {
    try {
      applyOne(base, w, op, conditions, (m) => warnings.push({ code: "no_op", op_index: i, message: m }));
    } catch (e) {
      if (e instanceof OpError) return fail([{ code: e.code, op_index: i, message: e.message }]);
      throw e;
    }
  }

  if (fencesHash(w) !== fencesHash(base)) return fail([{ code: "fence_changed", op_index: null, message: "stored fences changed" }]);
  if (permissionsHash(w) !== permissionsHash(base)) return fail([{ code: "permissions_changed", op_index: null, message: "permissions changed" }]);
  if (structureHash(w) !== structureHash(base)) return fail([{ code: "structure_changed", op_index: null, message: "step structure changed" }]);

  const cycle = findCycle(allPrecedences(w));
  if (cycle) return fail([{ code: "cycle", op_index: null, message: `cycle ${cycle.join(" > ")}` }]);

  const derived = deriveDataIntegrityFences(w);

  const caps = grammarIssues(w);
  if (caps.length) return fail(caps);

  if (opts.caseFacts && opts.caseFacts.length >= 2) {
    for (const c of conditions) {
      const n = opts.caseFacts.filter((f) => evalCondition(c, f)).length;
      if (n === 1) return fail([{ code: "single_case_condition", op_index: null, message: "a condition holds for exactly one case in the pool" }]);
    }
  }

  w.definition_hash = definitionHash(w);
  const check = WorkflowDefinition.safeParse(w);
  if (!check.success) return fail([{ code: "invalid_definition", op_index: null, message: check.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") }]);

  if (w.definition_hash === definitionHash(base)) {
    warnings.push({ code: "no_op", op_index: null, message: "the operations leave the definition unchanged" });
    return { ok: true, definition: base, derived, warnings, noop: true };
  }
  return { ok: true, definition: check.data as WD, derived, warnings, noop: false };
}
