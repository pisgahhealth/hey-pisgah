import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";
import { Claim, ClaimsStatusFile } from "@hey-pisgah/contracts";
import { claimStatus, fieldAt, parseClaimPredicate } from "@hey-pisgah/evaluator";

export const ClaimsRegistry = z.object({ schema_version: z.number().int(), claims: z.array(Claim).length(28), revisions: z.array(z.unknown()).optional() });
export type ClaimsCheckOptions = { commit?: string; now?: () => string; resultsRoot?: string };
type StatusFile = z.infer<typeof ClaimsStatusFile>;

// Learning words wait for two results: the second cycle reading its own outcomes, and a passed reversed-evidence test.
export const LEARNING_WORD = /\blearn(s|ed|ing|t)?\b/i;
export const REVERSED_EVIDENCE_RESULT = "evaluation/results/reversed-evidence.json";
const readResult = (file: string): unknown => { try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null; } catch { return null; } };

// Whether the system may be said to learn: C-10's file shows outcomes read and the reversed-evidence result passed.
export function learningEarned(resultsRoot: string): { c10_reads_outcomes: boolean; reversed_evidence_passed: boolean } {
  const outcomes = fieldAt(readResult(`${resultsRoot}/evaluation/results/cycle2.json`), "read.outcomes");
  const reversed = readResult(`${resultsRoot}/${REVERSED_EVIDENCE_RESULT}`) as { passed?: unknown } | null;
  return { c10_reads_outcomes: typeof outcomes === "number" && outcomes >= 1, reversed_evidence_passed: reversed?.passed === true };
}

// Every claim text that uses a learning word while either result is missing; the wording until then is "discovers and adapts under approval".
export function learningWordProblems(claims: readonly Claim[], earned: ReturnType<typeof learningEarned>): string[] {
  if (earned.c10_reads_outcomes && earned.reversed_evidence_passed) return [];
  return claims.flatMap((c) => {
    const texts: [string, string][] = [["question", c.question], ["component", c.demo_surface.component], ["table", c.evaluation_view.table], ...Object.entries(c.wording).map(([k, w]) => [`wording.${k}`, w] as [string, string])];
    return texts.filter(([, t]) => LEARNING_WORD.test(t)).map(([where]) => `${c.claim_id} ${where} uses a learning word before C-10 reads outcomes and the reversed-evidence test passes`);
  });
}

const placeholders = (wording: Record<string, string>) => [...new Set(Object.values(wording).flatMap((w) => [...w.matchAll(/\{([a-z0-9_]+)\}/g)].map((m) => m[1]!)))];

// Evaluates each claim's predicate over its result file and writes evaluation/claims.status.json.
export function claimsCheck(root: string, opts: ClaimsCheckOptions = {}): StatusFile {
  const registry = ClaimsRegistry.parse(JSON.parse(readFileSync(`${root}/evaluation/claims.json`, "utf8")));
  const words = learningWordProblems(registry.claims, learningEarned(opts.resultsRoot ?? root));
  if (words.length) throw new Error(`claims:check: ${words.join("; ")}`);
  const now = opts.now ?? (() => new Date().toISOString());
  const commit = opts.commit ?? execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
  const claims = registry.claims.map((c) => {
    const pred = parseClaimPredicate(c.acceptance.predicate);
    const file = `${opts.resultsRoot ?? root}/${c.acceptance.result_path}`;
    const names = [...pred.fields, ...placeholders(c.wording).filter((p) => !pred.fields.includes(p))];
    if (!existsSync(file)) return { claim_id: c.claim_id, status: "not_measured" as const, values: Object.fromEntries(names.map((n) => [n, null])), measured_at: null };
    let data: unknown;
    try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return { claim_id: c.claim_id, status: "not_measured" as const, values: { unreadable: true }, measured_at: null }; }
    const { status, missing } = claimStatus(pred, data);
    const values: Record<string, unknown> = Object.fromEntries(names.map((n) => [n, fieldAt(data, n) ?? null]));
    if (missing.length) values["missing"] = missing;
    const stamped = fieldAt(data, "measured_at");
    const measured_at = status === "not_measured" ? null : typeof stamped === "string" && !Number.isNaN(Date.parse(stamped)) ? new Date(stamped).toISOString() : statSync(file).mtime.toISOString();
    return { claim_id: c.claim_id, status, values, measured_at };
  });
  const status = ClaimsStatusFile.parse({ generated_at: now(), commit, claims });
  const outFile = `${opts.resultsRoot ?? root}/evaluation/claims.status.json`;
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(status, null, 2) + "\n");
  const counts = claims.reduce<Record<string, number>>((m, c) => ({ ...m, [c.status]: (m[c.status] ?? 0) + 1 }), {});
  console.log(`claims: ${JSON.stringify(counts)} -> ${outFile}`);
  return status;
}
