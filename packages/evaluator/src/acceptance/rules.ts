import { readFileSync } from "node:fs";
import { z } from "zod";
import { ActionKind, CappedCondition, DocumentId, RecordKind } from "@hey-pisgah/contracts";
import { ACCEPTANCE_DIR } from "../data.js";

// The evaluator's own encoding of ward prose; the engine never reads it.
export const ContentRule = z.strictObject({
  rule_id: z.string().regex(/^[a-z0-9_]+$/),
  ward_id: z.string(),
  from_requirement_version: z.string().regex(/^r\d+$/),
  document_id: DocumentId,
  section_id: z.string(),
  source: z.strictObject({ record_kind: RecordKind, field_path: z.string() }),
  applies_when: CappedCondition.nullable(),
  source_exists_before: z.enum(["draft", "final"])
});
export type ContentRule = z.infer<typeof ContentRule>;

export const ContentRules = z.strictObject({
  schema_version: z.literal(1),
  rules: z.array(ContentRule),
  clinical_record_kinds: z.array(RecordKind),
  clinical_action_kinds: z.array(ActionKind),
  money_action_kinds: z.array(ActionKind)
});
export type ContentRules = z.infer<typeof ContentRules>;

export const loadContentRules = (): ContentRules => ContentRules.parse(JSON.parse(readFileSync(`${ACCEPTANCE_DIR}content-rules.json`, "utf8")));

const versionNo = (v: string): number => Number.parseInt(v.slice(1), 10);

// Rules in force for one ward under one requirement version.
export function rulesFor(rules: ContentRules, wardId: string, requirementVersion: string): ContentRule[] {
  return rules.rules.filter((r) => r.ward_id === wardId && versionNo(requirementVersion) >= versionNo(r.from_requirement_version));
}
