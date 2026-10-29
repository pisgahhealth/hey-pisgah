import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKeys } from "@hey-pisgah/model";
import { ASR_MODEL, VITALS_KEYWORDS, buildKeywords, cleanTranscript, transcribeWav, vitalsVocabulary } from "../src/index.js";

// Transcribes every WAV in a folder with Voice Transcribe, three at a time, one retry on a transport failure, and keeps the words only.
const [dir, out] = [process.argv[2]!, process.argv[3]!];
const files = readdirSync(dir).filter((f) => f.endsWith(".wav")).sort();
const key = loadKeys().MODEL_API_KEY ?? "";
const keywords = buildKeywords({ vitals: VITALS_KEYWORDS, wards: [], documents: [], staff: [], beds: [] });
const rows: Record<string, unknown> = {};
let next = 0;
async function one(f: string, attempt = 0): Promise<void> {
  const t0 = performance.now();
  try {
    const r = await transcribeWav({ wav: new Uint8Array(readFileSync(join(dir, f))), keywords, key, sessionId: `r1b-${f.replace(/[^A-Za-z0-9]/g, "")}-${Date.now().toString(36)}`.slice(0, 64), timeoutMs: 40_000 });
    rows[f] = { model: ASR_MODEL, raw: r.text, text: vitalsVocabulary(cleanTranscript(r.text)).text, audio_ms: r.audio_ms, latency_ms: Math.round(performance.now() - t0), cost_usd: r.cost_usd, retried: attempt > 0, error: null };
  } catch (e) {
    if (attempt === 0) return one(f, 1);
    rows[f] = { model: ASR_MODEL, raw: "", text: "", audio_ms: 0, latency_ms: Math.round(performance.now() - t0), cost_usd: 0, retried: true, error: e instanceof Error ? e.message : String(e) };
  }
}
async function worker(): Promise<void> { while (next < files.length) await one(files[next++]!); }
await Promise.all([worker(), worker(), worker()]);
writeFileSync(out, `${JSON.stringify(Object.fromEntries(Object.entries(rows).sort()), null, 1)}\n`);
process.stderr.write(`${files.length} files, ${Object.values(rows).filter((r) => (r as { error: unknown }).error).length} errors\n`);
