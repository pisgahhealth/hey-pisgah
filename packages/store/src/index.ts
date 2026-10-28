// Package store: append-only JSONL streams with one writer, fsync per append, recovery and run copies.
export const PACKAGE = "store" as const;
export { StoreError, type StoreErrorCode } from "./errors.js";
export { assertAllowedPath, isInside, streamPaths } from "./paths.js";
export { acquireLock, pidAlive, processStartTime, readLock, type LockInfo } from "./lock.js";
export { syncDir, syncFd } from "./durable.js";
export { STORE_RECORD_TYPES, Stream, openStream, projectionHash, readStream, scanBytes, type AppendOptions, type Clocks, type OpenOptions, type Scan } from "./stream.js";
export { copyForRun, listStreams, type CopyOptions, type RunCopy } from "./copy.js";
