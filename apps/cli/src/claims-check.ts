import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";
import { Claim, ClaimsStatusFile } from "@hey-pisgah/contracts";
import { claimStatus, fieldAt, parseClaimPredicate } from "@hey-pisgah/evaluator";

export const ClaimsRegistry = z.object({ schema_version: z.number().int(), claims: z.array(Claim).length(17), revisions: z.array(z.unknown()).optional() });
export type ClaimsCheckOptions = { commit?: string; now?: () => string; resultsRoot?: string };
type StatusFile = z.infer<typeof ClaimsStatusFile>;

const placeholders = (wording: Record<string, string>) => [...new Set(Object.values(wording).flatMap((w) => [...w.matchAll(/\{([a-z0-9_]+)\}/g)].map((m) => m[1]!)))];

// Evaluates each claim's predicate over its result file and writes evaluation/claims.status.json.
export function claimsCheck(root: string, opts: ClaimsCheckOptions = {}): StatusFile {
  const registry = ClaimsRegistry.parse(JSON.parse(readFileSync(`${root}/evaluation/claims.json`, "utf8")));
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
