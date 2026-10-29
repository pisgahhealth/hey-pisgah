import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { denyHits, gatePrompt, gateUtterance, type EmrContext, type SayableNames } from "@hey-pisgah/agent";
import { ModelClient, ModelError, loadKeys, type ChatMessage } from "@hey-pisgah/model";
import { VITALS_KEYWORDS, buildKeywords, cleanTranscript, transcribeWav, vitalsVocabulary, ASR_MODEL } from "../src/index.js";
import { REFERENCE_NAMES, SPARK_FALLBACK, SPARK_PROMPTS, SPARK_ROUTE, parseSpark, sparkContent } from "./spark.js";
import { sha256Hex } from "./synth.js";

// Runs the transcript gate (Voice Transcribe then the shipped gate) and the audio-native Spark reader on one set, one line per clip, and keeps every reading.
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const set = arg("set", "tuning");
const dir = arg("audio", ".hey-pisgah/r1/synth");
const manifestPath = arg("manifest", "packages/voice/research/synthetic-set.json");
const out = arg("out", `.hey-pisgah/r1/readings/${set}.json`);
const runId = arg("run", "run-r1tune01");
const concurrency = Number(arg("concurrency", "3"));
const promptId = arg("prompt", "v1") as keyof typeof SPARK_PROMPTS;
const SPARK_SYSTEM = SPARK_PROMPTS[promptId];
const skipGate = process.argv.includes("--spark-only");

// The doctor's kinds in the journey, so the gate sees the wider prompt it sees on the ward.
export const DOCTOR_KINDS = ["record_observation", "draft_consult_note", "request_admission", "record_note", "page_staff", "schedule_follow_up"];
const CONTEXT: EmrContext = { admission_id: "a0000000-0000-4000-8000-000000000003", patient_id: "a0000000-0000-4000-8000-000000000001", label: "Ada Okon, female, 54", facts: { ward: "Female medical", bed: "Bed 4" }, keywords: [] };
const NAMES: SayableNames = { page_targets: { nurse_in_charge: ["nurse in charge"], surgical_registrar: ["surgical registrar"], anaesthetist: ["anaesthetist"] }, clinics: { surgical: ["surgical clinic"] } };

type ManifestClip = { id: string; line: string | null; set: string; file: string; sha256: string };
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { clips: ManifestClip[] };
const only = arg("only", "").split(",").filter(Boolean);
// A transport retry (--only, --gate-only) reads only the named clips again and leaves Spark's first reading alone.
const gateOnly = process.argv.includes("--gate-only");
const clips = manifest.clips.filter((c) => c.set === set && !/v\d+$/.test(c.id) && (!only.length || only.includes(c.id)));
const wav = (c: ManifestClip) => {
  const b = new Uint8Array(readFileSync(join(dir, c.file)));
  if (sha256Hex(b) !== c.sha256) throw new Error(`${c.id} does not match its listed hash`);
  return b;
};

for (const text of [SPARK_SYSTEM, gatePrompt(DOCTOR_KINDS, NAMES), "Clip LINE:", "Reply with the JSON object for the LINE clip."]) {
  if (denyHits(text).length) throw new Error(`a prompt holds a denied term: ${denyHits(text).join(", ")}`);
}

const keys = loadKeys();
const client = new ModelClient({ storeRoot: ".hey-pisgah/r1/store", mode: "live", record: false, timeoutMs: 90_000 });
const refs = (["S", "B", "N"] as const).map((p) => ({ name: REFERENCE_NAMES[p], b64: Buffer.from(wav(manifest.clips.find((c) => c.id === `E1-${p}`)!)).toString("base64") }));
const keywords = buildKeywords({ vitals: VITALS_KEYWORDS, wards: [], documents: [], staff: [], beds: [] });

async function transcript(c: ManifestClip, b: Uint8Array) {
  const t0 = performance.now();
  try {
    const r = await transcribeWav({ wav: b, keywords, key: keys.MODEL_API_KEY ?? "", sessionId: `r1-${c.id}-${Date.now().toString(36)}` });
    return { model: ASR_MODEL, raw: r.text, text: vitalsVocabulary(cleanTranscript(r.text)).text, latency_ms: Math.round(performance.now() - t0), cost_usd: r.cost_usd, error: null };
  } catch (e) {
    return { model: ASR_MODEL, raw: "", text: "", latency_ms: Math.round(performance.now() - t0), cost_usd: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

async function gate(text: string) {
  const t0 = performance.now();
  if (!text) return { provider: null, model: null, clauses: [], latency_ms: 0, cost_usd: 0, repairs: 0, fallback_reason: null, error: "no_transcript" };
  try {
    const r = await gateUtterance(client, { kinds: DOCTOR_KINDS, context: CONTEXT, actions: [], openQuestion: null, recent: [], said: text, today: "2026-10-29", names: NAMES }, { run_id: runId, task_id: "t-r1gate00" });
    const clauses = r.value.clauses.map((x) => ({ class: x.class, kind: x.kind ?? null, confidence: x.confidence ?? null, words: x.words }));
    return { provider: r.provider, model: r.model, clauses, latency_ms: Math.round(performance.now() - t0), cost_usd: r.cost_usd, repairs: r.repairs, fallback_reason: r.fallback_reason, error: null };
  } catch (e) {
    return { provider: null, model: null, clauses: [], latency_ms: Math.round(performance.now() - t0), cost_usd: 0, repairs: 0, fallback_reason: null, error: e instanceof ModelError ? e.code : String(e) };
  }
}

async function spark(b: Uint8Array) {
  const line = Buffer.from(b).toString("base64");
  const once = async (route: typeof SPARK_ROUTE | typeof SPARK_FALLBACK, fallback_reason: string | null) => {
    const t0 = performance.now();
    const messages = [{ role: "system", content: SPARK_SYSTEM }, { role: "user", content: sparkContent(route.provider, refs, line) }] as unknown as ChatMessage[];
    const r = await client.call({ provider: route.provider, model: route.model, effort: "low", max_completion_tokens: 2000, messages, purpose: "interpret_speech", run_id: runId, task_id: null, task_state: null, thread: "side", affinity_key: null });
    const text = String(r.completion.choices[0]?.message?.content ?? "");
    return { provider: route.provider, model: route.model, reading: parseSpark(text), raw: text.slice(0, 600), latency_ms: Math.round(performance.now() - t0), cost_usd: r.row.cost_usd, completion_tokens: r.row.completion_tokens, fallback_reason, error: null as string | null };
  };
  try {
    return await once(SPARK_ROUTE, null);
  } catch (e) {
    if (!(e instanceof ModelError) || e.code !== "provider_error") return { provider: SPARK_ROUTE.provider, model: SPARK_ROUTE.model, reading: null, raw: "", latency_ms: 0, cost_usd: 0, completion_tokens: 0, fallback_reason: null, error: e instanceof ModelError ? e.code : String(e) };
    try { return await once(SPARK_FALLBACK, "modal_provider_error"); } catch (e2) {
      return { provider: SPARK_FALLBACK.provider, model: SPARK_FALLBACK.model, reading: null, raw: "", latency_ms: 0, cost_usd: 0, completion_tokens: 0, fallback_reason: "modal_provider_error", error: e2 instanceof ModelError ? e2.code : String(e2) };
    }
  }
}

const results: unknown[] = [];
let next = 0;
async function worker(): Promise<void> {
  while (next < clips.length) {
    const c = clips[next++]!;
    const b = wav(c);
    const none = { provider: SPARK_ROUTE.provider, model: SPARK_ROUTE.model, reading: null, raw: "", latency_ms: 0, cost_usd: 0, completion_tokens: 0, fallback_reason: null, error: "skipped" };
    const [vt, sp] = gateOnly ? [await transcript(c, b), none] : skipGate ? [{ model: ASR_MODEL, raw: "", text: "", latency_ms: 0, cost_usd: 0, error: "skipped" }, await spark(b)] : await Promise.all([transcript(c, b), spark(b)]);
    const g = skipGate ? { provider: null, model: null, clauses: [], latency_ms: 0, cost_usd: 0, repairs: 0, fallback_reason: null, error: "skipped" } : await gate(vt.text);
    results.push({ id: c.id, line: c.line, sha256: c.sha256, transcript: vt, gate: g, spark: sp });
    process.stderr.write(`${c.id} vt ${vt.latency_ms} gate ${g.latency_ms} spark ${sp.latency_ms} ${sp.reading ? `${sp.reading.speaker}/${sp.reading.addressee}/${sp.reading.kind}` : `none ${sp.error ?? ""}`}\n`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
client.close();
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, `${JSON.stringify({ set, run_id: runId, at: new Date().toISOString(), spark_prompt: promptId, spark_system: SPARK_SYSTEM, concurrency, clips: results }, null, 1)}\n`);
process.stderr.write(`${results.length} clips read\n`);
