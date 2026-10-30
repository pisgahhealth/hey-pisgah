import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { decodeWav } from "@hey-pisgah/voice";

// The local speaker model R1 chose: TitaNet-small through sherpa-onnx, 192 numbers per segment, no audio kept.
export const SPEAKER_MODEL = "nemo_en_titanet_small" as const;
export const VOICEPRINT_DIM = 192;

// Who the hospital matched a segment to; only the owner's verdict carries a token, and a token is bound to that one line.
export type SpeakerVerdict =
  | { speaker: "owner"; token: string }
  | { speaker: "other_clinician"; label: string; role: string }
  | { speaker: "unverified"; reason: string };
// The verdict as the task stream keeps it, with the token left out.
export type SpeakerRecord = { speaker: SpeakerVerdict["speaker"]; label: string | null; reason: string | null; embed_ms: number | null; match_ms: number | null };
export const recordOf = (v: SpeakerVerdict, embed_ms: number | null, match_ms: number | null): SpeakerRecord =>
  ({ speaker: v.speaker, label: v.speaker === "other_clinician" ? v.label : null, reason: v.speaker === "unverified" ? v.reason : null, embed_ms, match_ms });

export type Voiceprint = { vector: number[]; ms: number; model: typeof SPEAKER_MODEL };
export type Embedder = (wav: Uint8Array) => Promise<Voiceprint | null>;

type SherpaStream = { acceptWaveform(o: { sampleRate: number; samples: Float32Array }): void; inputFinished(): void };
type SherpaExtractor = { dim: number; createStream(): SherpaStream; isReady(s: SherpaStream): boolean; compute(s: SherpaStream): Float32Array };
type SherpaModule = { SpeakerEmbeddingExtractor: new (c: { model: string; numThreads: number; provider: string; debug: number }) => SherpaExtractor };

// Resamples to 16 kHz with a short low-pass, so the native library has no resampler of its own to log about.
export function to16k(x: Float32Array, rate: number): Float32Array {
  if (rate === 16_000) return x;
  const ratio = rate / 16_000;
  const n = Math.floor(x.length / ratio);
  const out = new Float32Array(n);
  const half = Math.max(1, Math.round(ratio));
  for (let i = 0; i < n; i++) {
    const c = i * ratio;
    let s = 0, w = 0;
    for (let k = -half; k <= half; k++) {
      const j = Math.round(c) + k;
      if (j < 0 || j >= x.length) continue;
      const d = (j - c) / ratio;
      const wk = Math.abs(d) < 1e-9 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      s += x[j]! * wk; w += wk;
    }
    out[i] = w ? s / w : 0;
  }
  return out;
}

// Loads sherpa-onnx-node in this process from the given folder or the normal module path; null when it is not installed or the model is missing.
export function sherpaEmbedder(o: { modelPath: string; sherpaDir?: string | undefined; threads?: number }): Embedder | null {
  if (!existsSync(o.modelPath)) return null;
  let mod: SherpaModule;
  try {
    const req = createRequire(o.sherpaDir ? join(o.sherpaDir, "package.json") : import.meta.url);
    mod = req("sherpa-onnx-node") as SherpaModule;
  } catch {
    return null;
  }
  const ex = new mod.SpeakerEmbeddingExtractor({ model: o.modelPath, numThreads: o.threads ?? 1, provider: "cpu", debug: 0 });
  if (ex.dim !== VOICEPRINT_DIM) return null;
  return async (wav) => {
    const { samples, sampleRate } = decodeWav(wav);
    // Under half a second of audio carries too little voice to match.
    if (samples.length < sampleRate / 2) return null;
    const t0 = performance.now();
    const st = ex.createStream();
    st.acceptWaveform({ sampleRate: 16_000, samples: to16k(samples, sampleRate) });
    st.inputFinished();
    if (!ex.isReady(st)) return null;
    const e = ex.compute(st);
    const norm = Math.hypot(...e) || 1;
    return { vector: Array.from(e, (v) => Math.round((v / norm) * 1e5) / 1e5), ms: Math.round((performance.now() - t0) * 10) / 10, model: SPEAKER_MODEL };
  };
}

// What a line's speaker may do: the owner gives instructions, anyone may give documentation, and only the owner's matched voice authorises an order.
export type Authority = "owner" | "other_clinician" | "unverified" | "unattributed";
export const authorityOf = (r: SpeakerRecord | null): Authority => (r ? r.speaker : "unattributed");

// Kinds that only document what was said; every other kind changes the patient's care and waits for the owner's own voice when attribution is on.
export const DOCUMENTATION_KINDS: ReadonlySet<string> = new Set(["record_observation", "record_triage_vitals", "record_clerking", "record_allergy", "record_note", "draft_consult_note", "open_consult", "draft_handover", "prepare_bill", "open_unnamed_encounter"]);
// Kinds sent as voice orders under the hospital's verbal-order policy.
export const ORDER_KINDS: ReadonlySet<string> = new Set(["order_test", "prescribe", "countersign"]);
