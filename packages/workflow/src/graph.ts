import type { DerivedEdge, EventPredicate, RecordKind, Step, StepRef, WorkflowDefinition } from "@hey-pisgah/contracts";

// A precedence pair used for cycle checks; origin "trigger" marks an edge implied by a trigger predicate.
export type Precedence = { from: string; to: string; origin: string };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function refOf(step: Step): StepRef {
  return step.document_ref ? { step: step.step_id, stage: step.document_ref.stage } : { step: step.step_id };
}

// A step that prepares a document stage; only these carry derived data-integrity fences.
export function isPreparingStep(s: Step): boolean {
  return s.action_kind === "prepare_document" && s.document_ref !== null;
}

// Record kinds each preparing step's stage needs: a draft needs draft sections, a final needs every section.
export function boundRecordKinds(def: Pick<WorkflowDefinition, "documents">, step: Step): RecordKind[] {
  if (!step.document_ref) return [];
  const ref = step.document_ref;
  const doc = def.documents.find((d) => d.document_id === ref.document_id);
  if (!doc) return [];
  const sections = ref.stage === "final" ? doc.sections : doc.sections.filter((s) => s.needed_for === "draft");
  return [...new Set(sections.map((s) => s.binding.record_kind))].sort(cmp);
}

// Derives the in-memory data-integrity fences: a prepared stage cannot complete until every step producing a bound record has completed.
export function deriveDataIntegrityFences(def: Pick<WorkflowDefinition, "documents" | "steps">): DerivedEdge[] {
  const producers = new Map<string, Step[]>();
  for (const s of def.steps) for (const rk of s.produces) producers.set(rk, [...(producers.get(rk) ?? []), s]);
  const out: DerivedEdge[] = [];
  const seen = new Set<string>();
  for (const step of def.steps) {
    if (!isPreparingStep(step)) continue;
    for (const rk of boundRecordKinds(def, step)) {
      for (const p of producers.get(rk) ?? []) {
        if (p.step_id === step.step_id) continue;
        const key = `${p.step_id}>${step.step_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ from: refOf(p), to: refOf(step), gate: "complete", origin: "data_integrity" });
      }
    }
  }
  return out.sort((a, b) => cmp(a.from.step, b.from.step) || cmp(a.to.step, b.to.step));
}

// Steps whose completion would satisfy one predicate leaf, as far as the leaf can be read statically.
function leafSources(def: Pick<WorkflowDefinition, "steps">, p: EventPredicate): string[] {
  if ("after" in p) return [p.after.step];
  if ("on" in p) {
    const w = p.where ?? {};
    if (p.on === "step.completed" || p.on === "step.started" || p.on === "step.held") {
      return def.steps
        .filter((s) => (w["step_id"] === undefined || w["step_id"] === s.step_id)
          && (w["action_kind"] === undefined || w["action_kind"] === s.action_kind)
          && (w["document_id"] === undefined || w["document_id"] === s.document_ref?.document_id)
          && (w["stage"] === undefined || w["stage"] === s.document_ref?.stage))
        .map((s) => s.step_id);
    }
    if (p.on === "record.versioned" && w["record_kind"] !== undefined) {
      return def.steps.filter((s) => s.produces.includes(w["record_kind"] as RecordKind)).map((s) => s.step_id);
    }
    return [];
  }
  const list = "all_of" in p ? p.all_of : p.any_of;
  return list.flatMap((x) => leafSources(def, x));
}

// Edges implied by triggers; any_of leaves are all counted, so the cycle check is conservative.
export function triggerImpliedEdges(def: Pick<WorkflowDefinition, "steps" | "triggers">): Precedence[] {
  const out: Precedence[] = [];
  for (const t of def.triggers) {
    for (const from of [...new Set(leafSources(def, t.when))].sort(cmp)) out.push({ from, to: t.target.step, origin: "trigger" });
  }
  return out;
}

// Every precedence the executor honours: stored edges, derived fences and trigger-implied edges.
export function allPrecedences(def: Pick<WorkflowDefinition, "steps" | "edges" | "documents" | "triggers">): Precedence[] {
  return [
    ...def.edges.map((e) => ({ from: e.from.step, to: e.to.step, origin: e.origin })),
    ...deriveDataIntegrityFences(def).map((e) => ({ from: e.from.step, to: e.to.step, origin: e.origin })),
    ...triggerImpliedEdges(def)
  ];
}

// Returns one cycle as a list of step ids (first id repeated at the end), or null when the graph is acyclic.
export function findCycle(edges: readonly Precedence[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const e of edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  for (const [k, v] of adj) adj.set(k, [...new Set(v)].sort(cmp));
  const colour = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    colour.set(n, 1);
    stack.push(n);
    for (const m of adj.get(n) ?? []) {
      const c = colour.get(m);
      if (c === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (c === undefined) {
        const found = visit(m);
        if (found) return found;
      }
    }
    stack.pop();
    colour.set(n, 2);
    return null;
  };
  for (const n of [...adj.keys()].sort(cmp)) {
    if (colour.get(n) === undefined) {
      const found = visit(n);
      if (found) return found;
    }
  }
  return null;
}
