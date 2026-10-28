import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyChain } from "@hey-pisgah/contracts";
import { StoreError, copyForRun, listStreams, openStream, processStartTime, projectionHash, readStream } from "./index.js";

let dir: string;
let root: string;
const S = "tasks/t-abc12345";
const fileOf = (id: string) => join(root, `${id}.jsonl`);
const lockOf = (id: string) => join(root, `${id}.lock`);

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof StoreError) return e.code;
    throw e;
  }
  return "no_error";
}

function seed(n: number): string {
  const s = openStream(root, S, { writer: true });
  for (let i = 1; i <= n; i++) s.append("task.event", { i, note: `step ${i}` }, { recorded_at: i * 10, occurred_at: i * 10 - 1 });
  const h = projectionHash(s.records());
  s.close();
  return h;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hp-store-"));
  root = join(dir, "store");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("append and read", () => {
  it("chains records from seq 1 and a reader sees the same records", () => {
    const h = seed(3);
    const envs = readStream(root, S);
    expect(envs.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(envs[0]!.prev_hash).toBe("");
    expect(envs[1]!.prev_hash).toBe(envs[0]!.hash);
    expect(verifyChain(envs)).toEqual({ ok: true });
    expect(projectionHash(envs)).toBe(h);
    expect(existsSync(lockOf(S))).toBe(false);
  });

  it("keeps wall time inside the chain and outside the projection", () => {
    const a = openStream(join(dir, "a"), S, { writer: true, now: () => "2026-10-28T10:00:00.000Z" });
    const b = openStream(join(dir, "b"), S, { writer: true, now: () => "2026-10-29T11:00:00.000Z" });
    for (const s of [a, b]) s.append("task.event", { x: 1 }, { recorded_at: 5, occurred_at: 5 });
    expect(a.records()[0]!.hash).not.toBe(b.records()[0]!.hash);
    expect(projectionHash(a.records())).toBe(projectionHash(b.records()));
    a.close();
    b.close();
  });

  it("refuses store-only record types, bad record types and non-JSON payloads", () => {
    const s = openStream(root, S, { writer: true });
    expect(code(() => s.append("store.recovered", {}, { recorded_at: 0, occurred_at: 0 }))).toBe("not_writer");
    expect(() => s.append("Bad Type", {}, { recorded_at: 0, occurred_at: 0 })).toThrow();
    expect(() => s.append("task.event", { x: undefined }, { recorded_at: 0, occurred_at: 0 })).toThrow();
    expect(s.records()).toHaveLength(0);
    s.close();
    expect(code(() => s.append("task.event", {}, { recorded_at: 0, occurred_at: 0 }))).toBe("stream_closed");
  });

  it("a reader cannot append", () => {
    seed(1);
    const r = openStream(root, S);
    expect(code(() => r.append("task.event", {}, { recorded_at: 0, occurred_at: 0 }))).toBe("not_writer");
  });
});

describe("recovery", () => {
  it("an injected half line is ignored by readers, truncated by the writer and replay equals the pre-crash projection", () => {
    const pre = seed(3);
    const half = '{"hash":"ab","payload":{"i":4';
    appendFileSync(fileOf(S), half);
    expect(projectionHash(readStream(root, S))).toBe(pre);
    const w = openStream(root, S, { writer: true });
    const last = w.records().at(-1)!;
    expect(last.record_type).toBe("store.recovered");
    expect(last.payload).toEqual({ truncated_bytes: Buffer.byteLength(half), last_good_seq: 3 });
    expect(projectionHash(w.records())).toBe(pre);
    w.append("task.event", { i: 4 }, { recorded_at: 40, occurred_at: 40 });
    w.close();
    const after = readStream(root, S);
    expect(verifyChain(after)).toEqual({ ok: true });
    expect(after.map((e) => e.record_type)).toEqual(["task.event", "task.event", "task.event", "store.recovered", "task.event"]);
    expect(readFileSync(fileOf(S), "utf8").endsWith("\n")).toBe(true);
  });

  it("an edited clock fails chain validation, a reader throws and the writer quarantines", () => {
    seed(3);
    const lines = readFileSync(fileOf(S), "utf8").split("\n");
    const e2 = JSON.parse(lines[1]!);
    e2.recorded_at = 999;
    lines[1] = JSON.stringify(e2);
    writeFileSync(fileOf(S), lines.join("\n"));
    expect(code(() => readStream(root, S))).toBe("store_corrupt");
    let err: StoreError | undefined;
    try {
      openStream(root, S, { writer: true });
    } catch (e) {
      err = e as StoreError;
    }
    expect(err?.code).toBe("store_quarantined");
    expect(err?.detail).toMatchObject({ at_seq: 2, reason: "hash_mismatch" });
    expect(existsSync(fileOf(S))).toBe(false);
    expect(existsSync(`${fileOf(S)}.quarantine`)).toBe(true);
    expect(existsSync(lockOf(S))).toBe(false);
  });

  it("a missing middle line is a gap, never repaired silently", () => {
    seed(3);
    const lines = readFileSync(fileOf(S), "utf8").split("\n");
    writeFileSync(fileOf(S), [lines[0], lines[2], ""].join("\n"));
    expect(code(() => openStream(root, S, { writer: true }))).toBe("store_quarantined");
  });
});

describe("single writer", () => {
  it("a second writer is refused with store_locked", () => {
    const a = openStream(root, S, { writer: true });
    expect(code(() => openStream(root, S, { writer: true }))).toBe("store_locked");
    a.close();
    openStream(root, S, { writer: true }).close();
  });

  it("the writer rechecks its token before each append", () => {
    const a = openStream(root, S, { writer: true });
    a.append("task.event", {}, { recorded_at: 0, occurred_at: 0 });
    const lock = JSON.parse(readFileSync(lockOf(S), "utf8"));
    writeFileSync(lockOf(S), JSON.stringify({ ...lock, token: "someone-else" }));
    expect(code(() => a.append("task.event", {}, { recorded_at: 0, occurred_at: 0 }))).toBe("store_lost_lock");
    expect(readStream(root, S)).toHaveLength(1);
  });

  it("a dead-pid lock is taken over and the takeover is recorded", () => {
    seed(1);
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const dead = Number(child.stdout);
    const previous = { pid: dead, process_start_time: "Wed Oct 28 09:00:00 2026", hostname: hostname(), token: "dead" };
    writeFileSync(lockOf(S), JSON.stringify(previous));
    const w = openStream(root, S, { writer: true });
    const last = w.records().at(-1)!;
    expect(last.record_type).toBe("writer.takeover");
    expect(last.payload).toMatchObject({ previous, reason: "holder_dead", pid: process.pid });
    w.close();
  });

  it("a live-pid lock is not taken over, a reused pid is", async () => {
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const pid = sleeper.pid!;
      let start: string | null = null;
      for (let i = 0; i < 50 && !start; i++) {
        start = processStartTime(pid);
        if (!start) await new Promise((r) => setTimeout(r, 20));
      }
      expect(start).not.toBeNull();
      mkdirSync(join(root, "tasks"), { recursive: true });
      writeFileSync(lockOf(S), JSON.stringify({ pid, process_start_time: start, hostname: hostname(), token: "live" }));
      expect(code(() => openStream(root, S, { writer: true }))).toBe("store_locked");
      writeFileSync(lockOf(S), JSON.stringify({ pid, process_start_time: "Thu Jan  1 00:00:00 1970", hostname: hostname(), token: "reused" }));
      const w = openStream(root, S, { writer: true });
      expect(w.records().at(-1)!.payload).toMatchObject({ reason: "pid_reused" });
      w.close();
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("a lock from another host is never taken over", () => {
    seed(0);
    writeFileSync(lockOf(S), JSON.stringify({ pid: 1, process_start_time: "x", hostname: "elsewhere.invalid", token: "far" }));
    expect(code(() => openStream(root, S, { writer: true }))).toBe("store_locked");
  });
});

describe("fresh process", () => {
  const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
  const child = fileURLToPath(new URL("replay-child.test-helper.ts", import.meta.url));
  const run = (mode: string) => execFileSync(tsx, [child, root, S, mode], { encoding: "utf8" });

  it("replays to an identical projection hash and is refused as a second writer", () => {
    const h = seed(5);
    expect(run("reader")).toBe(h);
    const w = openStream(root, S, { writer: true });
    expect(run("writer")).toBe("store_locked");
    w.close();
    expect(run("writer")).toBe(h);
  });
});

describe("run copies", () => {
  it("copies validated lines once into runs/<run_id>/ and refuses paths outside the roots", () => {
    seed(2);
    const other = openStream(root, "learning/main", { writer: true });
    other.append("learning.note", { a: 1 }, { recorded_at: 0, occurred_at: 0 });
    other.close();
    appendFileSync(fileOf(S), '{"partial":');
    const copy = copyForRun(root, "run-aaaa1111", [S, "learning/main"]);
    expect(copy.dir).toBe(resolve(dir, "runs", "run-aaaa1111"));
    expect(copy.streams.map((s) => s.last_seq)).toEqual([2, 1]);
    const copied = readStream(copy.dir, S);
    expect(projectionHash(copied)).toBe(projectionHash(readStream(root, S)));
    expect(readFileSync(join(copy.dir, `${S}.jsonl`), "utf8").endsWith("\n")).toBe(true);
    expect(code(() => copyForRun(root, "run-aaaa1111", [S]))).toBe("run_exists");
    expect(code(() => copyForRun(root, "run-bbbb2222", [S], { allowedRoots: [join(dir, "runs")] }))).toBe("path_refused");
    expect(code(() => copyForRun(root, "run-cccc3333", [S], { runsRoot: join(dir, "reserved-runs"), allowedRoots: [root, join(dir, "runs")] }))).toBe("path_refused");
    expect(() => copyForRun(root, "run-dddd4444", ["../escape"])).toThrow();
    expect(() => copyForRun(root, "../x", [S])).toThrow();
    expect(listStreams(root, "tasks")).toEqual([S]);
  });
});
