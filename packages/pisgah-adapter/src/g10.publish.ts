import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { percentile } from "@hey-pisgah/agent";

// Adds G10's strip runs (G10_RUNS, one JSON per run from g10/walk.mjs, void-* files left out) to evaluation/results/speed.json beside G6's and G9's rows.
type Action = { action_id: string; kind: string; state: string; summary?: string | null };
type SpeedRow = { action_id: string; ms: number; verified_at: string; released?: boolean; parts?: Record<string, number | null> };
type Task = { task_id: string; actions: Action[]; speed: { rows: SpeedRow[] } };
type Run = { tag: string; setup: { task_id: string }; file_zero: number; timeline: { lines: { text: string; end_ms: number }[] }; posts: { parts: number; chunks: number; partStatus: Record<string, number> }; health: { ears: { first_ear: string; second_ear: string } }; tasks: Task[] };

const WANT: [string, string][] = [["pulse", "116"], ["temp_c", "38.3"], ["resp_rate", "24"], ["bp", "104/62"], ["pulse", "112"], ["temp_c", "37.9"], ["resp_rate", "22"], ["pulse", "108"]];
const KEY: Record<string, string> = { pulse: "pulse", temperature: "temp_c", "respiratory rate": "resp_rate", "blood pressure": "bp" };

// Each said line matched to its one verified record: the serve's own time from the end of the line, and the wall time from the line's end in the microphone file.
function linesOf(r: Run) {
  const task = r.tasks.find((t) => t.task_id === r.setup.task_id)!;
  const speed = new Map(task.speed.rows.map((x) => [x.action_id, x]));
  const used = new Set<number>();
  const rows: { serve_ms: number; wall_ms: number; released: boolean }[] = [];
  let extra = 0;
  for (const a of task.actions.filter((x) => x.kind === "record_observation")) {
    const m = /(pulse|temperature|respiratory rate|blood pressure) ([\d./]+)/.exec(a.summary ?? "");
    const i = m ? WANT.findIndex((w, k) => w[0] === KEY[m[1]!] && w[1] === m[2] && !used.has(k)) : -1;
    const s = speed.get(a.action_id);
    if (i < 0 || a.state !== "completed" || !s) { extra += 1; continue; }
    used.add(i);
    rows.push({ serve_ms: s.ms, wall_ms: Math.round(Date.parse(s.verified_at) - (r.file_zero + r.timeline.lines[i]!.end_ms)), released: !!s.released });
  }
  return { rows, missing: WANT.length - used.size, extra };
}

function main(): void {
  const dir = process.env["G10_RUNS"];
  if (!dir) throw new Error("set G10_RUNS to the folder of G10 run files");
  const out = process.env["G10_SPEED_OUT"] ?? join(process.cwd(), "evaluation", "results", "speed.json");
  const runs = readdirSync(dir).filter((f) => /^(ms|st)-\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Run);
  const speed = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown> & { configs: Record<string, unknown>[] };
  speed.configs = speed.configs.filter((c) => c["lane"] !== "G10");
  for (const [prefix, first, name] of [["ms", "meta-stream", "strip_meta"], ["st", "stream", "strip_local"]] as const) {
    const rs = runs.filter((r) => r.tag.startsWith(`${prefix}-`));
    if (!rs.length) continue;
    const per = rs.map(linesOf);
    const rows = per.flatMap((p) => p.rows);
    const errors = per.reduce((n, p) => n + p.missing + p.extra, 0);
    const serve = rows.map((x) => x.serve_ms), wall = rows.map((x) => x.wall_ms);
    speed[`${name}_vitals_p50_ms`] = Math.round(percentile(serve, 50) ?? 0);
    speed[`${name}_vitals_p90_ms`] = Math.round(percentile(serve, 90) ?? 0);
    speed[`${name}_vitals_errors`] = errors;
    speed.configs.push({
      path: "vitals", lane: "G10", release_whole: true, timed_to: "record verified", setting: `parakeet/${first}`, ear: "parakeet", first_ear: first, transport: "strip frames (80 ms parts)",
      runs: rs.length, n: rows.length, p50_ms: Math.round(percentile(serve, 50) ?? 0), p90_ms: Math.round(percentile(serve, 90) ?? 0), max_ms: Math.max(...serve),
      wall_p50_ms: Math.round(percentile(wall, 50) ?? 0), wall_p90_ms: Math.round(percentile(wall, 90) ?? 0), released_rows: rows.filter((x) => x.released).length,
      errors: { lines_not_done: per.reduce((n, p) => n + p.missing, 0), extra_writes: per.reduce((n, p) => n + p.extra, 0) },
      parts_posted: rs.reduce((n, r) => n + r.posts.parts, 0), chunks_posted: rs.reduce((n, r) => n + r.posts.chunks, 0), first_ear_model: rs[0]!.health.ears.first_ear,
      runs_files: rs.map((r) => r.tag)
    });
  }
  speed["strip_note"] = "G10: the real strip in Chrome (headless, fake microphone playing the eight vitals lines at G6's 2.5 s spacing) sends 80 ms frames as numbered parts to the serve; timed by the serve from the captured end of the line to the verified record (p50_ms) and by the wall clock from the line's end in the microphone file (wall_p50_ms). Both local ears' second reading is Parakeet; D17's whole-number release is on, as in the serve.";
  writeFileSync(out, `${JSON.stringify(speed, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(speed.configs.filter((c) => c["lane"] === "G10"))}\n`);
}

main();
