import type { ConditionExpr, WorkflowDefinition } from "@hey-pisgah/contracts";

// Fact values a case carries; ward_requires is a list, every other fact is one string.
export type FactValue = string | readonly string[];
export type Facts = Readonly<Record<string, FactValue>>;

function atomHolds(value: FactValue | undefined, wanted: readonly string[]): boolean {
  if (value === undefined) return false;
  if (typeof value === "string") return wanted.includes(value);
  return value.some((v) => wanted.includes(v));
}

// Evaluates a condition against facts; a missing fact makes its atom false.
export function evalCondition(c: ConditionExpr, facts: Facts): boolean {
  if ("fact" in c) return atomHolds(facts[c.fact], "eq" in c ? [c.eq] : c.in);
  if ("not" in c) return !evalCondition(c.not, facts);
  if ("all" in c) return c.all.every((x) => evalCondition(x, facts));
  return c.any.some((x) => evalCondition(x, facts));
}

// Conjoins two conditions, flattening an existing all-list so the atom count stays honest.
export function andCondition(a: ConditionExpr | null, b: ConditionExpr): ConditionExpr {
  if (a === null) return b;
  const left = "all" in a ? a.all : [a];
  return { all: [...left, b] };
}

// True when the definition's scope covers a case with these facts.
export function inScope(def: Pick<WorkflowDefinition, "scope">, facts: Facts): boolean {
  const ward = facts["ward_id"];
  if (def.scope.wards !== "all" && (typeof ward !== "string" || !def.scope.wards.includes(ward))) return false;
  return def.scope.condition === null || evalCondition(def.scope.condition, facts);
}
