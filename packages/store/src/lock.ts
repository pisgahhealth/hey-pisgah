import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { syncDir, syncFd } from "./durable.js";
import { StoreError } from "./errors.js";

export type LockInfo = { pid: number; process_start_time: string; hostname: string; token: string };

const startTimes = new Map<number, string | null>();

// Reads a process start time from ps so a reused pid cannot pass for the original holder.
export function processStartTime(pid: number): string | null {
  if (pid === process.pid && startTimes.has(pid)) return startTimes.get(pid)!;
  let out: string | null;
  try {
    out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim() || null;
  } catch {
    out = null;
  }
  if (pid === process.pid) startTimes.set(pid, out);
  return out;
}

// A pid is alive when signal 0 reaches it; EPERM means it exists under another user.
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(lockPath: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

function mine(): LockInfo {
  return { pid: process.pid, process_start_time: processStartTime(process.pid) ?? "unknown", hostname: hostname(), token: randomBytes(16).toString("hex") };
}

export type Acquired = { info: LockInfo; takenOver: { previous: LockInfo | null; reason: "holder_dead" | "pid_reused" | "unreadable_lock" } | null };

// Why a held lock may be taken over, or null when its holder still runs.
function staleReason(held: LockInfo | null): "holder_dead" | "pid_reused" | "unreadable_lock" | null {
  if (held === null) return "unreadable_lock";
  if (held.hostname !== hostname()) return null;
  if (!pidAlive(held.pid)) return "holder_dead";
  const now = processStartTime(held.pid);
  if (now !== null && held.process_start_time !== "unknown" && now !== held.process_start_time) return "pid_reused";
  return null;
}

// Creates the lock with O_EXCL; a stale lock is replaced by rename and then re-read to confirm the token.
export function acquireLock(lockPath: string): Acquired {
  const info = mine();
  const body = JSON.stringify(info);
  try {
    const fd = openSync(lockPath, "wx");
    try {
      writeSync(fd, body);
      syncFd(fd);
    } finally {
      closeSync(fd);
    }
    syncDir(dirname(lockPath));
    return { info, takenOver: null };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const held = readLock(lockPath);
  const reason = staleReason(held);
  if (reason === null) {
    throw new StoreError("store_locked", "another live writer holds this stream", { holder_pid: held?.pid, holder_host: held?.hostname });
  }
  const tmp = `${lockPath}.${info.token}.tmp`;
  const fd = openSync(tmp, "wx");
  try {
    writeSync(fd, body);
    syncFd(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, lockPath);
  syncDir(dirname(lockPath));
  if (readLock(lockPath)?.token !== info.token) {
    throw new StoreError("store_locked", "lost a takeover race to another writer");
  }
  return { info, takenOver: { previous: held, reason } };
}

export function assertToken(lockPath: string, token: string): void {
  if (readLock(lockPath)?.token !== token) throw new StoreError("store_lost_lock", "the lock no longer carries this writer's token");
}

export function releaseLock(lockPath: string, token: string): void {
  if (readLock(lockPath)?.token === token) unlinkSync(lockPath);
}
