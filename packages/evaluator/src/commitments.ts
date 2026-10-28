import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hashJson } from "@hey-pisgah/contracts";

// The repo's evaluation/commitments folder, found from this file so tests and the CLI agree.
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
export const commitmentsDir = (root = REPO_ROOT) => join(root, "evaluation", "commitments");
export const sourceOf = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const Revision = z.strictObject({ revision: z.number().int().min(1), hash: z.string().regex(/^[0-9a-f]{64}$/), reason: z.string().min(1).max(300), body: z.unknown() });
export const CommitmentFile = z.strictObject({ artifact: z.string().regex(/^[a-z0-9_-]+$/), revisions: z.array(Revision).min(1) });
export type CommitmentFile = z.infer<typeof CommitmentFile>;

export const readCommitment = (artifact: string, root = REPO_ROOT): CommitmentFile | null => {
  const file = join(commitmentsDir(root), `${artifact}.json`);
  return existsSync(file) ? CommitmentFile.parse(JSON.parse(readFileSync(file, "utf8"))) : null;
};

// The hash in force for one artifact: its last revision.
export const committedHash = (artifact: string, root = REPO_ROOT): string | null => readCommitment(artifact, root)?.revisions.at(-1)?.hash ?? null;

// Appends a revision when the body's hash differs from the last one; earlier revisions are never rewritten.
export function commit(artifact: string, body: unknown, reason: string, root = REPO_ROOT): { hash: string; appended: boolean } {
  const hash = hashJson(body);
  const cur = readCommitment(artifact, root);
  if (cur?.revisions.at(-1)?.hash === hash) return { hash, appended: false };
  const next: CommitmentFile = { artifact, revisions: [...(cur?.revisions ?? []), { revision: (cur?.revisions.length ?? 0) + 1, hash, reason, body }] };
  const file = join(commitmentsDir(root), `${artifact}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(CommitmentFile.parse(next), null, 1)}\n`);
  return { hash, appended: true };
}
