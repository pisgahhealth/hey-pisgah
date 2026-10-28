import { definitionHash, fencesHash, hashJson, permissionsHash, structureHash, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { isPreparingStep } from "@hey-pisgah/workflow";

// The rule A1 follows, stated once so the commitment hash covers the words as well as the code.
export const A1_RULE = [
  "remove every soft edge whose target is a non-external document-preparing step",
  "remove every trigger on such a step, so each stage starts as soon as its requirement holds and its start fences allow",
  "keep every fence, permission, step, section binding and every soft edge into any other step",
  "redrafting on a source change is the engine's own revision path and is not altered"
] as const;

export type A1Result = { definition: WD; removed_edges: string[]; removed_triggers: string[] };

// A1, the earliest-permitted transformer: a generic function over any definition, with no step or edge id named.
export function earliestPermitted(def: WD): A1Result {
  const prep = new Set(def.steps.filter((s) => !s.external && isPreparingStep(s)).map((s) => s.step_id));
  const removed_edges = def.edges.filter((e) => e.kind === "soft" && prep.has(e.to.step)).map((e) => e.edge_id).sort();
  const removed_triggers = def.triggers.filter((t) => prep.has(t.target.step)).map((t) => t.target.step).sort();
  const out: WD = structuredClone(def);
  out.edges = out.edges.filter((e) => !removed_edges.includes(e.edge_id));
  out.triggers = out.triggers.filter((t) => !prep.has(t.target.step));
  out.definition_hash = definitionHash(out);
  if (fencesHash(out) !== fencesHash(def) || permissionsHash(out) !== permissionsHash(def) || structureHash(out) !== structureHash(def)) {
    throw new Error("A1 changed a fence, a permission or the step structure");
  }
  return { definition: out, removed_edges, removed_triggers };
}

// The A1 commitment: the rule text and the transformer's own source, hashed together.
export function a1CommitmentBody(source: string): Record<string, unknown> {
  return { artifact: "a1", rule: [...A1_RULE], source_sha256: hashJson(source) };
}
