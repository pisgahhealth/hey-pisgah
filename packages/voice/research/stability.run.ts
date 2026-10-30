import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadKeys } from "@hey-pisgah/model";
import { openStream } from "@hey-pisgah/store";
import { ASR_MODEL, VITALS_KEYWORDS, VoiceError, buildKeywords, requestPart, transcribeWithTurns } from "../src/index.js";

// The instability probe (research/voice-transcribe-questions section 2): the same bytes and request part sent again and again, every reply kept whole.
const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const dir = arg("clips"), out = arg("out"), store = arg("store", ".hey-pisgah/g9/store"), runId = arg("run", "run-g9probe");
const arms = arg("arms", "A1,A2,D,B").split(",");
const ids = arg("ids").split(",").filter(Boolean);
const key = loadKeys().MODEL_API_KEY ?? "";
const HINTS = buildKeywords({ vitals: VITALS_KEYWORDS, wards: [], documents: [], staff: [], beds: [] });
const ledger = openStream(store, `ledger/${runId}`, { writer: true });
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
mkdirSync(join(out, ".."), { recursive: true });

const PLAN: Record<string, { calls: number; hints: boolean; session: "fresh" | "fixed"; together: boolean }> = {
  A1: { calls: 5, hints: true, session: "fresh", together: false },
  A2: { calls: 5, hints: true, session: "fixed", together: false },
  D: { calls: 5, hints: true, session: "fresh", together: true },
  B: { calls: 3, hints: false, session: "fresh", together: false },
  E: { calls: 2, hints: true, session: "fresh", together: false }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One call; a 429 is voided, listed, and tried again after a pause, since a rate-limited request is never billed.
async function call(id: string, wav: Uint8Array, arm: string, n: number, sessionId: string, keywords: string[]): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const t0 = performance.now(), at = new Date().toISOString();
    let row: Record<string, unknown>;
    try {
      const r = await transcribeWithTurns({ wav, keywords, key, sessionId, timeoutMs: 40_000 });
      row = { arm, clip: id, n, attempt, at, session_id: sessionId, wav_sha256: sha(wav), request_sha256: sha(JSON.stringify(requestPart(keywords))), raw: r.text, audio_ms: r.audio_ms, turns: r.turns, latency_ms: Math.round(performance.now() - t0), cost_usd: r.cost_usd, status: 200, error: null, voided: false };
    } catch (e) {
      const status = e instanceof VoiceError ? e.status : null;
      row = { arm, clip: id, n, attempt, at, session_id: sessionId, wav_sha256: sha(wav), raw: null, latency_ms: Math.round(performance.now() - t0), cost_usd: 0, status, error: e instanceof Error ? e.message.slice(0, 200) : String(e), voided: status === 429 };
    }
    ledger.append("reading.call", { provider: "meta", model: ASR_MODEL, purpose: "research_transcribe_stability", latency_ms: row["latency_ms"], cost_usd: row["cost_usd"], task_id: null, line_id: `${arm}-${id}-${n}`, error: row["error"], voided: row["voided"] }, { recorded_at: 0, occurred_at: 0 });
    appendFileSync(out, `${JSON.stringify(row)}\n`);
    if (row["status"] !== 429) return;
    await sleep(2000 * 2 ** attempt);
  }
}

for (const id of ids) {
  const file = join(dir, `${id}.wav`);
  if (!existsSync(file)) throw new Error(`${id}: no clip`);
  const wav = new Uint8Array(readFileSync(file));
  for (const arm of arms) {
    const p = PLAN[arm]!;
    const keywords = p.hints ? HINTS : [];
    const fixed = `g9-${arm}-${id}-${Date.now().toString(36)}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
    const sid = (n: number) => (p.session === "fixed" ? fixed : `g9-${arm}-${id}-${n}-${Date.now().toString(36)}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64));
    if (p.together) await Promise.all(Array.from({ length: p.calls }, (_, n) => call(id, wav, arm, n, sid(n), keywords)));
    else for (let n = 0; n < p.calls; n++) await call(id, wav, arm, n, sid(n), keywords);
  }
  process.stderr.write(`${id} done\n`);
}
ledger.close();
