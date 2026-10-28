import { join } from "node:path";
import { stepLabels } from "./labels.js";
import { summarizeLedger, type FooterModel, type LedgerRow, type RunMode } from "./ledger.js";
import { readJson, readJsonl, type Env } from "./paths.js";
import { foldTask, type TaskView } from "./task.js";

export const FIXTURE_NAME = "live-v1-2026-10-28";
export const FIXTURE_DIR = ["apps", "demo", "fixtures", "replay", FIXTURE_NAME] as const;
export const DEFAULT_SERVE_URL = process.env["HEY_PISGAH_SERVE_URL"] ?? "http://127.0.0.1:4317";
// The live run's own goal and owner, so a replay serve finds every recorded response.
export const DEMO_TASK = { case_id: "c-agent001", goal: "Complete the discharge paperwork for this patient.", owner: "nurse n-a1" } as const;

export type SourceInfo =
  | { kind: "serve"; url: string; mode: string; store: string; stream_found: boolean }
  | { kind: "fixture"; name: string; recorded_run: string; made_by: string };
export type TaskSummary = { task_id: string; case_id: string; state: string; reason: string | null };
export type TaskPage = { source: SourceInfo; view: TaskView | null; footer: FooterModel; tasks: TaskSummary[]; serve_error: string | null };
export type FixtureMeta = { name: string; recorded_run: string; mode: RunMode; made_by: string; task_id: string };

type Status = { state: string; reason: string | null; unmet: string[]; conditions?: { condition_id: string; met: boolean }[] };

export function storeRoot(root: string): string {
  return process.env["HEY_PISGAH_STORE"] ?? join(root, ".hey-pisgah", "store");
}

async function getJson(url: string, ms = 800): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status} from ${url}`);
  return r.json();
}

export function loadFixture(root: string): { meta: FixtureMeta; records: Env[]; ledger: LedgerRow[] } {
  const dir = join(root, ...FIXTURE_DIR);
  return { meta: readJson(join(dir, "source.json")) as FixtureMeta, records: readJson(join(dir, "task.json")) as Env[], ledger: readJson(join(dir, "ledger.json")) as LedgerRow[] };
}

function fromFixture(root: string, serveError: string | null): TaskPage {
  const f = loadFixture(root);
  const view = foldTask(f.records, stepLabels(root));
  return {
    source: { kind: "fixture", name: f.meta.name, recorded_run: f.meta.recorded_run, made_by: f.meta.made_by },
    view, footer: summarizeLedger(f.ledger, f.meta.mode), tasks: [{ task_id: view.task_id, case_id: view.case_id, state: view.state, reason: view.reason }], serve_error: serveError
  };
}

// Reads the task from a running serve and its store, read only; falls back to the committed replay when serve is not up.
export async function loadTaskPage(root: string, opts: { taskId?: string | null; source?: "serve" | "fixture"; serveUrl?: string } = {}): Promise<TaskPage> {
  const SERVE_URL = opts.serveUrl ?? DEFAULT_SERVE_URL;
  const want = opts.source ?? (process.env["HEY_PISGAH_DEMO_SOURCE"] === "fixture" ? "fixture" : "serve");
  if (want === "fixture") return fromFixture(root, null);
  let health: { mode?: string };
  try { health = (await getJson(`${SERVE_URL}/health`)) as { mode?: string }; } catch (e) {
    return fromFixture(root, e instanceof Error ? e.message.slice(0, 200) : "serve not reachable");
  }
  const store = storeRoot(root);
  const tasks = (await getJson(`${SERVE_URL}/tasks`)) as TaskSummary[];
  const id = opts.taskId && tasks.some((t) => t.task_id === opts.taskId) ? opts.taskId : tasks.at(-1)?.task_id ?? null;
  const base = { kind: "serve" as const, url: SERVE_URL, mode: String(health.mode ?? "unknown"), store };
  if (!id) return { source: { ...base, stream_found: false }, view: null, footer: summarizeLedger([], (health.mode as RunMode | undefined) ?? null), tasks, serve_error: null };
  const status = (await getJson(`${SERVE_URL}/tasks/${encodeURIComponent(id)}`)) as Status;
  const records = readJsonl(join(store, "tasks", `${id}.jsonl`));
  let view: TaskView | null = null;
  let ledger: LedgerRow[] = [];
  if (records && records.length) {
    view = foldTask(records, stepLabels(root));
    view.state = status.state as TaskView["state"];
    view.reason = status.reason;
    view.unmet = status.unmet;
    const met = new Map((status.conditions ?? []).map((c) => [c.condition_id, c.met]));
    for (const c of view.conditions) c.met = met.get(c.condition_id) ?? c.met;
    ledger = ((readJsonl(join(store, "ledger", `${view.run_id}.jsonl`)) ?? []).map((e) => e.payload)) as unknown as LedgerRow[];
  }
  return { source: { ...base, stream_found: !!records }, view, footer: summarizeLedger(ledger, (health.mode as RunMode | undefined) ?? null), tasks, serve_error: null };
}
