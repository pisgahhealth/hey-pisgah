import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { VoiceError, buildKeywords, cleanTranscript, concat, decodeWav, encodeWav, parseWav, trailingSilenceMs, type FinalTranscript } from "@hey-pisgah/voice";
import type { EmrRuntime } from "./runtime.js";
import { primaryClass } from "./classes.js";
import type { EmrContext, EmrTarget } from "./port.js";

export type Transcriber = (wav: Uint8Array, keywords: readonly string[], sessionId: string) => Promise<FinalTranscript>;

// The strip cuts a chunk 700 ms after speech stops or at a 6.00 s cap mid-word; a capped chunk with no quiet tail is held and joined with the next one before transcribing.
export const CHUNK_CAP_MS = 6000;
export const FINAL_SILENCE_MS = 500;
// Held audio that grows past this without a pause is dropped, never transcribed or acted on.
export const MAX_HELD_MS = 30_000;

export type ListenChunk = { owner: string; target: EmrTarget; session_id: string; seq: number; wav: Uint8Array; arrived_at?: number };
export type ListenUtterance = { id: string; line_id: string; task_id: string; text: string; seqs: number[]; class: string | null; classes: string[] };
export type ListenOutcome = {
  seq: number; final: boolean;
  why: "quiet_tail" | "short_chunk" | "held_for_join" | "empty" | "duplicate" | "late" | "held_dropped_gap" | "held_too_long" | "failed";
  trailing_silence_ms: number; audio_ms: number; transcript: string | null; raw_transcript: string | null; cost_usd: number; keywords_dropped: boolean;
  utterance: ListenUtterance | null; error?: string;
};
// What POST /tasks/listen answers: the utterances finished since the last answer, and, when the caller waited, this chunk's outcome.
export type ListenReply = { session_id: string; seq: number; accepted: true; utterances: ListenUtterance[]; partial: null; outcome?: ListenOutcome; errors?: string[] };
type Held = { samples: Float32Array[]; seqs: number[]; audio_ms: number; rate: number };
type Session = {
  owner: string; ctx: EmrContext; next: number; held: Held | null; outcomes: Map<number, ListenOutcome>;
  chain: Promise<unknown>; dropped: number; unreported: ListenUtterance[]; errors: string[];
};

export class ListenError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export type ListenOptions = { transcribe: Transcriber; finalSilenceMs?: number; capMs?: number; maxHeldMs?: number; now?: () => number; classesOf?: (taskId: string, lineId: string) => string[] };


// Continuous listening: chunks of one session are heard in order, capped chunks are joined as audio, and only a finished utterance reaches the runtime.
export class ListenSessions {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly rt: EmrRuntime, private readonly o: ListenOptions) {}

  session(id: string): { owner: string; admission_id: string; next: number; held_ms: number; dropped: number } | null {
    const s = this.sessions.get(id);
    return s ? { owner: s.owner, admission_id: s.ctx.admission_id, next: s.next, held_ms: s.held?.audio_ms ?? 0, dropped: s.dropped } : null;
  }

  // Queues one chunk; without wait the answer comes at once and the work goes on after it.
  async chunk(c: ListenChunk, wait = false): Promise<ListenReply> {
    const info = parseWav(c.wav);
    if (!info.ok) throw new ListenError(400, `audio: ${info.reason}`);
    let s = this.sessions.get(c.session_id);
    if (s && s.owner !== c.owner) throw new ListenError(403, "the session belongs to another owner");
    if (!s) {
      const ctx = await this.rt.port.resolve(c.target, { owner: c.owner, evidence: `transcript:listen-${c.session_id}`.slice(0, 200), spoken_at: new Date(c.arrived_at ?? this.now()).toISOString() });
      s = this.sessions.get(c.session_id) ?? { owner: c.owner, ctx, next: 0, held: null, outcomes: new Map(), chain: Promise.resolve(), dropped: 0, unreported: [], errors: [] };
      this.sessions.set(c.session_id, s);
    }
    const sess = s;
    const run = sess.chain.then(() => this.hear(sess, c)).catch((e: unknown): ListenOutcome => {
      const msg = e instanceof Error ? e.message.slice(0, 200) : "listen failed";
      sess.errors.push(`seq ${c.seq}: ${msg}`);
      return { seq: c.seq, final: false, why: "failed", trailing_silence_ms: 0, audio_ms: info.durationMs, transcript: null, raw_transcript: null, cost_usd: 0, keywords_dropped: false, utterance: null, error: msg };
    });
    sess.chain = run;
    const outcome = wait ? await run : undefined;
    const utterances = sess.unreported.splice(0).map((u) => this.withClass(u));
    const errors = sess.errors.splice(0);
    return { session_id: c.session_id, seq: c.seq, accepted: true, utterances, partial: null, ...(outcome ? { outcome } : {}), ...(errors.length ? { errors } : {}) };
  }

  // Resolves when every chunk of the session has been heard.
  async drain(sessionId: string): Promise<void> { await this.sessions.get(sessionId)?.chain; }

  private withClass(u: ListenUtterance): ListenUtterance {
    const classes = this.o.classesOf?.(u.task_id, u.line_id) ?? this.rt.task(u.task_id)?.lines.find((l) => l.id === u.line_id)?.classes ?? [];
    return { ...u, classes: [...classes], class: primaryClass(classes) };
  }

  private now(): number { return this.o.now?.() ?? Date.now(); }

  private async hear(s: Session, c: ListenChunk): Promise<ListenOutcome> {
    const prior = s.outcomes.get(c.seq);
    if (prior) return { ...prior, why: "duplicate" };
    const arrived = c.arrived_at ?? this.now();
    const { samples, sampleRate } = decodeWav(c.wav);
    const silence = trailingSilenceMs(samples, sampleRate);
    const audioMs = Math.round((samples.length / sampleRate) * 1000);
    const base = { seq: c.seq, trailing_silence_ms: silence, audio_ms: audioMs, transcript: null, raw_transcript: null, cost_usd: 0, keywords_dropped: false, utterance: null };
    const done = (o: ListenOutcome): ListenOutcome => { s.outcomes.set(c.seq, o); return o; };
    if (c.seq < s.next) return { ...base, final: false, why: "late" };
    let gap = false;
    // A missing chunk means the held audio is not the whole utterance, so it is dropped rather than finished.
    if (c.seq > s.next && s.held) { s.held = null; s.dropped += 1; gap = true; }
    s.next = c.seq + 1;
    if (s.held && s.held.rate !== sampleRate) { s.held = null; s.dropped += 1; }
    const capped = audioMs >= (this.o.capMs ?? CHUNK_CAP_MS) - 50 && silence < (this.o.finalSilenceMs ?? FINAL_SILENCE_MS);
    if (capped) {
      const h = s.held ?? { samples: [], seqs: [], audio_ms: 0, rate: sampleRate };
      h.samples.push(samples); h.seqs.push(c.seq); h.audio_ms += audioMs;
      s.held = h;
      if (h.audio_ms > (this.o.maxHeldMs ?? MAX_HELD_MS)) { s.held = null; s.dropped += 1; return done({ ...base, final: false, why: "held_too_long" }); }
      return done({ ...base, final: false, why: gap ? "held_dropped_gap" : "held_for_join" });
    }
    const h = s.held;
    s.held = null;
    const joined = h ? encodeWav(concat([...h.samples, samples]), sampleRate) : c.wav;
    const seqs = [...(h?.seqs ?? []), c.seq];
    const totalMs = audioMs + (h?.audio_ms ?? 0);
    const keywords = buildKeywords({ wards: [], documents: s.ctx.keywords, staff: [], beds: [] });
    const asrId = `${c.session_id}-${c.seq}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
    let heard: FinalTranscript;
    let dropped = false;
    try {
      heard = await this.o.transcribe(joined, keywords, asrId);
    } catch (e) {
      if (!(e instanceof VoiceError)) throw e;
      // A hint the service refuses must not lose the clinician's words, so one retry goes without hints.
      if (e.status !== 400 || !keywords.length) throw new ListenError(e.code === "bad_wav" ? 400 : 502, e.message);
      dropped = true;
      heard = await this.o.transcribe(joined, [], `${asrId}-nk`.slice(0, 64));
    }
    const text = cleanTranscript(heard.text);
    const why = gap ? "held_dropped_gap" : silence >= (this.o.finalSilenceMs ?? FINAL_SILENCE_MS) ? "quiet_tail" : "short_chunk";
    const heardOut = { ...base, audio_ms: totalMs, transcript: text, raw_transcript: heard.text, cost_usd: heard.cost_usd, keywords_dropped: dropped };
    if (!text) return done({ ...heardOut, final: true, why: "empty" });
    const r = await this.rt.say({
      owner: s.owner, target: { admission_id: s.ctx.admission_id }, text, source: "audio", spoken_at: new Date(arrived - totalMs).toISOString(),
      audio: { audio_ms: totalMs, cost_usd: heard.cost_usd, session_id: c.session_id },
      ambient: { session_id: c.session_id, seqs, raw_text: heard.text.slice(0, 2000), ended_at: new Date(arrived - silence).toISOString(), final_at: new Date(arrived).toISOString(), trailing_silence_ms: silence }
    });
    const u: ListenUtterance = { id: r.line_id, line_id: r.line_id, task_id: r.task_id, text, seqs, class: null, classes: [] };
    s.unreported.push(u);
    return done({ ...heardOut, final: true, why, utterance: u });
  }
}

const shaOf = (wav: Uint8Array) => createHash("sha256").update(wav).digest("hex");
type TranscriptBook = Record<string, { text: string; audio_ms: number }>;
const readBook = (file: string): TranscriptBook => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as TranscriptBook) : {});

// Wraps a live ear so every finished transcript is kept by the audio's hash, for replay.
export function recordingTranscriber(inner: Transcriber, file: string): Transcriber {
  return async (wav, keywords, sessionId) => {
    const r = await inner(wav, keywords, sessionId);
    const book = readBook(file);
    book[shaOf(wav)] = { text: r.text, audio_ms: r.audio_ms };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(book, null, 1)}\n`);
    return r;
  };
}

// Answers from kept transcripts only; audio that was never heard live is an error, not a guess.
export function replayTranscriber(file: string): Transcriber {
  const book = readBook(file);
  return async (wav, _keywords, sessionId) => {
    const hit = book[shaOf(wav)];
    if (!hit) throw new VoiceError("upstream", "no kept transcript for this audio");
    return { final: true, text: hit.text, audio_ms: hit.audio_ms, session_id: sessionId, cost_usd: 0 };
  };
}
