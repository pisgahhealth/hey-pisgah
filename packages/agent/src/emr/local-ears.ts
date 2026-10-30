import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ASR_MODEL, decodeWav, type FinalTranscript } from "@hey-pisgah/voice";
import type { EarReading, SecondEar } from "./ears.js";
import type { Transcriber } from "./listen.js";
import { to16k } from "./speaker.js";

// The offline second ear: NeMo Parakeet TDT 0.6B v2, int8, through sherpa-onnx in this process (CC-BY-4.0).
export const PARAKEET_MODEL = "nemo-parakeet-tdt-0.6b-v2-int8" as const;
// The streaming first ear: the Kroko English streaming Zipformer community model through sherpa-onnx (CC-BY-SA).
export const STREAM_MODEL = "streaming-zipformer-en-kroko-2025-08-06" as const;
// The release folder names, as sherpa-onnx publishes them, under one models folder.
export const PARAKEET_DIR = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";
export const STREAM_DIR = "sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06";
export const localDirs = (root: string) => ({ parakeetDir: join(root, PARAKEET_DIR), streamDir: join(root, STREAM_DIR) });
// Zeros fed at an end of speech so the streaming model emits the words it still holds; this costs decode time only, never wall time.
export const STREAM_FLUSH_MS = 1000;

// The two switches, both off by default so every recorded run replays as made.
export type EarSwitch = "spark" | "parakeet";
export type AsrSwitch = "rest" | "stream";
export const earSwitch = (v: string | undefined): EarSwitch => (v?.trim().toLowerCase() === "parakeet" ? "parakeet" : "spark");
export const asrSwitch = (v: string | undefined): AsrSwitch => (v?.trim().toLowerCase() === "stream" ? "stream" : "rest");

// One reading that is not a Spark call, kept on the run's ledger beside the model calls so every decision names its model and purpose.
export type ReadingCall = { provider: "local" | "meta"; model: string; purpose: "verify_number" | "interpret_speech"; latency_ms: number; cost_usd: number; task_id: string | null; line_id: string | null; error: string | null };
export type ReadingLedger = (runId: string | null, row: ReadingCall) => void;

type Wave = { sampleRate: number; samples: Float32Array };
type OfflineStream = { acceptWaveform(w: Wave): void };
type OfflineRec = { createStream(): OfflineStream; decodeAsync(s: OfflineStream): Promise<unknown>; getResult(s: OfflineStream): { text: string } };
type OnlineStream = { acceptWaveform(w: Wave): void };
type OnlineRec = { createStream(): OnlineStream; isReady(s: OnlineStream): boolean; decode(s: OnlineStream): void; getResult(s: OnlineStream): { text: string } };
type Sherpa = { OfflineRecognizer: new (c: unknown) => OfflineRec; OnlineRecognizer: new (c: unknown) => OnlineRec };

// Loads sherpa-onnx-node from the given folder or the normal module path; null when it is not installed.
function loadSherpa(sherpaDir?: string): Sherpa | null {
  try {
    const req = createRequire(sherpaDir ? join(sherpaDir, "package.json") : import.meta.url);
    return req("sherpa-onnx-node") as Sherpa;
  } catch {
    return null;
  }
}

// The transducer files in a model folder, int8 first; null when one is missing.
function transducerFiles(dir: string): { encoder: string; decoder: string; joiner: string; tokens: string } | null {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir);
  const pick = (part: string) => names.find((n) => n.startsWith(part) && n.endsWith(".int8.onnx")) ?? names.find((n) => n.startsWith(part) && n.endsWith(".onnx"));
  const [encoder, decoder, joiner] = [pick("encoder"), pick("decoder"), pick("joiner")];
  if (!encoder || !decoder || !joiner || !names.includes("tokens.txt")) return null;
  return { encoder: join(dir, encoder), decoder: join(dir, decoder), joiner: join(dir, joiner), tokens: join(dir, "tokens.txt") };
}

const wave16k = (wav: Uint8Array): Float32Array => { const { samples, sampleRate } = decodeWav(wav); return to16k(samples, sampleRate); };

// Parakeet as the second reading of a clip; null when the library or the model files are missing.
export function parakeetEar(o: { modelDir: string; sherpaDir?: string | undefined; threads?: number; ledger?: ReadingLedger }): SecondEar | null {
  const files = transducerFiles(o.modelDir);
  const sherpa = files ? loadSherpa(o.sherpaDir) : null;
  if (!files || !sherpa) return null;
  const rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: { transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner }, tokens: files.tokens, numThreads: o.threads ?? 2, provider: "cpu", debug: 0, modelType: "nemo_transducer" }
  });
  const model = `local:${PARAKEET_MODEL}`;
  return async (wav, meta) => {
    const t0 = performance.now();
    let text = "";
    try {
      const st = rec.createStream();
      st.acceptWaveform({ sampleRate: 16_000, samples: wave16k(wav) });
      await rec.decodeAsync(st);
      text = rec.getResult(st).text.trim();
    } catch (e) {
      o.ledger?.(meta.run_id, { provider: "local", model, purpose: "verify_number", latency_ms: Math.round(performance.now() - t0), cost_usd: 0, task_id: meta.task_id, line_id: meta.line_id, error: "decode_failed" });
      throw e;
    }
    o.ledger?.(meta.run_id, { provider: "local", model, purpose: "verify_number", latency_ms: Math.round(performance.now() - t0), cost_usd: 0, task_id: meta.task_id, line_id: meta.line_id, error: null });
    return { text: text.slice(0, 2000), provider: "local", model, response_id: null, cost_usd: 0, fallback_reason: null, calls: 1 };
  };
}

// Voice Transcribe as one more reading of a clip, so Meta still reads every line that writes a number when the first ear is local.
export function transcriberEar(t: Transcriber, o: { model?: string; ledger?: ReadingLedger } = {}): SecondEar {
  const model = o.model ?? ASR_MODEL;
  return async (wav, meta) => {
    const t0 = Date.now();
    const sid = `ear-${meta.line_id}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
    try {
      const r = await t(wav, [], sid);
      o.ledger?.(meta.run_id, { provider: "meta", model, purpose: "verify_number", latency_ms: Date.now() - t0, cost_usd: r.cost_usd, task_id: meta.task_id, line_id: meta.line_id, error: null });
      return { text: r.text.slice(0, 2000), provider: "meta", model, response_id: null, cost_usd: r.cost_usd, fallback_reason: null, calls: 1 };
    } catch (e) {
      o.ledger?.(meta.run_id, { provider: "meta", model, purpose: "verify_number", latency_ms: Date.now() - t0, cost_usd: 0, task_id: meta.task_id, line_id: meta.line_id, error: "transcribe_failed" });
      throw e;
    }
  };
}

// Several ears read the same clip at once; the first is the reading shown, the rest must agree as well, and the cost is the sum.
export function allEars(ears: readonly SecondEar[]): SecondEar {
  if (ears.length === 1) return ears[0]!;
  return async (wav, meta) => {
    const rs: EarReading[] = await Promise.all(ears.map((e) => e(wav, meta)));
    const [first, ...rest] = rs as [EarReading, ...EarReading[]];
    return { ...first, cost_usd: rs.reduce((n, r) => n + r.cost_usd, 0), calls: rs.reduce((n, r) => n + (r.calls ?? 1), 0), also: [...(first.also ?? []), ...rest] };
  };
}

// The streaming model writes a final "two" after a tens word as "to" ("sixty to" for 62); only that place is rewritten, and both other readings must still hear the number before a write.
const TENS_TO = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]+(?:to|too)\b(?=\s*(?:$|[.,;:!?]|over\b|point\b|and\b))/gi;
export const streamRepair = (raw: string): string => raw.replace(TENS_TO, "$1 two");

// One utterance being decoded as it is spoken; finish() flushes the model and spends the decoder.
export type StreamDecoder = { accept(samples16k: Float32Array): void; text(): string; finish(): string };
export type StreamAsr = { model: string; open(): StreamDecoder; transcribe: Transcriber };

// The streaming recogniser; null when the library or the model files are missing.
export function sherpaStreamAsr(o: { modelDir: string; sherpaDir?: string | undefined; threads?: number }): StreamAsr | null {
  const files = transducerFiles(o.modelDir);
  const sherpa = files ? loadSherpa(o.sherpaDir) : null;
  if (!files || !sherpa) return null;
  const rec = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: { transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner }, tokens: files.tokens, numThreads: o.threads ?? 2, provider: "cpu", debug: 0 },
    enableEndpoint: false
  });
  const open = (): StreamDecoder => {
    const st = rec.createStream();
    const run = () => { while (rec.isReady(st)) rec.decode(st); };
    return {
      accept: (x) => { st.acceptWaveform({ sampleRate: 16_000, samples: x }); run(); },
      text: () => rec.getResult(st).text.trim(),
      finish: () => { st.acceptWaveform({ sampleRate: 16_000, samples: new Float32Array((16_000 * STREAM_FLUSH_MS) / 1000) }); run(); return rec.getResult(st).text.trim(); }
    };
  };
  // A whole chunk from the strip, decoded at once: the chunk path's words without a network call.
  const transcribe: Transcriber = async (wav, _keywords, sessionId): Promise<FinalTranscript> => {
    const x = wave16k(wav);
    const d = open();
    d.accept(x);
    return { final: true, text: d.finish(), audio_ms: Math.round((x.length / 16_000) * 1000), session_id: sessionId, cost_usd: 0 };
  };
  return { model: `local:${STREAM_MODEL}`, open, transcribe };
}
