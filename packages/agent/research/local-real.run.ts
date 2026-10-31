import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { decodeWav, encodeWav } from "@hey-pisgah/voice";
import { hintLines, scoreCondition, type HintLine, type HintRow } from "../../voice/research/hints.score.js";
import type { ListenSessions, StreamSegment } from "../src/emr/listen.js";
import { localDirs, parakeetEar, sherpaStreamAsr } from "../src/emr/local-ears.js";
import { StreamListener } from "../src/emr/stream-listen.js";

// Scores the owner's real recordings through the three local ears beside the published no-hint Voice Transcribe row, with no network call and no transcript text in the output.
const arg = (k: string, env: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return (i > 0 ? process.argv[i + 1] : undefined) ?? process.env[env] ?? d; };
export const LOCAL_EARS = ["kroko_whole", "kroko_paced", "parakeet"] as const;
type EarId = (typeof LOCAL_EARS)[number];
type Ear = (wav: Uint8Array) => Promise<string>;

// The scorer refuses any ear that is not one of the local three, and any network call at all, so a paid ear can never be reached from here.
const asked = arg("ears", "HEY_PISGAH_LOCAL_EARS", LOCAL_EARS.join(",")).split(",").map((x) => x.trim()).filter(Boolean);
const refused = asked.filter((x) => !(LOCAL_EARS as readonly string[]).includes(x));
if (refused.length) { process.stderr.write(`refused: ${refused.join(", ")} is not a local ear; this scorer never calls a paid ear\n`); process.exit(2); }
globalThis.fetch = (() => { throw new Error("refused: the local scorer makes no network call"); }) as typeof fetch;

const realDir = arg("real", "HEY_PISGAH_REAL_DIR"), v2Dir = arg("v2", "HEY_PISGAH_REAL_V2_DIR");
const clips = resolve(arg("clips", "HEY_PISGAH_LOCAL_REAL_CLIPS", ".hey-pisgah/local-real/clips"));
const out = arg("out", "HEY_PISGAH_LOCAL_REAL_OUT", "evaluation/results/local-ears-real.json");
const rawOut = arg("raw", "HEY_PISGAH_LOCAL_REAL_RAW");
const models = localDirs(arg("models", "HEY_PISGAH_ASR_DIR", join(process.cwd(), ".hey-pisgah", "asr")));
const sherpaDir = arg("sherpa", "HEY_PISGAH_SHERPA_DIR") || undefined;
const threads = Number(arg("threads", "HEY_PISGAH_LOCAL_REAL_THREADS", "2"));
const repeat = Number(arg("repeat", "HEY_PISGAH_LOCAL_REAL_REPEAT", "5"));

// Rebuilds the clips with the G9 rebuild when they are not there yet; a failure is reported and whatever wavs exist are scored.
let rebuild: string | null = null;
if (!existsSync(join(clips, "clips.json"))) {
  if (!realDir || !v2Dir) rebuild = "no --real and --v2 recording folders given";
  else {
    try { execFileSync(process.execPath, ["--import", "tsx", "packages/voice/research/g9.clips.run.ts", "--real", realDir, "--v2", v2Dir, "--out", clips], { stdio: ["ignore", "ignore", "pipe"] }); }
    catch (e) { rebuild = `the clip rebuild stopped: ${(e as { stderr?: Buffer }).stderr?.toString().trim().split("\n").at(-1)?.slice(0, 160) ?? "unknown error"}`; }
  }
}
const manifest = existsSync(join(clips, "clips.json")) ? (JSON.parse(readFileSync(join(clips, "clips.json"), "utf8")) as Record<string, { ok: boolean }>) : {};
const all = hintLines();
const lines = all.filter((l) => existsSync(join(clips, `${l.clip}.wav`)));
const unscored = all.filter((l) => !lines.includes(l)).map((l) => l.clip);

// A stub listening chain that keeps each stretch's words, so the streaming ear runs exactly as the live frames path cuts it.
function pacedEar(asr: NonNullable<ReturnType<typeof sherpaStreamAsr>>): Ear {
  return async (wav) => {
    const { samples, sampleRate } = decodeWav(wav);
    const got: string[] = [];
    let clock = 0;
    const stub = { admit: () => ({}), segment: async (s: StreamSegment) => { got.push(s.raw); return []; }, nextWords: () => undefined, flush: async () => undefined, unreportedOf: () => ({ utterances: [], errors: [] }) } as unknown as ListenSessions;
    // The clock moves with the audio fed, so the words are what a live microphone would give with no wall-clock wait.
    const sl = new StreamListener(stub, asr, { now: () => clock });
    sl.open({ owner: "o", target: { admission_id: "a" }, session_id: "s", rate: sampleRate });
    const frame = Math.round((sampleRate * 20) / 1000);
    for (let i = 0; i < samples.length; i += frame) { const x = samples.subarray(i, i + frame); clock += (x.length / sampleRate) * 1000; sl.feed("s", x); }
    await sl.end("s");
    return got.join(" ").trim();
  };
}

function earOf(id: EarId): Ear | null {
  if (id === "parakeet") {
    const p = parakeetEar({ modelDir: models.parakeetDir, sherpaDir, threads });
    return p ? async (wav) => { const r = await p(wav, { run_id: null as unknown as string, task_id: "local-real", line_id: "local-real" }); if (r.provider !== "local" || r.cost_usd !== 0) throw new Error("refused: a reading that is not local"); return r.text; } : null;
  }
  const asr = sherpaStreamAsr({ modelDir: models.streamDir, sherpaDir, threads });
  if (!asr) return null;
  return id === "kroko_whole" ? async (wav) => (await asr.transcribe(wav, [], "local-real")).text : pacedEar(asr);
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const silent = encodeWav(new Float32Array(16_000 * 3), 16_000);
const wordsIn = (t: string) => t.split(/\s+/).filter(Boolean).length;
const ears: Record<string, unknown> = {};
const missing: string[] = [];
let audioMs = 0;
for (const l of lines) { const { samples, sampleRate } = decodeWav(new Uint8Array(readFileSync(join(clips, `${l.clip}.wav`)))); audioMs += (samples.length / sampleRate) * 1000; }
if (rawOut) { mkdirSync(dirname(rawOut), { recursive: true }); writeFileSync(rawOut, ""); }

for (const id of asked as EarId[]) {
  const ear = earOf(id);
  if (!ear) { missing.push(id); continue; }
  const rows: HintRow[] = [];
  let decodeMs = 0;
  for (const l of lines) {
    const wav = new Uint8Array(readFileSync(join(clips, `${l.clip}.wav`)));
    const t0 = performance.now();
    let raw: string | null = null;
    try { raw = await ear(wav); } catch { raw = null; }
    const ms = performance.now() - t0;
    decodeMs += ms;
    rows.push({ cond: id, run: 0, clip: l.clip, raw, voided: false, cost_usd: 0, latency_ms: Math.round(ms) });
    if (rawOut) appendFileSync(rawOut, `${JSON.stringify({ ear: id, clip: l.clip, raw })}\n`);
  }
  // A local decoder should give the same words twice; the first few clips are read again to show it.
  let same = 0;
  for (const r of rows.slice(0, repeat)) if ((await ear(new Uint8Array(readFileSync(join(clips, `${r.clip}.wav`))))) === r.raw) same += 1;
  const silence = await ear(silent);
  const score = (ls: readonly HintLine[]) => { const { top_misheard: _drop, ...s } = scoreCondition(rows, ls); return s; };
  ears[id] = {
    all: score(lines), r1b: score(lines.filter((l) => l.source === "r1b")), v2: score(lines.filter((l) => l.source === "v2")),
    failed: rows.filter((r) => r.raw === null).map((r) => r.clip), repeat: { clips: Math.min(repeat, rows.length), identical: same },
    silent_control: { audio_ms: 3000, words: wordsIn(silence) }, decode_ms: Math.round(decodeMs), real_time_factor: audioMs ? r4(decodeMs / audioMs) : null
  };
  const a = (ears[id] as { all: ReturnType<typeof score> }).all;
  process.stderr.write(`${id}: wer ${a.wer} values ${a.values.right}/${a.values.said} names ${a.names.heard}/${a.names.said} drugs ${a.drugs.heard}/${a.drugs.said} silent ${wordsIn(silence)} words\n`);
}

// The published no-hint Voice Transcribe row, carried beside the local ears as G9 scored it.
const g9 = JSON.parse(readFileSync("evaluation/results/transcribe-hints.json", "utf8")) as { conditions: { id: string; all: Record<string, unknown>; per_run: Record<string, unknown>[] }[] };
const vt = g9.conditions.find((c) => c.id === "none")!;
const brief = (s: Record<string, unknown>) => ({ readings: s["readings"], wer: s["wer"], values: s["values"], names: (s["names"] as { said: number; heard: number; recall: number }), drugs: (s["drugs"] as { said: number; heard: number; recall: number }) });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({
  generated_by: "packages/agent/research/local-real.run.ts", cost_usd: 0, network_calls: 0,
  ears: { kroko_whole: "Kroko streaming Zipformer, the whole clip decoded at once (the chunk path)", kroko_paced: "Kroko through the live frames listener, 20 ms frames, a stretch ended at 700 ms of quiet, stretches joined", parakeet: "Parakeet TDT 0.6B v2 int8, the whole clip (the second ear)" },
  reference: "the same lines and references as the Voice Transcribe hint test: R1.b words as said, v2 script words",
  lines: { total: all.length, scored: lines.length, unscored, hash_mismatches: Object.entries(manifest).filter(([, m]) => !m.ok).map(([k]) => k), rebuild_error: rebuild },
  audio_ms: Math.round(audioMs), models_missing: missing, results: ears,
  voice_transcribe_no_hints: { source: "evaluation/results/transcribe-hints.json", runs: vt.per_run.length, all: brief(vt.all), per_run: vt.per_run.map(brief) }
}, null, 1)}\n`);
