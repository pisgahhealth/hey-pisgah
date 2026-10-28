import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashJson } from "@hey-pisgah/contracts";
import { SETTINGS } from "./loop.js";
import { ARMS, armHashes } from "./prompts.js";
import type { Arm } from "./session.js";

export type CommitmentContent = { arms: Record<Arm, { prompt: string; tools: string }>; settings: typeof SETTINGS; insufficient_evidence_default: false };
export type CommitmentRevision = { revision: number; at: string; reason: string; content: CommitmentContent; hash: string };
export type CommitmentsFile = { artifact: "intelligence"; revisions: CommitmentRevision[] };

export const commitmentsPath = (root: string): string => join(root, "evaluation", "commitments", "intelligence.json");

export function currentContent(): CommitmentContent {
  return { arms: Object.fromEntries(ARMS.map((a) => [a, armHashes(a)])) as CommitmentContent["arms"], settings: SETTINGS, insufficient_evidence_default: false };
}

export function readCommitments(root: string): CommitmentsFile | null {
  const p = commitmentsPath(root);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CommitmentsFile) : null;
}

// The newest revision whose hashes equal the code's, for one arm; a live run needs one.
export function commitmentFor(root: string, arm: Arm): { revision: number; hash: string } | null {
  const f = readCommitments(root);
  const cur = currentContent();
  const last = f?.revisions.at(-1);
  if (!last) return null;
  const same = last.content.arms[arm]?.prompt === cur.arms[arm].prompt && last.content.arms[arm]?.tools === cur.arms[arm].tools && hashJson(last.content.settings) === hashJson(cur.settings);
  return same ? { revision: last.revision, hash: last.hash } : null;
}

// Earlier revisions must survive unchanged, every revision carries a reason, and numbers count up from 1.
export function appendOnlyProblems(prev: CommitmentsFile | null, next: CommitmentsFile): string[] {
  const out: string[] = [];
  next.revisions.forEach((r, i) => {
    if (r.revision !== i + 1) out.push(`revision ${i + 1} is numbered ${r.revision}`);
    if (!r.reason.trim()) out.push(`revision ${r.revision} has no reason`);
    if (r.hash !== hashJson({ revision: r.revision, at: r.at, reason: r.reason, content: r.content })) out.push(`revision ${r.revision} hash does not match`);
  });
  for (const [i, r] of (prev?.revisions ?? []).entries()) if (hashJson(next.revisions[i] ?? null) !== hashJson(r)) out.push(`revision ${r.revision} was changed or removed`);
  return out;
}

export function appendCommitment(root: string, reason: string, at = new Date()): CommitmentRevision {
  if (!reason.trim()) throw new Error("a commitment revision needs a reason");
  const prev = readCommitments(root);
  const content = currentContent();
  const last = prev?.revisions.at(-1);
  if (last && hashJson(last.content) === hashJson(content)) throw new Error("the code already matches the last revision");
  const base = { revision: (last?.revision ?? 0) + 1, at: at.toISOString(), reason: reason.trim(), content };
  const rev: CommitmentRevision = { ...base, hash: hashJson(base) };
  const next: CommitmentsFile = { artifact: "intelligence", revisions: [...(prev?.revisions ?? []), rev] };
  const problems = appendOnlyProblems(prev, next);
  if (problems.length) throw new Error(problems.join("; "));
  const p = commitmentsPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(`${p}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
  return rev;
}
