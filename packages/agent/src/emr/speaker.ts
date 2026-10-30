import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { decodeWav, encodeWav } from "@hey-pisgah/voice";

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

// One window of a line's audio, matched on its own: its voiceprint and, when the hospital computes the voiceprint, its 16 kHz PCM held in memory only.
export type VoiceWindow = { vector: number[]; ms: number; audio?: Uint8Array };
// A line's voiceprint; `segments` lists every window when the line was matched in more than one, and the line counts as the owner's only when every window is.
export type Voiceprint = { vector: number[]; ms: number; model: typeof SPEAKER_MODEL; audio?: Uint8Array; segments?: VoiceWindow[] };
export type Embedder = (wav: Uint8Array) => Promise<Voiceprint | null>;
// What the hospital's match is sent: the agent's voiceprint, or every window of the line's audio when the hospital computes the voiceprint itself.
export type SpeakerInput = readonly number[] | { readonly pcm16k: readonly Uint8Array[] };

// The longest window the hospital is sent for one voiceprint; a longer stretch is split, never cut short.
export const DOOR_AUDIO_MAX_MS = 15_000;
// The shortest window that carries enough voice to match; a shorter piece is matched with its neighbour.
export const WINDOW_MIN_MS = 500;
// The longest line that is matched at all; a longer one is unverified, said so, rather than matched in part.
export const LINE_MATCH_MAX_MS = 60_000;

// The windows a line is matched on: one per heard piece, a piece under half a second joined to its neighbour, a piece over the cap split evenly, so every sample is in exactly one window.
export function matchWindows(parts: readonly Float32Array[], rate: number, capMs = DOOR_AUDIO_MAX_MS, minMs = WINDOW_MIN_MS): Float32Array[] {
  const min = Math.round((rate * minMs) / 1000), cap = Math.floor((rate * capMs) / 1000);
  const merged: Float32Array[] = [];
  for (const p of parts.filter((x) => x.length > 0)) {
    const last = merged.at(-1);
    if (last && (p.length < min || last.length < min)) merged[merged.length - 1] = concatSamples(last, p);
    else merged.push(p);
  }
  const out = merged.flatMap((w) => {
    if (w.length <= cap) return [w];
    const n = Math.ceil(w.length / cap), size = Math.ceil(w.length / n);
    return Array.from({ length: n }, (_, i) => w.subarray(i * size, Math.min(w.length, (i + 1) * size)));
  });
  // The hospital takes at most eight windows, so the shortest neighbouring pair that still fits the cap is joined until there are eight.
  while (out.length > WINDOWS_MAX) {
    let best = -1;
    for (let i = 0; i + 1 < out.length; i++) if (out[i]!.length + out[i + 1]!.length <= cap && (best < 0 || out[i]!.length + out[i + 1]!.length < out[best]!.length + out[best + 1]!.length)) best = i;
    if (best < 0) break;
    out.splice(best, 2, concatSamples(out[best]!, out[best + 1]!));
  }
  return out;
}
// The most windows one match request carries.
export const WINDOWS_MAX = 8;
const concatSamples = (a: Float32Array, b: Float32Array): Float32Array => { const o = new Float32Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

// The line's voiceprint from every window; null when the line is too long to match or any window cannot be read, so no word goes unattributed.
export async function printLine(embed: Embedder, windows: readonly Float32Array[], rate: number): Promise<Voiceprint | null> {
  if (!windows.length || windows.reduce((n, w) => n + w.length, 0) > (rate * LINE_MATCH_MAX_MS) / 1000) return null;
  const prints = await Promise.all(windows.map((w) => embed(encodeWav(w, rate)).catch(() => null)));
  if (prints.some((p) => !p)) return null;
  const ps = prints as Voiceprint[];
  if (ps.length === 1) return ps[0]!;
  return { vector: ps[0]!.vector, ms: Math.round(ps.reduce((n, p) => n + p.ms, 0) * 10) / 10, model: SPEAKER_MODEL, segments: ps.map((p) => ({ vector: p.vector, ms: p.ms, ...(p.audio ? { audio: p.audio } : {}) })) };
}

// One verdict for a line from its windows' verdicts: the owner only when every window is the owner, one colleague only when every window is that colleague, else unverified.
export function lineVerdict(vs: readonly SpeakerVerdict[]): SpeakerVerdict {
  const first = vs[0];
  if (!first) return { speaker: "unverified", reason: "no_voiceprint" };
  if (vs.every((v) => v.speaker === "owner")) return first;
  if (first.speaker === "other_clinician" && vs.every((v) => v.speaker === "other_clinician" && v.label === first.label)) return first;
  return { speaker: "unverified", reason: vs.some((v) => v.speaker !== "unverified") ? "mixed_speakers" : (vs.find((v) => v.speaker === "unverified") as { reason: string }).reason };
}
// Where the voiceprint is computed: by the agent (the default, so every kept run replays) or by the hospital from the line's audio.
export type VoiceprintAt = "agent" | "door";
export const voiceprintAt = (v: string | undefined): VoiceprintAt => (v === "door" ? "door" : "agent");

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

// One window's audio as the hospital takes it: 16 kHz, mono, 16-bit little-endian PCM; null under half a second or over the 15 s cap, never cut short.
export function pcm16kOf(wav: Uint8Array): Uint8Array | null {
  const { samples, sampleRate } = decodeWav(wav);
  const x = to16k(samples, sampleRate);
  if (x.length < 8000 || x.length > (DOOR_AUDIO_MAX_MS / 1000) * 16_000) return null;
  const n = x.length;
  const out = new Uint8Array(n * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, x[i] ?? 0));
    v.setInt16(i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return out;
}

// Adds each window's audio to its voiceprint, so the hospital matches the audio and the agent's own vector is never sent; a recording over the cap is matched in windows.
export function withDoorAudio(inner: Embedder): Embedder {
  const one: Embedder = async (wav) => {
    const print = await inner(wav);
    const audio = print ? pcm16kOf(wav) : null;
    return print && audio ? { ...print, audio } : null;
  };
  return async (wav) => {
    const { samples, sampleRate } = decodeWav(wav);
    return samples.length <= (sampleRate * DOOR_AUDIO_MAX_MS) / 1000 ? one(wav) : printLine(one, matchWindows([samples], sampleRate), sampleRate);
  };
}

// A whole recording's voiceprint, in windows when it runs past the cap.
export const printWav = (embed: Embedder, wav: Uint8Array): Promise<Voiceprint | null> => { const { samples, sampleRate } = decodeWav(wav); return printLine(embed, matchWindows([samples], sampleRate), sampleRate); };

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
// Required: a chunk without a marker is not present; observed: a missing marker leaves attribution as it was, and a marker that says absent still withholds the match; heartbeat: audio from a strip session with no fresh signed beat is refused (D30).
export type PresenceMode = "required" | "observed" | "heartbeat";
// The strip session's heartbeat presence, given by the agent service in heartbeat mode.
export type HeartbeatOf = (owner: string, sessionId: string) => ChunkPresence;
export type ChunkPresence = { live: true } | { live: false; reason: string } | { live: null };
export type GuardChunk = { owner: string; session_id: string; seq: number | string; wav: Uint8Array; audio_ms: number; speech: boolean; arrived_at: number; captured_at?: number | undefined; marker?: LivenessMarker | null | undefined };
export type GuardVerdict = { refused: "replayed_chunk" | "faster_than_live" | "capture_out_of_order" | "capture_in_future" | "no_presence"; presence: null } | { refused: null; presence: ChunkPresence };

export function presenceOf(c: Pick<GuardChunk, "marker" | "captured_at" | "audio_ms" | "arrived_at">, mode: PresenceMode, rule: PresenceRule = PRESENCE_RULE): ChunkPresence {
  const m = c.marker;
  if (!m) return mode === "observed" ? { live: null } : { live: false, reason: "no_marker" };
  if (!m.visible) return { live: false, reason: "page_hidden" };
  if (!m.mic_live) return { live: false, reason: "mic_not_live" };
  if (m.input_age_ms === null || m.input_age_ms > rule.presence_window_ms) return { live: false, reason: "no_recent_input" };
  if (c.captured_at !== undefined && c.arrived_at - c.captured_at - c.audio_ms > rule.stale_capture_ms) return { live: false, reason: "stale_capture" };
  return { live: true };
}

// Refuses audio a live microphone could not have sent, from either the chunk path or the frames path, and remembers each accepted piece's presence for the line it becomes; hashes only, no audio.
export class ReplayGuard {
  private readonly seen = new Map<string, Map<string, string>>();
  private readonly recent = new Map<string, { at: number; ms: number }[]>();
  private readonly lastCapture = new Map<string, { at: number; ms: number }>();
  private readonly presence = new Map<string, ChunkPresence>();
  private readonly bySession = new Map<string, ChunkPresence>();
  readonly refusals: Record<string, number> = {};
  // With refusals off (scripted feeds and kept-run replays), presence is still judged from any marker the chunk carries; heartbeat mode refuses whatever the copy setting.
  constructor(private readonly mode: PresenceMode = "observed", private readonly rule: PresenceRule = PRESENCE_RULE, private readonly refuseCopies = true, private readonly heartbeat?: HeartbeatOf) {}

  // The one check both listening paths call; `wav` is the piece's speech bytes, hashed as given.
  check(c: GuardChunk): GuardVerdict {
    const refuse = (why: Exclude<GuardVerdict["refused"], null>): GuardVerdict => { this.refusals[why] = (this.refusals[why] ?? 0) + 1; return { refused: why, presence: null }; };
    const key = `${c.session_id}#${c.seq}`;
    if (this.mode === "heartbeat" && this.beatOf(c.owner, c.session_id).live !== true) return refuse("no_presence");
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

  private beatOf(owner: string, sessionId: string): ChunkPresence {
    return this.heartbeat ? this.heartbeat(owner, sessionId) : { live: false, reason: "no_heartbeat" };
  }

  private judge(c: GuardChunk, key: string): GuardVerdict {
    const p = this.mode === "heartbeat" ? this.beatOf(c.owner, c.session_id) : presenceOf(c, this.mode, this.rule);
    this.presence.set(key, p);
    this.bySession.set(c.session_id, p);
    if (this.presence.size > 20 * this.rule.seen_per_owner) this.presence.delete(this.presence.keys().next().value!);
    if (this.bySession.size > this.rule.seen_per_owner) this.bySession.delete(this.bySession.keys().next().value!);
    return { refused: null, presence: p };
  }

  // A line is present only when every piece in it was; one absent piece withholds the voice match for the whole line; a line from the frames path, whose pieces are not its line numbers, takes its session's latest; in heartbeat mode the beat must still be fresh when the line is finished.
  lineOf(sessionId: string, seqs: readonly number[], owner?: string): ChunkPresence {
    if (this.mode === "heartbeat") return owner ? this.beatOf(owner, sessionId) : { live: false, reason: "no_heartbeat" };
    const absent: ChunkPresence = this.mode === "required" ? { live: false, reason: "no_marker" } : { live: null };
    const each = seqs.map((s) => this.presence.get(`${sessionId}#${s}`));
    if (each.every((p) => p === undefined)) return this.bySession.get(sessionId) ?? absent;
    let out: ChunkPresence = { live: null };
    for (const q of each) {
      const p = q ?? absent;
      if (p.live === false) return p;
      if (p.live) out = p;
    }
    return out;
  }
}
