import { FACT_VALUES, canonical, hashJson, type ConditionExpr, type Operation, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { applyOperations, isPreparingStep, type Facts } from "@hey-pisgah/workflow";

// The published single-operation space, stated as rules over any definition so it names no step, edge or document.
export const SPACE_RULE = [
  "remove_soft_edge: every soft edge",
  "add_soft_edge and move_step_after: every non-external preparing step as the target, every other step as the source, gate start and complete",
  "set_prep_trigger: every non-external preparing step, after any other step",
  "add_condition: on the requirement of every non-external preparing step, on every trigger of such a step, and on the scope, one eq atom per fact value; ward values come from the pool's facts",
  "rebind_section: every section of a document such a step prepares, to every record kind some step produces, keeping the field path",
  "an operation counts only if it applies alone without an error under the pool's single-case rule"
] as const;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const opKey = (op: Operation): string => canonical(op);

// Every candidate operation the rules name, before validity is checked, in a fixed order.
export function candidateOperations(def: WD, wards: readonly string[]): Operation[] {
  const steps = [...def.steps].sort((a, b) => cmp(a.step_id, b.step_id));
  const targets = steps.filter((s) => !s.external && isPreparingStep(s));
  const gates = ["start", "complete"] as const;
  const out: Operation[] = [];
  for (const e of [...def.edges].filter((x) => x.kind === "soft").sort((a, b) => cmp(a.edge_id, b.edge_id))) out.push({ op: "remove_soft_edge", edge_id: e.edge_id });
  for (const t of targets) for (const s of steps) if (s.step_id !== t.step_id) for (const gate of gates) out.push({ op: "add_soft_edge", from: { step: s.step_id }, to: { step: t.step_id }, gate });
  for (const t of targets) for (const s of steps) if (s.step_id !== t.step_id) for (const gate of gates) out.push({ op: "move_step_after", step: { step: t.step_id }, after: { step: s.step_id }, gate });
  for (const t of targets) for (const s of steps) if (s.step_id !== t.step_id) out.push({ op: "set_prep_trigger", target: { step: t.step_id }, when: { after: { step: s.step_id } } });
  const atoms: ConditionExpr[] = [];
  for (const [fact, values] of Object.entries(FACT_VALUES).sort(([a], [b]) => cmp(a, b))) {
    const vs = Array.isArray(values) ? [...values] : [...wards].sort();
    for (const v of vs) atoms.push({ fact, eq: v } as ConditionExpr);
  }
  const condTargets: (Operation & { op: "add_condition" })["target"][] = [
    ...targets.map((t) => ({ step: { step: t.step_id } })),
    ...targets.filter((t) => def.triggers.some((x) => x.target.step === t.step_id)).map((t) => ({ trigger: { step: t.step_id } })),
    "scope" as const
  ];
  for (const target of condTargets) for (const condition of atoms) out.push({ op: "add_condition", target, condition } as Operation);
  const produced = [...new Set(steps.flatMap((s) => s.produces))].sort();
  const docs = [...new Set(targets.map((t) => t.document_ref!.document_id))].sort();
  for (const d of docs) {
    const doc = def.documents.find((x) => x.document_id === d)!;
    for (const sec of doc.sections) for (const rk of produced) {
      if (rk !== sec.binding.record_kind) out.push({ op: "rebind_section", document_id: doc.document_id, section_id: sec.section_id, source: { record_kind: rk, field_path: sec.binding.field_path, version_policy: "current" } });
    }
  }
  return out;
}

export type SpaceEntry = { op: Operation; definition_hash: string; noop: boolean };

// The valid single operations: each candidate that applies alone, keyed by the definition it produces.
export function singleOperationSpace(def: WD, caseFacts: readonly Facts[]): { entries: SpaceEntry[]; candidates: number; invalid: Record<string, number>; hash: string } {
  const wards = [...new Set(caseFacts.map((f) => String(f["ward_id"])))];
  const candidates = candidateOperations(def, wards);
  const entries: SpaceEntry[] = [];
  const invalid: Record<string, number> = {};
  for (const op of candidates) {
    const r = applyOperations(def, [op], { caseFacts });
    if (!r.ok) { const c = r.errors[0]?.code ?? "unknown"; invalid[c] = (invalid[c] ?? 0) + 1; continue; }
    entries.push({ op, definition_hash: r.definition.definition_hash, noop: r.noop });
  }
  return { entries, candidates: candidates.length, invalid, hash: hashJson({ rule: [...SPACE_RULE], ops: entries.map((e) => e.op) }) };
}
