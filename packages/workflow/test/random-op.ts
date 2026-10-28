import { RecordKind, type Operation, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";

// Draws one operation over the current definition, valid by schema but not always by the rules.
export function randomOp(r: () => number, d: WD): Operation {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const steps = d.steps.map((s) => s.step_id);
  const prep = d.steps.filter((s) => s.action_kind === "prepare_document" && !s.external).map((s) => s.step_id);
  const facts = [{ fact: "payer_type", eq: pick(["hmo", "self_pay", "corporate"]) }, { fact: "ward_id", eq: pick(["A", "B", "C"]) }, { fact: "has_take_home_order", eq: pick(["true", "false"]) }] as const;
  switch (Math.floor(r() * 6)) {
    case 0: return { op: "remove_soft_edge", edge_id: pick(d.edges.map((e) => e.edge_id)) };
    case 1: return { op: "add_soft_edge", from: { step: pick(steps) }, to: { step: r() < 0.8 ? pick(prep) : pick(steps) }, gate: pick(["start", "complete"] as const) };
    case 2: return { op: "move_step_after", step: { step: pick(prep) }, after: { step: pick(steps) }, gate: pick(["start", "complete"] as const) };
    case 3: return {
      op: "set_prep_trigger", target: { step: pick(prep) },
      when: r() < 0.5 ? { after: { step: pick(steps) } } : { any_of: [{ on: "step.completed", where: { step_id: pick(steps) } }, { after: { step: pick(steps) } }] }
    };
    case 4: return { op: "add_condition", target: r() < 0.2 ? "scope" : r() < 0.5 ? { trigger: { step: pick(prep) } } : { step: { step: pick(prep) } }, condition: { ...pick(facts) } };
    default: {
      const doc = pick(d.documents.filter((x) => x.sections.length > 0));
      return { op: "rebind_section", document_id: doc.document_id, section_id: pick(doc.sections).section_id, source: { record_kind: pick(RecordKind.options), field_path: "value", version_policy: "current" } };
    }
  }
}
