import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimStatus, completionMatrix, parseClaimPredicate, parsePredicate, evaluate, validationSummary, PredicateError } from "@hey-pisgah/evaluator";
import { loadV1 } from "@hey-pisgah/hospital";
import { ClaimsRegistry, REVERSED_EVIDENCE_RESULT, claimsCheck, learningEarned, learningWordProblems } from "./claims-check.js";

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
  it("reads C-06 from the same discovery file and predicate as its successor C-26", () => {
    const c06 = registry.claims.find((c) => c.claim_id === "C-06")!.acceptance;
    const c26 = registry.claims.find((c) => c.claim_id === "C-26")!.acceptance;
    expect(c06.result_path).toBe(c26.result_path);
    expect(c06.predicate).toBe(c26.predicate);
    const file = c06.result_path.split("/").at(-1)!;
    const base = { discover_config_dev_valid: 0, discover_dev_valid_any: 0, discover_invariance_pass: false, discover_deny_clean: false };
    expect(planted({ [file]: base })("C-06").status).toBe("red");
    expect(planted({ [file]: { ...base, discover_dev_valid_any: 2 } })("C-06").status).toBe("amber");
    expect(planted({ [file]: { ...base, discover_dev_valid_any: 4, discover_invariance_pass: true, discover_deny_clean: true } })("C-26").status).toBe("amber");
    expect(planted({ [file]: { discover_config_dev_valid: 1, discover_dev_valid_any: 1, discover_invariance_pass: true, discover_deny_clean: true } })("C-06").status).toBe("green");
  });
});

describe("no learning words before the system has earned them", () => {
  const repoEarned = learningEarned(repo);
  const withWord = () => {
    const reg = structuredClone(registry);
    reg.claims.find((c) => c.claim_id === "C-26")!.wording.pass = "The system learns a better workflow";
    return reg;
  };

  it("finds no learning word in the registry while C-10 has read no outcome or no reversed-evidence result passed", () => {
    expect(repoEarned.c10_reads_outcomes && repoEarned.reversed_evidence_passed).toBe(false);
    expect(learningWordProblems(registry.claims, repoEarned)).toEqual([]);
  });

  it("flags a planted learning word in any claim text until both results hold", () => {
    const reg = withWord();
    expect(learningWordProblems(reg.claims, { c10_reads_outcomes: false, reversed_evidence_passed: false })).toEqual([expect.stringContaining("C-26 wording.pass")]);
    expect(learningWordProblems(reg.claims, { c10_reads_outcomes: true, reversed_evidence_passed: false })).toHaveLength(1);
    expect(learningWordProblems(reg.claims, { c10_reads_outcomes: false, reversed_evidence_passed: true })).toHaveLength(1);
    expect(learningWordProblems(reg.claims, { c10_reads_outcomes: true, reversed_evidence_passed: true })).toEqual([]);
    for (const w of ["learned", "learning", "Learns", "learnt"]) {
      const r = structuredClone(registry);
      r.claims[0]!.question = `It ${w} things`;
      expect(learningWordProblems(r.claims, { c10_reads_outcomes: false, reversed_evidence_passed: false }), w).toHaveLength(1);
    }
    const near = structuredClone(registry);
    near.claims[0]!.question = "Applied the lesson to the learner record";
    expect(learningWordProblems(near.claims, { c10_reads_outcomes: false, reversed_evidence_passed: false })).toEqual([]);
  });

  it("makes claims:check refuse a registry with the word, and reads both results from the files", () => {
    const root = mkdtempSync(join(tmpdir(), "claims-learn-"));
    mkdirSync(join(root, "evaluation", "results"), { recursive: true });
    writeFileSync(join(root, "evaluation", "claims.json"), JSON.stringify(withWord()));
    const run = () => claimsCheck(root, { commit: "abc1234", now: () => "2026-10-30T12:00:00.000Z" });
    expect(run).toThrow(/C-26 wording\.pass uses a learning word/);
    writeFileSync(join(root, "evaluation", "results", "cycle2.json"), JSON.stringify({ read: { outcomes: 2 } }));
    expect(run).toThrow(/learning word/);
    writeFileSync(join(root, REVERSED_EVIDENCE_RESULT), JSON.stringify({ passed: false }));
    expect(run).toThrow(/learning word/);
    writeFileSync(join(root, REVERSED_EVIDENCE_RESULT), JSON.stringify({ passed: true }));
    expect(learningEarned(root)).toEqual({ c10_reads_outcomes: true, reversed_evidence_passed: true });
    expect(run().claims).toHaveLength(28);
  });

  it("keeps the README's description of the system free of the word too", () => {
    const readme = readFileSync(join(repo, "README.md"), "utf8");
    if (!(repoEarned.c10_reads_outcomes && repoEarned.reversed_evidence_passed)) expect(readme.match(/\blearns\b/gi) ?? []).toEqual([]);
  });
});
