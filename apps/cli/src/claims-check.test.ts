import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimStatus, completionMatrix, parseClaimPredicate, parsePredicate, evaluate, validationSummary, PredicateError } from "@hey-pisgah/evaluator";
import { loadV1 } from "@hey-pisgah/hospital";
import { ClaimsRegistry, claimsCheck } from "./claims-check.js";

const repo = join(import.meta.dirname, "..", "..", "..");
const registry = ClaimsRegistry.parse(JSON.parse(readFileSync(join(repo, "evaluation", "claims.json"), "utf8")));
const predicateOf = (id: string) => registry.claims.find((c) => c.claim_id === id)!.acceptance.predicate;

function planted(results: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "claims-"));
  mkdirSync(join(root, "evaluation", "results"), { recursive: true });
  copyFileSync(join(repo, "evaluation", "claims.json"), join(root, "evaluation", "claims.json"));
  for (const [name, data] of Object.entries(results)) writeFileSync(join(root, "evaluation", "results", name), JSON.stringify(data));
  const status = claimsCheck(root, { commit: "abc1234", now: () => "2026-10-28T12:00:00.000Z" });
  return (id: string) => status.claims.find((c) => c.claim_id === id)!;
}

describe("claim predicates", () => {
  it("parse every registry predicate and respect precedence", () => {
    for (const c of registry.claims) expect(() => parseClaimPredicate(c.acceptance.predicate)).not.toThrow();
    expect(evaluate(parsePredicate("a || b && c"), { a: true, b: false, c: false })).toBe(true);
    expect(evaluate(parsePredicate("!(x.y >= 2) && z == 'ok'"), { x: { y: 1 }, z: "ok" })).toBe(true);
    expect(() => parsePredicate("a && && b")).toThrow(PredicateError);
  });
  it("report a missing deciding field as not measured", () => {
    const p = parseClaimPredicate("a == 0 && b ; amber: a == 0 && c");
    expect(claimStatus(p, { a: 0 }).status).toBe("not_measured");
    expect(claimStatus(p, { a: 0, b: true }).status).toBe("green");
    expect(claimStatus(p, { a: 0, b: false }).status).toBe("not_measured");
    expect(claimStatus(p, { a: 0, b: false, c: true }).status).toBe("amber");
    expect(claimStatus(p, { a: 1, b: true, c: true }).status).toBe("red");
  });
});

describe("claims:check", () => {
  it("marks every claim not measured when no result file exists", () => {
    const get = planted({});
    expect(registry.claims.map((c) => get(c.claim_id).status).every((s) => s === "not_measured")).toBe(true);
  });
  it("reads C-13 from the fields the completion matrix actually writes", () => {
    const summary = completionMatrix({ taskIds: () => [], caseOf: () => "", events: () => [] }, { recordState: () => null }, () => loadV1());
    expect(parseClaimPredicate(predicateOf("C-13")).fields.every((f) => f in summary)).toBe(true);
  });
  it("flips C-13 with the planted completion result and fills its values", () => {
    expect(planted({ "completion.json": { off_diagonal: 0, premature_attempts_counted: true, measured_at: "2026-10-28T11:00:00Z" } })("C-13")).toMatchObject({ status: "green", values: { off_diagonal: 0 }, measured_at: "2026-10-28T11:00:00.000Z" });
    expect(planted({ "completion.json": { off_diagonal: 1, premature_attempts_counted: true } })("C-13").status).toBe("red");
    expect(planted({ "completion.json": { off_diagonal: 0, premature_attempts_counted: false } })("C-13").status).toBe("amber");
  });
  it("reads C-06 from the fields the validation summary actually writes", () => {
    const fields = parseClaimPredicate(predicateOf("C-06")).fields;
    expect(fields.every((f) => f in validationSummary([]))).toBe(true);
    expect(planted({ "validation.json": validationSummary([]) })("C-06").status).toBe("red");
    expect(planted({ "validation.json": { ...validationSummary([]), proposals_validated: 2 } })("C-06").status).toBe("amber");
    expect(planted({ "validation.json": { ...validationSummary([]), dev_gate_pass: true, exception_check_pass: true, fences_unchanged: true } })("C-06").status).toBe("green");
  });
});
