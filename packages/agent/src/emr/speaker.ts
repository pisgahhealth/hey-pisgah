import { createHash } from "node:crypto";
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
export const DOCUMENTATION_KINDS: ReadonlySet<string> = new Set(["record_observation", "record_triage_vitals", "record_clerking", "record_allergy", "record_note", "draft_consult_note", "open_consult", "draft_handover", "draft_stay_summary", "prepare_bill", "open_unnamed_encounter"]);
// Kinds that need the owner's own matched voice: voice orders under the hospital's verbal-order policy, and the diagnosis.
export const ORDER_KINDS: ReadonlySet<string> = new Set(["order_test", "prescribe", "countersign", "record_diagnosis"]);

// Replay defence (R-26): a replayed owner recording is caught by the session and the person's presence, never by the voice match.
export const PRESENCE_RULE = {
  // One owner has one microphone, so their audio across all sessions in this window cannot outrun the clock by more than the slack.
  live_window_ms: 60_000, live_slack_ms: 3000,
  // The strip's capture times must move forward chunk by chunk; a pre-roll carried across the wake phrase may overlap by this much.
  capture_overlap_ms: 2500, capture_future_ms: 2000,
  // A chunk captured longer ago than this is late audio, never live speech.
  stale_capture_ms: 120_000,
  // The person counts as at the screen when their last trusted input event is this recent; provisional, for Samuel to set.
  presence_window_ms: 300_000,
  seen_per_owner: 5000
} as const;
export type PresenceRule = { -readonly [K in keyof typeof PRESENCE_RULE]: number };

// What the strip says with each chunk about the person at the screen: page visible, microphone track live, and the age of the last trusted input event.
export type LivenessMarker = { visible: boolean; mic_live: boolean; input_age_ms: number | null };
// Required: a chunk without a marker is not present; observed: a missing marker leaves attribution as it was, and a marker that says absent still withholds the match.
export type PresenceMode = "required" | "observed";
export type ChunkPresence = { live: true } | { live: false; reason: string } | { live: null };
export type GuardChunk = { owner: string; session_id: string; seq: number; wav: Uint8Array; audio_ms: number; speech: boolean; arrived_at: number; captured_at?: number | undefined; marker?: LivenessMarker | null | undefined };
export type GuardVerdict = { refused: "replayed_chunk" | "faster_than_live" | "capture_out_of_order" | "capture_in_future"; presence: null } | { refused: null; presence: ChunkPresence };

export function presenceOf(c: Pick<GuardChunk, "marker" | "captured_at" | "audio_ms" | "arrived_at">, mode: PresenceMode, rule: PresenceRule = PRESENCE_RULE): ChunkPresence {
  const m = c.marker;
  if (!m) return mode === "required" ? { live: false, reason: "no_marker" } : { live: null };
  if (!m.visible) return { live: false, reason: "page_hidden" };
  if (!m.mic_live) return { live: false, reason: "mic_not_live" };
  if (m.input_age_ms === null || m.input_age_ms > rule.presence_window_ms) return { live: false, reason: "no_recent_input" };
  if (c.captured_at !== undefined && c.arrived_at - c.captured_at - c.audio_ms > rule.stale_capture_ms) return { live: false, reason: "stale_capture" };
  return { live: true };
}

// Refuses chunks a live microphone could not have sent, and remembers each accepted chunk's presence for the line it becomes; hashes only, no audio.
export class ReplayGuard {
  private readonly seen = new Map<string, Map<string, string>>();
  private readonly recent = new Map<string, { at: number; ms: number }[]>();
  private readonly lastCapture = new Map<string, { at: number; ms: number }>();
  private readonly presence = new Map<string, ChunkPresence>();
  readonly refusals: Record<string, number> = {};
  // With refusals off (scripted feeds and kept-run replays), presence is still judged from any marker the chunk carries.
  constructor(private readonly mode: PresenceMode = "observed", private readonly rule: PresenceRule = PRESENCE_RULE, private readonly refuseCopies = true) {}

  check(c: GuardChunk): GuardVerdict {
    const refuse = (why: Exclude<GuardVerdict["refused"], null>): GuardVerdict => { this.refusals[why] = (this.refusals[why] ?? 0) + 1; return { refused: why, presence: null }; };
    const key = `${c.session_id}#${c.seq}`;
    if (!this.refuseCopies) return this.judge(c, key);
    const seen = this.seen.get(c.owner) ?? new Map<string, string>();
    const hash = createHash("sha256").update(c.wav).digest("hex");
    // The same speech bytes again under another session or place is a copy; the same place again is the strip retrying an upload.
    if (c.speech && seen.has(hash) && seen.get(hash) !== key) return refuse("replayed_chunk");
    const retry = seen.get(hash) === key;
    if (!retry) {
      const last = this.lastCapture.get(c.session_id);
      if (c.captured_at !== undefined) {
        if (c.captured_at > c.arrived_at + this.rule.capture_future_ms) return refuse("capture_in_future");
        if (last && c.captured_at < last.at + last.ms - this.rule.capture_overlap_ms) return refuse("capture_out_of_order");
      }
      const win = (this.recent.get(c.owner) ?? []).filter((x) => c.arrived_at - x.at <= this.rule.live_window_ms);
      const all = [...win, { at: c.arrived_at, ms: c.audio_ms }];
      const span = c.arrived_at - Math.min(...all.map((x) => x.at - x.ms));
      if (all.reduce((n, x) => n + x.ms, 0) > span + this.rule.live_slack_ms) return refuse("faster_than_live");
      this.recent.set(c.owner, all);
      if (c.captured_at !== undefined) this.lastCapture.set(c.session_id, { at: c.captured_at, ms: c.audio_ms });
      if (c.speech) {
        seen.set(hash, key);
        if (seen.size > this.rule.seen_per_owner) seen.delete(seen.keys().next().value!);
        this.seen.set(c.owner, seen);
      }
    }
    return this.judge(c, key);
  }

  private judge(c: GuardChunk, key: string): GuardVerdict {
    const p = presenceOf(c, this.mode, this.rule);
    this.presence.set(key, p);
    if (this.presence.size > 20 * this.rule.seen_per_owner) this.presence.delete(this.presence.keys().next().value!);
    return { refused: null, presence: p };
  }

  // A line is present only when every chunk in it was; one absent chunk withholds the voice match for the whole line.
  lineOf(sessionId: string, seqs: readonly number[]): ChunkPresence {
    let out: ChunkPresence = { live: null };
    for (const s of seqs) {
      const p = this.presence.get(`${sessionId}#${s}`) ?? (this.mode === "required" ? { live: false, reason: "no_marker" } : { live: null });
      if (p.live === false) return p;
      if (p.live) out = p;
    }
    return out;
  }
}
