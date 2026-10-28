import { readFileSync } from "node:fs";
import { z } from "zod";
import { CappedCondition, DocumentId, FACT_VALUES, type ConditionExpr } from "@hey-pisgah/contracts";

// Ward requirements are human-written and versioned; the structured list feeds the ward_requires fact and the prose is never read by the engine.
export const RequiredDocument = z.strictObject({ document_id: DocumentId, condition: CappedCondition.nullable() });

export const WardRequirement = z.strictObject({
  ward_id: z.string().regex(FACT_VALUES.ward_id),
  display_name: z.string().min(1),
  version: z.string().regex(/^r\d+$/),
  effective_from: z.iso.date(),
  approver: z.strictObject({ staff_id: z.string().regex(/^[a-z][a-z0-9_]*$/), role: z.literal("ward_manager"), display_name: z.string().min(1) }),
  required_documents: z.array(RequiredDocument),
  procedure_text: z.string().min(1).max(600)
});
export type WardRequirement = z.infer<typeof WardRequirement>;

export const WardRequirementSet = z.strictObject({ requirement_version: z.string().regex(/^r\d+$/), wards: z.array(WardRequirement).min(1) })
  .refine((s) => new Set(s.wards.map((w) => w.ward_id)).size === s.wards.length, { message: "duplicate ward" });
export type WardRequirementSet = z.infer<typeof WardRequirementSet>;

// r1 is the set every case starts from; r2 changes only Ward B's procedure text, and arrives later as data.
export const REQUIREMENT_VERSIONS = ["r1", "r2"] as const;
export function loadWardRequirements(version: (typeof REQUIREMENT_VERSIONS)[number] = "r1"): WardRequirementSet {
  return WardRequirementSet.parse(JSON.parse(readFileSync(new URL(`./data/ward-requirements.${version}.json`, import.meta.url), "utf8")));
}

// Facts are strings, matching the contracts value lists; ward_requires is answered from the ward's structured list.
export type Facts = Partial<Record<Exclude<keyof typeof FACT_VALUES, "ward_requires">, string>>;

export function evalCondition(c: ConditionExpr, facts: Facts, wardRequires: (doc: string) => boolean): boolean {
  if ("fact" in c) {
    const values = "eq" in c ? [c.eq] : c.in;
    if (c.fact === "ward_requires") return values.some((d) => wardRequires(d));
    const v = facts[c.fact];
    return v !== undefined && values.includes(v);
  }
  if ("not" in c) return !evalCondition(c.not, facts, wardRequires);
  if ("all" in c) return c.all.every((x) => evalCondition(x, facts, wardRequires));
  return c.any.some((x) => evalCondition(x, facts, wardRequires));
}

// True when the ward lists the document and its condition holds for this patient.
export function wardRequires(set: WardRequirementSet, wardId: string, documentId: string, facts: Facts): boolean {
  const ward = set.wards.find((w) => w.ward_id === wardId);
  if (!ward) throw new Error(`unknown ward ${wardId}`);
  const row = ward.required_documents.find((r) => r.document_id === documentId);
  if (!row) return false;
  return row.condition === null || evalCondition(row.condition, facts, () => false);
}

// The ward_requires list a case starts with: every document the ward lists whose condition holds.
export function wardRequiresList(set: WardRequirementSet, wardId: string, facts: Facts): string[] {
  const ward = set.wards.find((w) => w.ward_id === wardId);
  if (!ward) throw new Error(`unknown ward ${wardId}`);
  return ward.required_documents.filter((r) => wardRequires(set, wardId, r.document_id, facts)).map((r) => r.document_id);
}
