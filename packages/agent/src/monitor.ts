import { readFileSync } from "node:fs";
import { z } from "zod";
import { CappedCondition, DocumentId, RecordKind, Stage, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { evalCondition, type Facts } from "@hey-pisgah/workflow";

// The runtime's own machine-checkable reading of ward requirement prose; it is never shown to the model, and the evaluator keeps a separate encoding.
export const RequirementCheck = z.strictObject({
  check_id: z.string().regex(/^[a-z0-9_]+$/),
  ward_id: z.string(),
  from_requirement_version: z.string().regex(/^r\d+$/),
  document_id: DocumentId,
  section_id: z.string(),
  source: z.strictObject({ record_kind: RecordKind, field_path: z.string() }),
  applies_when: CappedCondition.nullable(),
  source_exists_before: Stage
});
export type RequirementCheck = z.infer<typeof RequirementCheck>;
export const RequirementChecks = z.strictObject({ schema_version: z.literal(1), checks: z.array(RequirementCheck) });

export const loadRequirementChecks = (): RequirementCheck[] =>
  RequirementChecks.parse(JSON.parse(readFileSync(new URL("./data/requirement-checks.json", import.meta.url), "utf8"))).checks;

const versionNo = (v: string) => Number.parseInt(v.slice(1), 10);

// Checks in force for one ward under one requirement version and the case facts.
export function checksInForce(all: readonly RequirementCheck[], wardId: string, requirementVersion: string, facts: Facts): RequirementCheck[] {
  return all.filter((c) => c.ward_id === wardId && versionNo(requirementVersion) >= versionNo(c.from_requirement_version) && (c.applies_when === null || evalCondition(c.applies_when, facts)));
}

export type CheckFailure = { check_id: string; kind: "binding" | "source_missing"; document_id: string; stage: string; section_id: string; expected: { record_kind: string; field_path: string }; found: { record_kind: string; field_path: string } | null };

// A stage fails a check when it carries the section and the section copies from another source than the requirement names.
export function bindingFailures(def: WD, documentId: string, stage: string, checks: readonly RequirementCheck[]): CheckFailure[] {
  const doc = def.documents.find((d) => d.document_id === documentId);
  if (!doc) return [];
  const out: CheckFailure[] = [];
  for (const c of checks.filter((x) => x.document_id === documentId)) {
    const sec = doc.sections.find((s) => s.section_id === c.section_id);
    if (!sec || (stage === "draft" && sec.needed_for !== "draft")) continue;
    if (sec.binding.record_kind === c.source.record_kind && sec.binding.field_path === c.source.field_path) continue;
    out.push({ check_id: c.check_id, kind: "binding", document_id: documentId, stage, section_id: c.section_id, expected: c.source, found: { record_kind: sec.binding.record_kind, field_path: sec.binding.field_path } });
  }
  return out;
}

// The operation a person could approve to make a version meet the failed binding checks.
export const revisionOps = (fs: readonly CheckFailure[]) =>
  [...new Map(fs.filter((f) => f.kind === "binding").map((f) => [`${f.document_id}.${f.section_id}`, { op: "rebind_section" as const, document_id: f.document_id, section_id: f.section_id, source: { ...f.expected, version_policy: "current" as const } }])).values()];
