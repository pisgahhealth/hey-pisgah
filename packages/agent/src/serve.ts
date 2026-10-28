import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CaseId, StreamId } from "@hey-pisgah/contracts";
import { loadV1, worldRules } from "@hey-pisgah/hospital";
import { ModelClient, type EffortLevel, type Mode, type ProviderId } from "@hey-pisgah/model";
import { STORE_RECORD_TYPES, openStream, type Stream } from "@hey-pisgah/store";
import type { WorldRules } from "@hey-pisgah/simulator";
import { Registry } from "@hey-pisgah/workflow";
import { FIXTURE_CASES_DIR, loadCases } from "./cases.js";
import { scriptedAgent } from "./mock.js";
import { AgentRuntime } from "./runtime.js";
import { VersionDesk, VersionError } from "./versions.js";

export const AGENT_RECORDINGS_DIR = new URL("../fixtures/recordings/", import.meta.url).pathname;
export const RECORDED_DIR = new URL("../fixtures/recorded/", import.meta.url).pathname;

// A frozen live run: the definition and case world it used, replayed with no world rules.
export function recordedWorld(name: string): { registry: Registry; casesDir: string; world: null } {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("recorded run names are lower-case words and dashes");
  const dir = join(RECORDED_DIR, name);
  return { registry: Registry.load([JSON.parse(readFileSync(join(dir, "v1.json"), "utf8"))]), casesDir: join(dir, "cases"), world: null };
}
export const LEARNING_STREAM = "learning/main";

export type ServeOptions = {
  storeRoot: string;
  casesDir?: string;
  host?: string;
  port?: number;
  mode?: Mode;
  clock?: "auto" | "manual";
  pollMs?: number;
  provider?: ProviderId;
  model?: string;
  effort?: EffortLevel;
  recordingsDir?: string;
  // Defaults to the adopted hospital v1 and the hospital's world rules.
  registry?: Registry;
  world?: WorldRules | null;
  log?: (line: string) => void;
};
export type Serve = { url: string; runtime: AgentRuntime; client: ModelClient; learning: Stream; versions: VersionDesk; close: () => Promise<void> };

const OpenTask = z.strictObject({ case_id: CaseId, goal: z.string().min(1).max(500), owner: z.string().min(1).max(80), budget: z.strictObject({ max_calls: z.number().int().min(1).max(500), max_usd: z.number().min(0).max(5) }).optional() });
const Input = z.strictObject({ text: z.string().min(1).max(500), by: z.string().min(1).max(80) });
const Cancel = z.strictObject({ by: z.string().min(1).max(80) });
const Clock = z.strictObject({ to: z.number().int().min(0).max(2880) });
const Person = z.strictObject({ kind: z.string().min(1).max(40), staff_id: z.string().min(1).max(80), role: z.string().min(1).max(40), display_name: z.string().min(1).max(120) });
const Adopt = z.strictObject({ proposal_id: z.string().min(1).max(80), approver: Person, at_minute: z.number().int().min(0).max(2880).optional() });
const Standing = z.strictObject({ by: Person, reason: z.string().min(1).max(300), at_minute: z.number().int().min(0).max(2880).optional(), proposal: z.strictObject({ task_id: z.string().min(1).max(80), proposal_id: z.string().min(1).max(80) }).optional() });
const Confirm = z.strictObject({ by: z.strictObject({ kind: z.string().min(1).max(40), staff_id: z.string().min(1).max(80), role: z.string().min(1).max(40) }) });
const Learning = z.strictObject({ record_type: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/), payload: z.json() });

async function body(req: IncomingMessage): Promise<unknown> {
  let n = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > 64 * 1024) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "body is not JSON"); }
}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; "));
  return r.data;
}

// The one long-lived process that owns the tasks and learning streams; the app and the CLI post to it and never write the store.
export async function startServe(o: ServeOptions): Promise<Serve> {
  const learning = openStream(o.storeRoot, LEARNING_STREAM, { writer: true });
  StreamId.parse(LEARNING_STREAM);
  const cases = loadCases(o.casesDir ?? FIXTURE_CASES_DIR);
  let runtime: AgentRuntime | null = null;
  const client = new ModelClient({
    storeRoot: o.storeRoot, ...(o.mode ? { mode: o.mode } : {}), recordingsDir: o.recordingsDir ?? AGENT_RECORDINGS_DIR, mock: scriptedAgent(),
    taskStateOf: (id) => runtime?.stateOf(id) ?? null
  });
  const versions = new VersionDesk(o.storeRoot, o.registry ?? Registry.load([loadV1()]));
  const rt = new AgentRuntime({
    storeRoot: o.storeRoot, client, cases, registry: versions.registry, world: o.world === undefined ? worldRules() : o.world, clock: o.clock ?? "auto", pollMs: o.pollMs ?? 250,
    ...(o.provider ? { provider: o.provider } : {}), ...(o.model ? { model: o.model } : {}), ...(o.effort ? { effort: o.effort } : {}), ...(o.log ? { log: o.log } : {})
  });
  runtime = rt;
  rt.start();

  const route = async (req: IncomingMessage): Promise<[number, unknown]> => {
    const url = new URL(req.url ?? "/", "http://serve");
    const parts = url.pathname.split("/").filter(Boolean);
    const m = req.method ?? "GET";
    const task = (id: string) => { if (!rt.taskIds().includes(id)) throw new HttpError(404, "unknown task"); return id; };
    const kase = (id: string) => { if (!cases.has(id)) throw new HttpError(404, "unknown case"); return rt.portFor(id); };
    if (m === "GET" && url.pathname === "/health") return [200, { ok: true, mode: client.mode, tasks: rt.taskIds().length }];
    if (parts[0] === "tasks") {
      if (parts.length === 1 && m === "GET") return [200, rt.taskIds().map((id) => { const p = rt.projection(id); return { task_id: id, case_id: p.case_id, state: p.state, reason: p.reason }; })];
      if (parts.length === 1 && m === "POST") {
        const b = parse(OpenTask, await body(req));
        if (!cases.has(b.case_id)) throw new HttpError(404, "unknown case");
        return [201, { task_id: rt.openTask(b.budget ? { case_id: b.case_id, goal: b.goal, owner: b.owner, budget: b.budget } : { case_id: b.case_id, goal: b.goal, owner: b.owner }) }];
      }
      if (parts.length === 2 && m === "GET") return [200, rt.status(task(parts[1]!))];
      if (parts.length === 3 && parts[2] === "cancel" && m === "POST") { const b = parse(Cancel, await body(req)); return [rt.cancel(task(parts[1]!), b.by) ? 200 : 409, { ok: true }]; }
      if (parts.length === 3 && parts[2] === "input" && m === "POST") { const b = parse(Input, await body(req)); return rt.resume(task(parts[1]!), b.text, b.by) ? [200, { ok: true }] : [409, { error: "the task is not waiting for a person" }]; }
    }
    if (parts[0] === "cases") {
      if (parts.length === 1 && m === "GET") return [200, [...cases.keys()].sort()];
      if (parts.length === 3 && parts[2] === "clock" && m === "GET") { const p = kase(parts[1]!); return [200, { now: p.now(), horizon: p.horizon }]; }
      if (parts.length === 3 && parts[2] === "clock" && m === "POST") {
        if ((o.clock ?? "auto") !== "manual") throw new HttpError(409, "the clock moves on its own in auto mode");
        const b = parse(Clock, await body(req));
        const p = kase(parts[1]!);
        if (b.to < p.now()) throw new HttpError(409, "the clock never moves back");
        p.advanceTo(b.to);
        return [200, { now: p.now() }];
      }
    }
    if (parts[0] === "versions") {
      // Standing changes are a person's decision: the route refuses and counts any other requester; no agent tool reaches it.
      const standing = async (f: () => unknown, okStatus = 200): Promise<[number, unknown]> => {
        try { return [okStatus, f()]; } catch (e) {
          if (!(e instanceof VersionError)) throw e;
          const status = e.code === "requires_person" ? 403 : e.code === "unknown_proposal" || e.code === "unknown_version" ? 404 : 409;
          return [status, { error: e.code, message: e.message.slice(0, 300) }];
        }
      };
      if (parts.length === 1 && m === "GET") return [200, { versions: versions.registry.list(), log: versions.records(), refused: versions.refusedCount() }];
      if (parts.length === 2 && parts[1] === "adopt" && m === "POST") {
        const b = parse(Adopt, await body(req));
        return standing(() => { const d = versions.adopt(b.proposal_id, b.approver, b.at_minute ?? 0); return { version: d.version, status: d.status, definition_hash: d.definition_hash, scope: d.scope, fallback_version: d.fallback_version }; }, 201);
      }
      if (parts.length === 3 && (parts[2] === "suspend" || parts[2] === "revert") && m === "POST") {
        const v = Number(parts[1]);
        if (!Number.isInteger(v) || v < 1) throw new HttpError(404, "unknown version");
        const b = parse(Standing, await body(req));
        if (parts[2] === "suspend" && b.proposal) {
          const t = task(b.proposal.task_id);
          if (!rt.projection(t).monitor.proposals.some((x) => x.proposal_id === b.proposal!.proposal_id && x.kind === "suspension" && x.version === v)) throw new HttpError(404, "no such suspension proposal on that task");
        }
        return standing(() => {
          const d = parts[2] === "suspend" ? versions.suspend(v, b.by, b.reason, b.at_minute ?? 0, b.proposal ?? null) : versions.revert(v, b.by, b.reason, b.at_minute ?? 0);
          return { version: d.version, status: d.status };
        });
      }
    }
    if (parts[0] === "cases" && parts.length === 5 && parts[2] === "exceptions" && parts[4] === "confirm" && m === "POST") {
      const b = parse(Confirm, await body(req));
      const r = kase(parts[1]!).confirmException(parts[3]!, b.by);
      return r.ok ? [200, { ok: true }] : [r.reason === "confirmation_requires_person" ? 403 : r.reason === "unknown_id" ? 404 : 409, { error: r.reason }];
    }
    if (m === "POST" && url.pathname === "/learning") {
      const b = parse(Learning, await body(req));
      if (STORE_RECORD_TYPES.includes(b.record_type)) throw new HttpError(400, "that record type belongs to the store");
      const e = learning.append(b.record_type, b.payload, { recorded_at: 0, occurred_at: 0 });
      return [201, { stream_id: e.stream_id, seq: e.seq }];
    }
    throw new HttpError(404, "no such route");
  };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    route(req).then(([status, payload]) => send(res, status, payload)).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      send(res, status, { error: e instanceof Error ? e.message.slice(0, 300) : "error" });
    });
  };
  const server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(o.port ?? 4317, o.host ?? "127.0.0.1", r));
  const addr = server.address();
  const url = typeof addr === "object" && addr ? `http://${o.host ?? "127.0.0.1"}:${addr.port}` : "";
  return {
    url, runtime: rt, client, learning, versions,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await rt.stop();
      client.close();
      learning.close();
      versions.close();
    }
  };
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

// The CLI entry: `serve` keeps running; `serve --once --case <id>` runs one task to a settled state, prints its summary and exits.
export async function serveCommand(repoRoot: string, args: string[]): Promise<number | null> {
  const storeRoot = flag(args, "store") ?? join(repoRoot, ".hey-pisgah", "store");
  const once = args.includes("--once");
  const clock = (flag(args, "clock") ?? "auto") as "auto" | "manual";
  const recorded = flag(args, "recorded");
  const s = await startServe({
    ...(recorded ? recordedWorld(recorded) : {}),
    storeRoot, clock, port: Number(flag(args, "port") ?? (once ? 0 : process.env["HEY_PISGAH_SERVE_PORT"] ?? 4317)),
    pollMs: Number(flag(args, "poll-ms") ?? 250), log: (l) => process.stderr.write(`${l}\n`),
    ...(flag(args, "cases") ? { casesDir: flag(args, "cases")! } : {})
  });
  if (!once) {
    process.stdout.write(`serve listening on ${s.url} (mode ${s.client.mode}, store ${storeRoot})\n`);
    const stop = () => { void s.close().then(() => process.exit(0)); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return null;
  }
  const caseId = flag(args, "case") ?? "c-agent001";
  const id = s.runtime.openTask({ case_id: caseId, goal: flag(args, "goal") ?? "Complete the discharge paperwork for this patient.", owner: flag(args, "owner") ?? "nurse n-a1" });
  await s.runtime.settled(Number(flag(args, "timeout-ms") ?? 900_000));
  const st = s.runtime.status(id) as { state: string; reason: string | null; unmet: string[]; counts: Record<string, number>; budget: Record<string, number>; closed: Record<string, unknown> | null };
  process.stdout.write(`${JSON.stringify({ task_id: id, state: st.state, reason: st.reason, unmet: st.unmet, counts: st.counts, budget: st.budget, effect_set_hash: st.closed?.["effect_set_hash"] ?? null, run_id: s.runtime.projection(id).run_id })}\n`);
  await s.close();
  return st.state === "done" ? 0 : 1;
}
