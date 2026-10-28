import { loadPool } from "@hey-pisgah/cases";
import { loadV1 } from "@hey-pisgah/hospital";
import type { Facts } from "@hey-pisgah/workflow";
import { a1CommitmentBody } from "./arms/a1.js";
import { a4CommitmentBody } from "./arms/experiments.js";
import { hashJson } from "@hey-pisgah/contracts";
import { commit, committedHash, sourceOf } from "./commitments.js";
import { fr1CommitmentBody } from "./fr1.js";

// The bodies of the evaluator's committed artifacts, computed from the code and data as they are now.
export function artifactBodies(): Record<string, Record<string, unknown>> {
  const discovery = loadPool("discovery").map((c) => ({ case_id: c.case_id, facts: c.schedule.facts as Facts }));
  return {
    a1: a1CommitmentBody(sourceOf("./arms/a1.ts")),
    a4: a4CommitmentBody(loadV1(), discovery),
    fr1: fr1CommitmentBody(sourceOf("./fr1.ts"))
  };
}

// Which committed hashes no longer match the code; an empty list means the commitments hold.
export function staleCommitments(): string[] {
  return Object.entries(artifactBodies()).filter(([name, body]) => committedHash(name) !== hashJson(body)).map(([name]) => name);
}

if (process.argv[1]?.endsWith("commit-artifacts.ts")) {
  const reason = process.argv[process.argv.indexOf("--reason") + 1];
  if (!process.argv.includes("--write") || !reason || reason.startsWith("--")) { console.log(`stale: ${staleCommitments().join(", ") || "none"}`); process.exit(0); }
  for (const [name, body] of Object.entries(artifactBodies())) console.log(name, JSON.stringify(commit(name, body, reason)));
}
