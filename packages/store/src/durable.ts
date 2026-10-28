import { closeSync, fsyncSync, openSync } from "node:fs";

// On darwin, Node's fs.fsyncSync goes through libuv uv__fs_fsync, which issues fcntl F_FULLFSYNC and falls back to F_BARRIERFSYNC, then fsync.
export function syncFd(fd: number): void {
  fsyncSync(fd);
}

// Syncs a directory entry after a create or rename; some filesystems refuse a directory fsync, which is tolerated.
export function syncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Directory sync is best effort on filesystems that reject it.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
