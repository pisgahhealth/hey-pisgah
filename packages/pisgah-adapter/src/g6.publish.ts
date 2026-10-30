import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { percentile } from "@hey-pisgah/agent";

// Pools the G6 run files in G6_RUNS (one JSON per run) into evaluation/results/speed.json, per path and per switch setting.
type Run = {
  path: "vitals" | "orders"; ear: string; asr: string; transport: string; started_at: string; load_start: number[]; load_end?: number[];
  rows?: { ms: number }[]; lines_not_written?: number; lines_not_ordered?: number; values?: { wrong: number }; errors?: Record<string, number> | Record<string, number>[]; actions?: { state: string; reason: string | null }[];
  board?: { p50_ms: number | null }; usd?: number; calls?: number; parts_p50?: Record<string, number | null>;
  decided?: { ms: number[] }; lines_not_decided?: number;
};

// Which Meta model reads or decides at each step, per setting; the local ears take a step away from Meta and this says which.
const STEPS: Record<string, { words: string; decides: string; numbers: string[] }> = {
  "spark/rest": { words: "Meta Voice Transcribe", decides: "Muse Spark Open", numbers: ["Muse Spark Open audio"] },
  "parakeet/rest": { words: "Meta Voice Transcribe", decides: "Muse Spark Open", numbers: ["local Parakeet TDT 0.6B v2"] },
  "spark/stream": { words: "local streaming Zipformer", decides: "Muse Spark Open", numbers: ["Muse Spark Open audio", "Meta Voice Transcribe"] },
  "parakeet/stream": { words: "local streaming Zipformer", decides: "Muse Spark Open", numbers: ["local Parakeet TDT 0.6B v2", "Meta Voice Transcribe"] }
};
const metaCount = (s: { words: string; decides: string; numbers: string[] }, numbers: boolean) =>
  [s.words, s.decides, ...(numbers ? s.numbers : [])].filter((x) => !x.startsWith("local")).length;

function main(): void {
  const dir = process.env["G6_RUNS"];
  if (!dir) throw new Error("set G6_RUNS to the folder of G6 run files");
  const out = process.env["G6_SPEED_OUT"] ?? join(process.cwd(), "evaluation", "results", "speed.json");
  const runs = readdirSync(dir).filter((f) => /^g6-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Run).filter((r) => r.rows || r.path === "orders");
  const groups = new Map<string, Run[]>();
  for (const r of runs) { const k = `${r.path}|${r.ear}/${r.asr}|${r.transport}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const configs = [...groups.entries()].map(([k, rs]) => {
    const [path, setting, transport] = k.split("|") as [string, string, string];
    // A vitals line is timed to the verified record; an order is timed to its decision, the step the ears change.
    const ms = path === "orders" ? rs.flatMap((r) => r.decided?.ms ?? []) : rs.flatMap((r) => (r.rows ?? []).map((x) => x.ms));
    const steps = STEPS[setting]!;
    return {
      path, timed_to: path === "orders" ? "order decided" : "record verified", setting, ear: setting.split("/")[0], first_ear: setting.split("/")[1], transport, runs: rs.length, n: ms.length,
      p50_ms: percentile(ms, 50), p90_ms: percentile(ms, 90), max_ms: ms.length ? Math.max(...ms) : null,
      errors: {
        lines_not_done: rs.reduce((n, r) => n + (path === "orders" ? r.lines_not_decided ?? 0 : r.lines_not_written ?? 0), 0),
        wrong_values: rs.reduce((n, r) => n + (r.values?.wrong ?? 0), 0),
        readings_differ: rs.reduce((n, r) => n + (r.actions ?? []).filter((a) => a.reason === "readings_differ").length, 0),
        // The runtime's own counts of failed, refused and unverified writes.
        runtime: rs.reduce((n, r) => n + [r.errors ?? []].flat().reduce((m, e) => m + Object.values(e).reduce((a, b) => a + b, 0), 0), 0)
      },
      lines_said: rs.length * (path === "vitals" ? 8 : 3),
      parts_p50: path === "vitals" ? rs.map((r) => r.parts_p50 ?? null) : undefined,
      board_p50_ms: path === "orders" ? rs.map((r) => r.board?.p50_ms ?? null) : undefined,
      usd: Math.round(rs.reduce((n, r) => n + (r.usd ?? 0), 0) * 1e4) / 1e4,
      meta: { words: steps.words, decides: steps.decides, numbers: path === "vitals" ? steps.numbers : [], meta_models_on_the_step: metaCount(steps, path === "vitals") },
      load_avg_1m: rs.map((r) => [r.load_start?.[0] ?? null, r.load_end?.[0] ?? null]),
      started: rs.map((r) => r.started_at)
    };
  }).sort((a, b) => (a.path + a.setting).localeCompare(b.path + b.setting));
  const pick = (path: string, setting: string) => configs.find((c) => c.path === path && c.setting === setting && (setting.endsWith("rest") || c.transport === "frames"));
  const d = pick("vitals", "spark/rest"), both = pick("vitals", "parakeet/stream"), od = pick("orders", "spark/rest"), os = pick("orders", "parakeet/stream");
  const errs = (c: (typeof configs)[number] | undefined) => (c ? c.errors.lines_not_done + c.errors.wrong_values + c.errors.runtime : null);
  // Each ear's own time on the eight vitals clips, with no gate, from the stage runs beside the speed runs.
  type Stage = { started_at: string; voice: string; stream_repair?: boolean; load_start: number[]; voice_transcribe: Record<string, unknown>; stream: Record<string, unknown>; parakeet: Record<string, unknown> };
  const keep = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== "rows"));
  const stages = readdirSync(dir).filter((f) => /^stages-g6-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Stage)
    .map((x) => ({ started: x.started_at, voice: x.voice, stream_repair: x.stream_repair ?? true, load_avg_1m: x.load_start[0] ?? null, voice_transcribe: keep(x.voice_transcribe), stream_words_after_speech: keep(x.stream), parakeet: keep(x.parakeet) }));
  // The acceptance run's own fields are left out on purpose, so C-21 stays not measured until that run writes them.
  const result = {
    source: "Lane G6 integration runs on the sandbox EMR with synthetic voices; these are not the microphone-driven acceptance run.",
    measured_at: runs.map((r) => r.started_at).sort().at(-1) ?? null,
    floor_vitals_p50_ms: d?.p50_ms ?? null, floor_vitals_p90_ms: d?.p90_ms ?? null, floor_vitals_errors: errs(d),
    local_vitals_p50_ms: both?.p50_ms ?? null, local_vitals_p90_ms: both?.p90_ms ?? null, local_vitals_errors: errs(both),
    floor_order_decided_p50_ms: od?.p50_ms ?? null, floor_order_decided_p90_ms: od?.p90_ms ?? null, local_order_decided_p50_ms: os?.p50_ms ?? null, local_order_decided_p90_ms: os?.p90_ms ?? null,
    orders_note: "The order lines are timed from the end of the line to the order being decided. The hospital's voice match changed its token format during these runs, so every order was held for the owner's yes and none reached the lab board; board times wait for that change to land.",
    switches: { HEY_PISGAH_EAR: "spark (default) or parakeet", HEY_PISGAH_ASR: "rest (default) or stream" },
    configs,
    stages
  };
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${configs.length} settings from ${runs.length} runs -> ${out}\n`);
}

main();
