import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { percentile } from "@hey-pisgah/agent";

// Pools the G6 run files in G6_RUNS (one JSON per run) into evaluation/results/speed.json, per path and per switch setting.
type Run = {
  path: "vitals" | "orders"; ear: string; asr: string; transport: string; started_at: string; load_start: number[]; load_end?: number[];
  rows?: { ms: number }[]; lines_not_written?: number; lines_not_ordered?: number; values?: { wrong: number }; errors?: Record<string, number> | Record<string, number>[]; actions?: { state: string; reason: string | null }[];
  board?: { p50_ms: number | null }; usd?: number; calls?: number; parts_p50?: Record<string, number | null>;
  decided?: { ms: number[] }; lines_not_decided?: number; label?: string; release_whole?: boolean; speed_corrections?: number;
};
type OrderRow = { board_ms?: number | null; state?: string };

// Which Meta model reads or decides at each step, per setting; the local ears take a step away from Meta and this says which.
const STEPS: Record<string, { words: string; decides: string; numbers: string[] }> = {
  "spark/rest": { words: "Meta Voice Transcribe", decides: "Muse Spark Open", numbers: ["Muse Spark Open audio"] },
  "parakeet/rest": { words: "Meta Voice Transcribe", decides: "Muse Spark Open", numbers: ["local Parakeet TDT 0.6B v2"] },
  "spark/stream": { words: "local streaming Zipformer", decides: "Muse Spark Open", numbers: ["Muse Spark Open audio", "Meta Voice Transcribe"] },
  "parakeet/stream": { words: "local streaming Zipformer", decides: "Muse Spark Open", numbers: ["local Parakeet TDT 0.6B v2", "Meta Voice Transcribe"] },
  "spark/meta-stream": { words: "Meta Voice Transcribe realtime", decides: "Muse Spark Open", numbers: ["Muse Spark Open audio"] },
  "parakeet/meta-stream": { words: "Meta Voice Transcribe realtime", decides: "Muse Spark Open", numbers: ["local Parakeet TDT 0.6B v2"] }
};
// The lane whose harness made a run: G6's runs carry no label, G9's carry their arrival label.
const laneOf = (r: Run) => (r.label?.startsWith("G9") ? "G9" : "G6");
const metaCount = (s: { words: string; decides: string; numbers: string[] }, numbers: boolean) =>
  [s.words, s.decides, ...(numbers ? s.numbers : [])].filter((x) => !x.startsWith("local")).length;

function main(): void {
  const dirs = (process.env["G6_RUNS"] ?? "").split(",").filter(Boolean);
  if (!dirs.length) throw new Error("set G6_RUNS to the folder or folders of run files, comma separated");
  const dir = dirs[0]!;
  const out = process.env["G6_SPEED_OUT"] ?? join(process.cwd(), "evaluation", "results", "speed.json");
  const runs = dirs.flatMap((d) => readdirSync(d).filter((f) => /^g6-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(d, f), "utf8")) as Run)).filter((r) => r.rows || r.path === "orders");
  // A stream the realtime endpoint refused mid-run leaves a partial file named refused-*; it counts against its setting as every line said in it.
  const refused = dirs.flatMap((d) => readdirSync(d).filter((f) => /^refused-g6-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(d, f), "utf8")) as Run));
  const keyOf = (r: Run) => `${r.path}|${r.ear}/${r.asr}|${r.transport}|${laneOf(r)}|${r.release_whole ? "release" : "hold"}`;
  const groups = new Map<string, Run[]>();
  for (const r of runs) { const k = keyOf(r); groups.set(k, [...(groups.get(k) ?? []), r]); }
  const configs = [...groups.entries()].map(([k, rs]) => {
    const [path, setting, transport, lane, release] = k.split("|") as [string, string, string, string, string];
    const lost = refused.filter((r) => keyOf(r) === k).length;
    const board = rs.flatMap((r) => ((r as unknown as { rows?: OrderRow[] }).rows ?? []).map((x) => x.board_ms).filter((x): x is number => typeof x === "number"));
    // A vitals line is timed to the verified record; an order is timed to its decision, the step the ears change.
    const ms = path === "orders" ? rs.flatMap((r) => r.decided?.ms ?? []) : rs.flatMap((r) => (r.rows ?? []).map((x) => x.ms));
    const steps = STEPS[setting]!;
    return {
      path, lane, release_whole: release === "release", timed_to: path === "orders" ? "order decided" : "record verified", setting, ear: setting.split("/")[0], first_ear: setting.split("/")[1], transport, runs: rs.length, n: ms.length,
      p50_ms: percentile(ms, 50), p90_ms: percentile(ms, 90), max_ms: ms.length ? Math.max(...ms) : null,
      errors: {
        lines_not_done: rs.reduce((n, r) => n + Math.max(0, path === "orders" ? r.lines_not_decided ?? 0 : r.lines_not_written ?? 0), 0) + lost * (path === "vitals" ? 8 : 3),
        streams_refused: lost,
        wrong_values: rs.reduce((n, r) => n + (r.values?.wrong ?? 0), 0),
        readings_differ: rs.reduce((n, r) => n + (r.actions ?? []).filter((a) => a.reason === "readings_differ").length, 0),
        // The runtime's own counts of failed, refused and unverified writes.
        runtime: rs.reduce((n, r) => n + [r.errors ?? []].flat().reduce((m, e) => m + Object.values(e).reduce((a, b) => a + b, 0), 0), 0)
      },
      lines_said: (rs.length + lost) * (path === "vitals" ? 8 : 3), runs_refused: lost,
      corrections: rs.reduce((n, r) => n + (r.speed_corrections ?? 0), 0),
      parts_p50: path === "vitals" ? rs.map((r) => r.parts_p50 ?? null) : undefined,
      board_p50_ms: path === "orders" ? rs.map((r) => r.board?.p50_ms ?? null) : undefined,
      // From the end of the line to the order on the lab board, pooled over the runs; only orders that reached the board are timed.
      board: path === "orders" ? { n: board.length, of: rs.length * 3, p50_ms: percentile(board, 50), p90_ms: percentile(board, 90) } : undefined,
      usd: Math.round(rs.reduce((n, r) => n + (r.usd ?? 0), 0) * 1e4) / 1e4,
      meta: { words: steps.words, decides: steps.decides, numbers: path === "vitals" ? steps.numbers : [], meta_models_on_the_step: metaCount(steps, path === "vitals") },
      load_avg_1m: rs.map((r) => [r.load_start?.[0] ?? null, r.load_end?.[0] ?? null]),
      started: rs.map((r) => r.started_at)
    };
  }).sort((a, b) => (a.path + a.setting).localeCompare(b.path + b.setting));
  const pick = (path: string, setting: string, lane = "G6", release = false) => configs.find((c) => c.path === path && c.setting === setting && c.lane === lane && c.release_whole === release && (setting.endsWith("rest") || c.transport === "frames"));
  const d = pick("vitals", "spark/rest"), both = pick("vitals", "parakeet/stream"), od = pick("orders", "spark/rest"), os = pick("orders", "parakeet/stream");
  const errs = (c: (typeof configs)[number] | undefined) => (c ? c.errors.lines_not_done + c.errors.wrong_values + c.errors.runtime : null);
  // Each ear's own time on the eight vitals clips, with no gate, from the stage runs beside the speed runs.
  type Stage = { started_at: string; voice: string; stream_repair?: boolean; load_start: number[]; voice_transcribe: Record<string, unknown>; stream: Record<string, unknown>; parakeet: Record<string, unknown> };
  const keep = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== "rows"));
  const stages = readdirSync(dir).filter((f) => /^stages-g6-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Stage)
    .map((x) => ({ started: x.started_at, voice: x.voice, stream_repair: x.stream_repair ?? true, load_avg_1m: x.load_start[0] ?? null, voice_transcribe: keep(x.voice_transcribe), stream_words_after_speech: keep(x.stream), parakeet: keep(x.parakeet) }));
  // Meta's realtime ear on its own, the same eight clips, timed from the end of speech to the completed turn (G9).
  type MetaStage = { started_at: string; voice: string; load_start: number[]; turns: number; values_heard: number; after_speech: Record<string, unknown>; cost_usd: number };
  const metaStages = dirs.flatMap((d) => readdirSync(d).filter((f) => /^stages-g9-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(d, f), "utf8")) as MetaStage))
    .map((x) => ({ started: x.started_at, voice: x.voice, load_avg_1m: x.load_start[0] ?? null, turns: x.turns, values_heard: x.values_heard, after_speech: x.after_speech, cost_usd: x.cost_usd }));
  // The acceptance run's own fields are left out on purpose, so C-21 stays not measured until that run writes them.
  const result = {
    source: "Lane G6 and G9 integration runs on the sandbox EMR with synthetic voices; these are not the microphone-driven acceptance run.",
    measured_at: runs.map((r) => r.started_at).sort().at(-1) ?? null,
    floor_vitals_p50_ms: d?.p50_ms ?? null, floor_vitals_p90_ms: d?.p90_ms ?? null, floor_vitals_errors: errs(d),
    local_vitals_p50_ms: both?.p50_ms ?? null, local_vitals_p90_ms: both?.p90_ms ?? null, local_vitals_errors: errs(both),
    meta_vitals_p50_ms: pick("vitals", "spark/meta-stream", "G9")?.p50_ms ?? null, meta_vitals_p90_ms: pick("vitals", "spark/meta-stream", "G9")?.p90_ms ?? null, meta_vitals_errors: errs(pick("vitals", "spark/meta-stream", "G9")),
    meta_parakeet_vitals_p50_ms: pick("vitals", "parakeet/meta-stream", "G9")?.p50_ms ?? null, meta_parakeet_vitals_p90_ms: pick("vitals", "parakeet/meta-stream", "G9")?.p90_ms ?? null, meta_parakeet_vitals_errors: errs(pick("vitals", "parakeet/meta-stream", "G9")),
    floor_order_decided_p50_ms: od?.p50_ms ?? null, floor_order_decided_p90_ms: od?.p90_ms ?? null, local_order_decided_p50_ms: os?.p50_ms ?? null, local_order_decided_p90_ms: os?.p90_ms ?? null,
    orders_note: "Order lines are timed from the end of the line to the order being decided, and to the order on the lab board where it got there. G6's order runs predate G1's v2 voice tokens, so none of them reached the board; G9 reran every order setting after G1 merged, and those rows carry the board times.",
    switches: { HEY_PISGAH_EAR: "spark (default) or parakeet", HEY_PISGAH_ASR: "rest (default), stream or meta-stream", HEY_PISGAH_LANGUAGE_BIAS: "off (default) or 1", HEY_PISGAH_VT_READINGS: "1 (default) or more" },
    configs,
    stages,
    meta_realtime_stages: metaStages
  };
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${configs.length} settings from ${runs.length} runs -> ${out}\n`);
}

main();
