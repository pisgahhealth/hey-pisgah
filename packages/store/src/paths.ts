import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { StreamId } from "@hey-pisgah/contracts";
import { StoreError } from "./errors.js";

// Resolves symlinks on the longest existing prefix so a link cannot smuggle a path outside a root.
function realish(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    tail.unshift(head.slice(up.length + 1));
    head = up;
  }
  return resolve(realpathSync(head), ...tail);
}

export function isInside(root: string, p: string): boolean {
  const rel = relative(realish(root), realish(p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Refuses any path that is not inside one of the configured roots.
export function assertAllowedPath(allowedRoots: readonly string[], p: string): string {
  if (!allowedRoots.some((r) => isInside(r, p))) {
    throw new StoreError("path_refused", "path is outside the configured roots", { path: p });
  }
  return resolve(p);
}

export function streamPaths(root: string, streamId: string): { file: string; lock: string; quarantine: string } {
  StreamId.parse(streamId);
  const base = resolve(root, streamId);
  assertAllowedPath([root], base);
  return { file: `${base}.jsonl`, lock: `${base}.lock`, quarantine: `${base}.jsonl.quarantine` };
}
