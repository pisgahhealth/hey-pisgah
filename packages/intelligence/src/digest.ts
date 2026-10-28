import type { WorkflowDefinition } from "@hey-pisgah/contracts";
import { ENGINE_SEMANTICS } from "./views.js";

export const DIGEST_NOTE = "Short form of an older tool result, kept to save context; call the tool again for the full result.";
export const DEFINITION_NOTE = "Short form of the workflow definition read above; call get_workflow_definition again for documents, permissions, registries and the operation vocabulary.";
export const DROPPED_NOTE = "Older turns removed to save context; the short forms of the definition and the case list are kept here when they were read, list_ledger lists this session's hypotheses, experiments and proposals, and the tools return any record again.";
export const ARGS_NOTE = "Arguments of an older call removed to save context; list_ledger lists this session's records.";

type Row = Record<string, unknown>;
const j = (v: unknown): string => JSON.stringify(v);

// The definition as one line per step, edge and trigger, with the engine rules, for every turn after the one that read it in full.
export function definitionDigest(def: WorkflowDefinition): Row {
  return {
    digest: DEFINITION_NOTE,
    version: def.version,
    steps: def.steps.map((s) => [s.step_id, s.action_kind, s.document_ref ? `${s.document_ref.document_id}/${s.document_ref.stage}` : null, s.external ? "external" : null, s.required_when ? `required_when ${j(s.required_when)}` : null].filter(Boolean).join(" ")),
    edges: def.edges.map((e) => `${e.edge_id} ${e.from.step}>${e.to.step} ${e.gate} ${e.kind}`),
    triggers: def.triggers.map((t) => `${t.target.step} when ${j(t.when)}${t.condition ? ` if ${j(t.condition)}` : ""}`),
    engine_semantics: ENGINE_SEMANTICS
  };
}

// One timeline item as id, kind, subject and both clocks.
const itemLine = (r: Row): string => [r.event_id ?? r.note_id, r.kind, r.subject ?? r.author_role ?? null, `${String(r.occurred_at)}/${String(r.recorded_at)}`].filter((x) => x !== null && x !== undefined).join(" ");

const nonZero = (o: unknown): Row => Object.fromEntries(Object.entries((o ?? {}) as Row).filter(([, v]) => v !== 0));

// The short form one tool result takes once it is older than the context budget allows; null means the generic stub.
export function resultDigest(name: string, result: Row, def: WorkflowDefinition): Row | null {
  if (result.ok === false) return null;
  switch (name) {
    case "get_workflow_definition": return definitionDigest(def);
    case "run_experiment":
    case "get_experiment": {
      const b = (result.behaviour ?? null) as Row | null;
      const req = (result.request ?? {}) as Row;
      return { digest: DIGEST_NOTE, experiment_id: result.experiment_id, ops: req.ops, case_ids: req.case_ids, nonzero_median_delta: nonZero(result.median_delta), event_logs_identical_to_control: b?.event_logs_identical_to_control ?? null, note: b?.note ?? null };
    }
    case "get_case_timeline": return { digest: DIGEST_NOTE, case_id: result.case_id, order: result.order, offset: result.offset, next_offset: result.next_offset, items: ((result.items ?? []) as Row[]).map(itemLine) };
    case "compute_intervals": return { digest: DIGEST_NOTE, clock: result.clock, rows: ((result.rows ?? []) as Row[]).map((r) => ({ case_id: r.case_id, minutes: r.minutes })), summary: result.summary };
    case "list_cases": return { digest: DIGEST_NOTE, cases: ((result.cases ?? []) as Row[]).map((c) => `${String(c.case_id)} ward ${String(c.ward_id)} ${String(c.payer_type)} ${String(c.requirement_version)}`) };
    default: return null;
  }
}
