import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { CONTRACTS_SCHEMA_VERSION, Envelope, canonical, determinismView, hashJson, sealEnvelope, verifyChain, type StoreRef } from "@hey-pisgah/contracts";
import { syncDir, syncFd } from "./durable.js";
import { StoreError } from "./errors.js";
import { acquireLock, assertToken, releaseLock, type LockInfo } from "./lock.js";
import { streamPaths } from "./paths.js";

export type Clocks = { recorded_at: number; occurred_at: number };
export type AppendOptions = { schema_version?: number };

// Records the store itself writes; projections leave them out so recovery and takeover do not change domain state.
export const STORE_RECORD_TYPES: readonly string[] = ["store.recovered", "writer.takeover"];

export type ScanProblem = { at_seq: number; reason: "unparseable" | "wrong_stream" | "seq_gap" | "prev_hash_mismatch" | "hash_mismatch" };
export type Scan = { envelopes: Envelope[]; goodBytes: number; tailBytes: number; problem: ScanProblem | null };

// Parses every newline-terminated line and leaves an unterminated tail aside.
export function scanBytes(buf: Buffer, streamId: string): Scan {
  const lastNl = buf.lastIndexOf(0x0a);
  const goodBytes = lastNl + 1;
  const tailBytes = buf.length - goodBytes;
  const envelopes: Envelope[] = [];
  if (goodBytes === 0) return { envelopes, goodBytes, tailBytes, problem: null };
  const lines = buf.subarray(0, lastNl).toString("utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    let parsed: Envelope;
    try {
      parsed = Envelope.parse(JSON.parse(lines[i]!));
    } catch {
      return { envelopes, goodBytes, tailBytes, problem: { at_seq: i + 1, reason: "unparseable" } };
    }
    if (parsed.stream_id !== streamId) return { envelopes, goodBytes, tailBytes, problem: { at_seq: i + 1, reason: "wrong_stream" } };
    envelopes.push(parsed);
  }
  const chain = verifyChain(envelopes);
  if (!chain.ok) return { envelopes: envelopes.slice(0, chain.at), goodBytes, tailBytes, problem: { at_seq: chain.at + 1, reason: chain.reason } };
  return { envelopes, goodBytes, tailBytes, problem: null };
}

function readBytes(file: string): Buffer {
  return existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
}

export type OpenOptions = { writer?: boolean; now?: () => string };

export class Stream {
  private envelopes: Envelope[];
  private closed = false;

  private constructor(
    readonly root: string,
    readonly streamId: string,
    readonly writer: boolean,
    private readonly paths: ReturnType<typeof streamPaths>,
    private readonly fd: number | null,
    private readonly lock: LockInfo | null,
    private readonly now: () => string,
    initial: Envelope[]
  ) {
    this.envelopes = initial;
  }

  static open(root: string, streamId: string, opts: OpenOptions = {}): Stream {
    const paths = streamPaths(root, streamId);
    const now = opts.now ?? (() => new Date().toISOString());
    if (!opts.writer) {
      const scan = scanBytes(readBytes(paths.file), streamId);
      if (scan.problem) throw new StoreError("store_corrupt", "chain check failed; only the lock holder quarantines", { ...scan.problem, stream_id: streamId });
      return new Stream(root, streamId, false, paths, null, null, now, scan.envelopes);
    }
    mkdirSync(dirname(paths.file), { recursive: true });
    const { info, takenOver } = acquireLock(paths.lock);
    let fd: number | null = null;
    try {
      const created = !existsSync(paths.file);
      fd = openSync(paths.file, "a");
      if (created) syncDir(dirname(paths.file));
      const scan = scanBytes(readBytes(paths.file), streamId);
      if (scan.problem) {
        closeSync(fd);
        fd = null;
        let target = paths.quarantine;
        if (existsSync(target)) target = `${paths.quarantine}.${Date.now()}`;
        renameSync(paths.file, target);
        syncDir(dirname(paths.file));
        releaseLock(paths.lock, info.token);
        throw new StoreError("store_quarantined", "an earlier line failed the chain check", { ...scan.problem, stream_id: streamId, quarantine: target });
      }
      if (scan.tailBytes > 0) {
        ftruncateSync(fd, scan.goodBytes);
        syncFd(fd);
      }
      const s = new Stream(root, streamId, true, paths, fd, info, now, scan.envelopes);
      if (takenOver) s.appendInternal("writer.takeover", { previous: takenOver.previous, reason: takenOver.reason, pid: info.pid, hostname: info.hostname });
      if (scan.tailBytes > 0) s.appendInternal("store.recovered", { truncated_bytes: scan.tailBytes, last_good_seq: scan.envelopes.length });
      return s;
    } catch (e) {
      if (fd !== null) closeSync(fd);
      if (!(e instanceof StoreError && e.code === "store_quarantined")) releaseLock(paths.lock, info.token);
      throw e;
    }
  }

  get lockToken(): string | null {
    return this.lock?.token ?? null;
  }

  records(): readonly Envelope[] {
    return this.envelopes;
  }

  head(): { seq: number; hash: string } {
    const last = this.envelopes.at(-1);
    return { seq: last?.seq ?? 0, hash: last?.hash ?? "" };
  }

  ref(seq: number): StoreRef {
    return { stream_id: this.streamId, seq };
  }

  // A reader re-reads the file to see the writer's newer lines.
  refresh(): readonly Envelope[] {
    if (this.writer) return this.envelopes;
    const scan = scanBytes(readBytes(this.paths.file), this.streamId);
    if (scan.problem) throw new StoreError("store_corrupt", "chain check failed; only the lock holder quarantines", { ...scan.problem, stream_id: this.streamId });
    this.envelopes = scan.envelopes;
    return this.envelopes;
  }

  append(recordType: string, payload: unknown, clocks: Clocks, opts: AppendOptions = {}): Envelope {
    if (STORE_RECORD_TYPES.includes(recordType)) throw new StoreError("not_writer", `${recordType} is written by the store only`);
    return this.write(recordType, payload, clocks, opts.schema_version ?? CONTRACTS_SCHEMA_VERSION);
  }

  private appendInternal(recordType: string, payload: unknown): Envelope {
    const last = this.envelopes.at(-1);
    return this.write(recordType, payload, { recorded_at: last?.recorded_at ?? 0, occurred_at: last?.occurred_at ?? 0 }, CONTRACTS_SCHEMA_VERSION);
  }

  private write(recordType: string, payload: unknown, clocks: Clocks, schemaVersion: number): Envelope {
    if (this.closed) throw new StoreError("stream_closed", "stream is closed");
    if (!this.writer || this.fd === null || this.lock === null) throw new StoreError("not_writer", "stream was opened for reading");
    assertToken(this.paths.lock, this.lock.token);
    const head = this.head();
    const sealed = Envelope.parse(
      sealEnvelope({
        seq: head.seq + 1,
        stream_id: this.streamId,
        recorded_at: clocks.recorded_at,
        occurred_at: clocks.occurred_at,
        wall_at: this.now(),
        record_type: recordType,
        schema_version: schemaVersion,
        payload,
        prev_hash: head.hash
      })
    );
    const line = Buffer.from(`${canonical(sealed)}\n`, "utf8");
    try {
      let off = 0;
      while (off < line.length) off += writeSync(this.fd, line, off, line.length - off);
      syncFd(this.fd);
    } catch (e) {
      // A failed write may leave a half line, so this handle stops and the next open recovers it.
      this.close();
      throw e;
    }
    this.envelopes.push(sealed);
    return sealed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== null) closeSync(this.fd);
    if (this.lock) releaseLock(this.paths.lock, this.lock.token);
  }
}

export function openStream(root: string, streamId: string, opts: OpenOptions = {}): Stream {
  return Stream.open(root, streamId, opts);
}

export function readStream(root: string, streamId: string): readonly Envelope[] {
  return Stream.open(root, streamId).records();
}

// Hash of the determinism view of the domain records, the figure replay tests compare.
export function projectionHash(envelopes: readonly Envelope[], opts: { includeStoreRecords?: boolean } = {}): string {
  const kept = opts.includeStoreRecords ? envelopes : envelopes.filter((e) => !STORE_RECORD_TYPES.includes(e.record_type));
  return hashJson(kept.map(determinismView));
}
