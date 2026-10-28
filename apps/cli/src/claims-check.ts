import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { z } from "zod";
import { Claim, ClaimsStatusFile } from "@hey-pisgah/contracts";

// v0: validates the registry and writes not_measured for every claim; predicates are evaluated by the evaluator from L2.2b on.
export function claimsCheck(root: string): void {
  const registry = z.object({ schema_version: z.number().int(), claims: z.array(Claim).length(16) }).parse(JSON.parse(readFileSync(`${root}/evaluation/claims.json`, "utf8")));
  const commit = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
  const claims = registry.claims.map((c) => {
    const measured = existsSync(`${root}/${c.acceptance.result_path}`);
    return { claim_id: c.claim_id, status: measured ? ("amber" as const) : ("not_measured" as const), values: {}, measured_at: measured ? new Date().toISOString() : null };
  });
  const status = ClaimsStatusFile.parse({ generated_at: new Date().toISOString(), commit, claims });
  writeFileSync(`${root}/evaluation/claims.status.json`, JSON.stringify(status, null, 2) + "\n");
  const counts = claims.reduce<Record<string, number>>((m, c) => ({ ...m, [c.status]: (m[c.status] ?? 0) + 1 }), {});
  console.log(`claims: ${JSON.stringify(counts)} -> evaluation/claims.status.json`);
}
