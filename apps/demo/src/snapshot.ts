import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_DIR, FIXTURE_NAME, type FixtureMeta } from "./lib/task-source.js";
import { readJsonl, repoRoot, type Env } from "./lib/paths.js";

// Copies one replayed task stream and its ledger into the demo's committed fixture, keeping only what the task view reads.
type P = Record<string, unknown>;
const DROP_PAYLOAD_KEYS = new Set(["intent_key", "args_hash", "user", "content"]);

function trim(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(trim);
  if (!v || typeof v !== "object") return v;
  const out: P = {};
  for (const [k, x] of Object.entries(v as P)) if (!DROP_PAYLOAD_KEYS.has(k)) out[k] = trim(x);
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const store = flag("store");
  const task = flag("task");
  if (!store || !task) throw new Error("usage: tsx apps/demo/src/snapshot.ts --store <dir> --task <task_id>");
  const root = repoRoot();
  const recs = readJsonl(join(store, "tasks", `${task}.jsonl`)) ?? [];
  const kept: Env[] = recs.filter((e) => e.record_type !== "tool.result").map((e) => ({
    seq: e.seq, record_type: e.record_type, occurred_at: e.occurred_at, recorded_at: e.recorded_at, payload: trim(e.payload) as P
  }));
  const opened = kept.find((e) => e.record_type === "task.opened");
  if (!opened) throw new Error("no task.opened record");
  const runId = String(opened.payload["run_id"]);
  const ledger = (readJsonl(join(store, "ledger", `${runId}.jsonl`)) ?? []).map((e) => e.payload);
  const meta: FixtureMeta = {
    name: FIXTURE_NAME, recorded_run: runId, mode: "replay", task_id: task,
    made_by: "HEY_PISGAH_MODE=replay npm run serve -- --once --recorded live-v1-2026-10-28 --store <scratch>, then this script"
  };
  const dir = join(root, ...FIXTURE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), `${JSON.stringify(kept, null, 1)}\n`);
  writeFileSync(join(dir, "ledger.json"), `${JSON.stringify(ledger, null, 1)}\n`);
  writeFileSync(join(dir, "source.json"), `${JSON.stringify(meta, null, 2)}\n`);
  process.stdout.write(`wrote ${kept.length} task records and ${ledger.length} ledger rows to ${dir}\n`);
}

main();
