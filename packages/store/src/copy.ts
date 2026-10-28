import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync, openSync, closeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { RunId, canonical } from "@hey-pisgah/contracts";
import { syncDir, syncFd } from "./durable.js";
import { StoreError } from "./errors.js";
import { assertAllowedPath } from "./paths.js";
import { readStream } from "./stream.js";

export type CopyOptions = { runsRoot?: string; allowedRoots?: readonly string[] };
export type RunCopy = { dir: string; streams: { stream_id: string; last_seq: number; head_hash: string }[] };

// Copies the validated lines of each stream into runs/<runId>/ once, by temp directory and rename.
export function copyForRun(root: string, runId: string, streamIds: readonly string[], opts: CopyOptions = {}): RunCopy {
  RunId.parse(runId);
  const runsRoot = resolve(opts.runsRoot ?? join(root, "..", "runs"));
  const allowed = opts.allowedRoots ?? [root, runsRoot];
  assertAllowedPath(allowed, root);
  const dest = assertAllowedPath(allowed, join(runsRoot, runId));
  if (existsSync(dest)) throw new StoreError("run_exists", "a run copy is written once", { run_id: runId });
  mkdirSync(runsRoot, { recursive: true });
  const tmp = join(runsRoot, `.${runId}.${randomBytes(6).toString("hex")}.tmp`);
  const streams: RunCopy["streams"] = [];
  for (const id of streamIds) {
    const envs = readStream(root, id);
    const file = join(tmp, `${id}.jsonl`);
    assertAllowedPath([tmp], file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, envs.map((e) => `${canonical(e)}\n`).join(""), { flag: "wx" });
    const fd = openSync(file, "r");
    try {
      syncFd(fd);
    } finally {
      closeSync(fd);
    }
    const last = envs.at(-1);
    streams.push({ stream_id: id, last_seq: last?.seq ?? 0, head_hash: last?.hash ?? "" });
  }
  renameSync(tmp, dest);
  syncDir(runsRoot);
  return { dir: dest, streams };
}

// Lists stream ids under one area, for example every run ledger.
export function listStreams(root: string, area: string): string[] {
  const dir = join(root, area);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => `${area}/${f.slice(0, -".jsonl".length)}`)
    .sort();
}
