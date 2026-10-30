import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadKeys } from "@hey-pisgah/model";
import { openStream } from "@hey-pisgah/store";
import { ASR_MODEL, VITALS_KEYWORDS, VoiceError, buildKeywords, transcribeWav } from "../src/index.js";
import { HINT_CONDITIONS, hintLines, type HintCondition } from "./hints.score.js";

// The keyword and language-bias test (research/voice-transcribe-questions section 4): the owner's real lines under each hint condition, every reading kept.
const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const dir = arg("clips"), out = arg("out"), runId = arg("run", "run-g9hints");
const conds = arg("conditions", HINT_CONDITIONS.map((c) => c.id).join(",")).split(",");
const runs = Number(arg("runs", "2"));
const key = loadKeys().MODEL_API_KEY ?? "";
const ledger = openStream(arg("store", ".hey-pisgah/g9/store"), `ledger/${runId}`, { writer: true });
const lines = hintLines().filter((l) => existsSync(join(dir, `${l.clip}.wav`)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function one(c: HintCondition, run: number, clip: string): Promise<void> {
  const wav = new Uint8Array(readFileSync(join(dir, `${clip}.wav`)));
  const keywords = c.hints ? buildKeywords({ vitals: VITALS_KEYWORDS, wards: [], documents: c.hints, staff: [], beds: [] }) : [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const t0 = performance.now();
    let row: Record<string, unknown>;
    try {
      const r = await transcribeWav({ wav, keywords, key, sessionId: `g9h-${c.id}-${run}-${clip}-${Date.now().toString(36)}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64), timeoutMs: 40_000, languageBias: c.bias });
      row = { cond: c.id, run, clip, attempt, raw: r.text, audio_ms: r.audio_ms, latency_ms: Math.round(performance.now() - t0), cost_usd: r.cost_usd, status: 200, error: null, voided: false };
    } catch (e) {
      const status = e instanceof VoiceError ? e.status : null;
      row = { cond: c.id, run, clip, attempt, raw: null, latency_ms: Math.round(performance.now() - t0), cost_usd: 0, status, error: e instanceof Error ? e.message.slice(0, 200) : String(e), voided: status === 429 };
    }
    ledger.append("reading.call", { provider: "meta", model: ASR_MODEL, purpose: "research_transcribe_hints", latency_ms: row["latency_ms"], cost_usd: row["cost_usd"], task_id: null, line_id: `${c.id}-${run}-${clip}`, error: row["error"], voided: row["voided"] }, { recorded_at: 0, occurred_at: 0 });
    appendFileSync(out, `${JSON.stringify(row)}\n`);
    if (row["status"] !== 429 && !(row["status"] === null && attempt === 0)) return;
    await sleep(2000 * 2 ** attempt);
  }
}

// Conditions alternate clip by clip so a slow minute on the service falls on every condition alike.
const jobs: [HintCondition, number, string][] = [];
for (let run = 0; run < runs; run++) for (const l of lines) for (const id of conds) jobs.push([HINT_CONDITIONS.find((c) => c.id === id)!, run, l.clip]);
let next = 0;
async function worker(): Promise<void> { while (next < jobs.length) { const [c, r, clip] = jobs[next++]!; await one(c, r, clip); } }
await Promise.all([worker(), worker(), worker()]);
ledger.close();
process.stderr.write(`${jobs.length} readings over ${lines.length} lines\n`);
