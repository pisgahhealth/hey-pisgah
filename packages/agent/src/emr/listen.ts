import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { VITALS_KEYWORDS, VoiceError, buildKeywords, cleanTranscript, concat, continuesNumber, danglingEnd, decodeWav, encodeWav, leadingSilenceMs, parseWav, trailingSilenceMs, vitalsVocabulary, type FinalTranscript, type Rewrite } from "@hey-pisgah/voice";
import type { EmrRuntime } from "./runtime.js";
import { primaryClass } from "./classes.js";
import type { EmrContext, EmrTarget } from "./port.js";
import { ReplayGuard, type Embedder, type LivenessMarker, type PresenceMode, type PresenceRule, type Voiceprint } from "./speaker.js";

export type Transcriber = (wav: Uint8Array, keywords: readonly string[], sessionId: string) => Promise<FinalTranscript>;

// The strip cuts a chunk 700 ms after speech stops or at a 6.00 s cap mid-word; a capped chunk with no quiet tail is held and joined with the next one before transcribing.
export const CHUNK_CAP_MS = 6000;
export const FINAL_SILENCE_MS = 500;
// Held audio that grows past this without a pause is dropped, never transcribed or acted on.
export const MAX_HELD_MS = 30_000;
// How long a line that ends where a value must follow ("the temperature is about") waits for the next chunk.
export const STRONG_JOIN_WAIT_MS = 8000;
// How long a vitals line that ends on a number waits for a next chunk that carries the number on ("point six").
export const NUMBER_JOIN_WAIT_MS = 3000;

export type ListenChunk = { owner: string; target: EmrTarget; session_id: string; seq: number; wav: Uint8Array; arrived_at?: number; captured_at?: number; presence?: LivenessMarker | null };
export type ListenUtterance = { id: string; line_id: string; task_id: string; text: string; seqs: number[]; class: string | null; classes: string[] };
export type ListenOutcome = {
  seq: number; final: boolean;
  why: "quiet_tail" | "short_chunk" | "pause_after_cap" | "held_for_join" | "held_for_number" | "joined_across_cut" | "number_alone" | "empty" | "duplicate" | "late" | "held_dropped_gap" | "held_too_long" | "failed";
  trailing_silence_ms: number; audio_ms: number; transcript: string | null; raw_transcript: string | null; cost_usd: number; keywords_dropped: boolean;
  utterance: ListenUtterance | null; error?: string;
};
// What POST /tasks/listen answers: the utterances finished since the last answer, and, when the caller waited, this chunk's outcome.
export type ListenReply = { session_id: string; seq: number; accepted: true; utterances: ListenUtterance[]; partial: null; outcome?: ListenOutcome; errors?: string[] };
type Held = { samples: Float32Array[]; seqs: number[]; audio_ms: number; rate: number; trailing_ms: number; arrived: number };
// One transcribed stretch of audio, either finished or waiting for the next chunk because it ends mid-number.
type Heard = {
  samples: Float32Array[]; seqs: number[]; rate: number; audio_ms: number; trailing_ms: number; arrived: number;
  text: string; raw: string; cost_usd: number; keywords_dropped: boolean; rewrites: Rewrite[]; strong: boolean; joined: boolean; heard_at: number;
  // The segment's voiceprint from the local speaker model, worked out beside the transcription; the audio itself is never kept.
  voiceprint: Voiceprint | null;
};
type Session = {
  owner: string; ctx: EmrContext; next: number; held: Held | null; waiting: Heard | null; timer: NodeJS.Timeout | null; outcomes: Map<number, ListenOutcome>;
  chain: Promise<unknown>; dropped: number; unreported: ListenUtterance[]; errors: string[];
};

export class ListenError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export type ListenOptions = {
  transcribe: Transcriber; finalSilenceMs?: number; capMs?: number; maxHeldMs?: number; strongJoinWaitMs?: number; numberJoinWaitMs?: number;
  now?: () => number; classesOf?: (taskId: string, lineId: string) => string[];
  // The local speaker model; without it no line carries a voiceprint and attribution stays off.
  embed?: Embedder;
  // The replay defence: refuse copies and faster-than-live audio (the deployed serve turns this on; scripted feeds leave it off), whether a chunk must carry the strip's liveness marker, and the frozen rule.
  replay?: "refuse" | "off"; presence?: PresenceMode; presenceRule?: PresenceRule;
};

// Speech, not digital silence: identical silent chunks are expected and are no sign of a copy.
const hasSpeech = (wav: Uint8Array): boolean => { const { samples } = decodeWav(wav); for (const v of samples) if (Math.abs(v) > 0.01) return true; return false; };
const totalMs = (parts: readonly Float32Array[], rate: number) => Math.round((parts.reduce((n, p) => n + p.length, 0) / rate) * 1000);

// Continuous listening: chunks of one session are heard in order, capped chunks are joined as audio, a number cut at a pause is joined with what follows, and only a finished utterance reaches the runtime.
export class ListenSessions {
  private readonly sessions = new Map<string, Session>();
  private closed = false;
  private readonly guard: ReplayGuard;
  constructor(private readonly rt: EmrRuntime, private readonly o: ListenOptions) { this.guard = new ReplayGuard(o.presence ?? "observed", o.presenceRule, o.replay === "refuse"); }

  // How many chunks the replay defence refused, by reason.
  replayRefusals(): Record<string, number> { return { ...this.guard.refusals }; }

  session(id: string): { owner: string; admission_id: string; next: number; held_ms: number; waiting: string | null; dropped: number } | null {
    const s = this.sessions.get(id);
    return s ? { owner: s.owner, admission_id: s.ctx.admission_id, next: s.next, held_ms: s.held?.audio_ms ?? 0, waiting: s.waiting?.text ?? null, dropped: s.dropped } : null;
  }

  // Queues one chunk; without wait the answer comes at once and the work goes on after it.
  async chunk(c: ListenChunk, wait = false): Promise<ListenReply> {
    const info = parseWav(c.wav);
    if (!info.ok) throw new ListenError(400, `audio: ${info.reason}`);
    // A chunk a live microphone in this session could not have sent is refused before anything hears it, so the voice match never decides a replay.
    const g = this.guard.check({ owner: c.owner, session_id: c.session_id, seq: c.seq, wav: c.wav, audio_ms: info.durationMs, speech: hasSpeech(c.wav), arrived_at: c.arrived_at ?? this.now(), captured_at: c.captured_at, marker: c.presence });
    if (g.refused) throw new ListenError(409, `replayed audio refused: ${g.refused}`);
    let s = this.sessions.get(c.session_id);
    if (s && s.owner !== c.owner) throw new ListenError(403, "the session belongs to another owner");
    if (!s) {
      const ctx = await this.rt.port.resolve(c.target, { owner: c.owner, evidence: `transcript:listen-${c.session_id}`.slice(0, 200), spoken_at: new Date(c.arrived_at ?? this.now()).toISOString() });
      s = this.sessions.get(c.session_id) ?? { owner: c.owner, ctx, next: 0, held: null, waiting: null, timer: null, outcomes: new Map(), chain: Promise.resolve(), dropped: 0, unreported: [], errors: [] };
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

  // Finishes a line still waiting for the next chunk now, as when listening stops.
  async flush(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    await s.chain;
    const w = s.waiting;
    if (!w) return;
    this.clearWait(s);
    s.chain = s.chain.then(() => this.deliver(s, sessionId, w, "number_alone")).catch((e: unknown) => { s.errors.push(e instanceof Error ? e.message.slice(0, 200) : "listen failed"); });
    await s.chain;
  }

  close(): void {
    this.closed = true;
    for (const s of this.sessions.values()) this.clearWait(s);
  }

  private clearWait(s: Session): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.waiting = null;
  }

  private withClass(u: ListenUtterance): ListenUtterance {
    const classes = this.o.classesOf?.(u.task_id, u.line_id) ?? this.rt.task(u.task_id)?.lines.find((l) => l.id === u.line_id)?.classes ?? [];
    return { ...u, classes: [...classes], class: primaryClass(classes) };
  }

  private now(): number { return this.o.now?.() ?? Date.now(); }
  private finalMs(): number { return this.o.finalSilenceMs ?? FINAL_SILENCE_MS; }

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
    let delivered: ListenUtterance | null = null;
    const alone = async () => { const w = s.waiting; if (w) { this.clearWait(s); delivered = await this.deliver(s, c.session_id, w, "number_alone"); } };
    // A missing chunk means the held audio is not the whole utterance, so it is dropped rather than finished; a finished line waiting on it goes on alone.
    if (c.seq > s.next && s.held) { s.held = null; s.dropped += 1; gap = true; }
    if (c.seq > s.next) await alone();
    s.next = c.seq + 1;
    if (s.held && s.held.rate !== sampleRate) { s.held = null; s.dropped += 1; }
    if (s.waiting && s.waiting.rate !== sampleRate) await alone();
    // A cap that fell in the quiet after speech left a whole utterance on hold; when the pause runs on into this chunk, that utterance is finished alone.
    if (s.held) {
      const pause = s.held.trailing_ms + leadingSilenceMs(samples, sampleRate) + Math.max(0, arrived - s.held.arrived - audioMs);
      if (pause >= this.finalMs()) {
        const h = s.held;
        s.held = null;
        const heard = await this.ear(s, c.session_id, h.samples, h.seqs, h.rate, h.trailing_ms, h.arrived);
        delivered = (await this.settleHeard(s, c.session_id, heard, "pause_after_cap")) ?? delivered;
      }
    }
    const capped = audioMs >= (this.o.capMs ?? CHUNK_CAP_MS) - 50 && silence < this.finalMs();
    if (capped) {
      // A line that ended where a value must follow carries on into this capped audio; a line ending on a number does not wait on audio that cannot be read yet.
      const w = s.waiting;
      let h = s.held;
      if (w && w.strong && !h) { this.clearWait(s); h = { samples: [...w.samples], seqs: [...w.seqs], audio_ms: w.audio_ms, rate: w.rate, trailing_ms: 0, arrived: w.arrived }; }
      else await alone();
      h ??= { samples: [], seqs: [], audio_ms: 0, rate: sampleRate, trailing_ms: 0, arrived };
      h.samples.push(samples); h.seqs.push(c.seq); h.audio_ms += audioMs; h.trailing_ms = silence; h.arrived = arrived;
      s.held = h;
      if (h.audio_ms > (this.o.maxHeldMs ?? MAX_HELD_MS)) { s.held = null; s.dropped += 1; return done({ ...base, final: false, why: "held_too_long", utterance: delivered }); }
      return done({ ...base, final: false, why: gap ? "held_dropped_gap" : "held_for_join", utterance: delivered });
    }
    const h = s.held;
    s.held = null;
    const why: ListenOutcome["why"] = gap ? "held_dropped_gap" : silence >= this.finalMs() ? "quiet_tail" : "short_chunk";
    const parts = [...(h?.samples ?? []), samples];
    const seqs = [...(h?.seqs ?? []), c.seq];
    let cost = 0;
    let heard: Heard;
    const w = s.waiting;
    if (w) {
      this.clearWait(s);
      // A strong cut is always joined; a number is joined only when the next words carry it on.
      const next = w.strong ? null : await this.ear(s, c.session_id, parts, seqs, sampleRate, silence, arrived);
      if (next) cost += next.cost_usd;
      if (w.strong || continuesNumber(next!.text)) {
        heard = await this.ear(s, c.session_id, [...w.samples, ...parts], [...w.seqs, ...seqs], sampleRate, silence, arrived);
        heard.cost_usd += w.cost_usd + cost;
        heard.joined = true;
        cost = heard.cost_usd;
        const u = await this.settleHeard(s, c.session_id, heard, "joined_across_cut");
        return done(this.outcomeOf(base, heard, u ?? delivered, u ? "joined_across_cut" : "held_for_number", cost));
      }
      delivered = await this.deliver(s, c.session_id, w, "number_alone");
      heard = next!;
    } else {
      heard = await this.ear(s, c.session_id, parts, seqs, sampleRate, silence, arrived);
      cost = heard.cost_usd;
    }
    if (!heard.text) return done({ ...this.outcomeOf(base, heard, delivered, "empty", cost), final: true });
    const u = await this.settleHeard(s, c.session_id, heard, why);
    return done(this.outcomeOf(base, heard, u ?? delivered, u ? why : "held_for_number", cost));
  }

  private outcomeOf(base: Omit<ListenOutcome, "final" | "why">, h: Heard, u: ListenUtterance | null, why: ListenOutcome["why"], cost: number): ListenOutcome {
    return { ...base, final: why !== "held_for_number", why, audio_ms: h.audio_ms, transcript: h.text, raw_transcript: h.raw, cost_usd: cost, keywords_dropped: h.keywords_dropped, utterance: u };
  }

  // Delivers a finished transcript, or keeps it waiting for the next chunk when it ends mid-number.
  private async settleHeard(s: Session, sessionId: string, h: Heard, why: ListenOutcome["why"]): Promise<ListenUtterance | null> {
    if (!h.text) return null;
    const end = danglingEnd(h.text);
    if (!end || this.closed) return this.deliver(s, sessionId, h, why);
    h.strong = end === "strong";
    s.waiting = h;
    // A line that ends on a number may be complete, so its decision starts while it waits; the runtime uses it only if these same words are delivered.
    if (!h.strong) this.rt.speculate({ owner: s.owner, ctx: s.ctx, session_id: sessionId, text: h.text, clip: encodeWav(concat(h.samples), h.rate) });
    const timer = setTimeout(() => {
      s.timer = null;
      s.chain = s.chain.then(async () => { if (s.waiting === h) { s.waiting = null; await this.deliver(s, sessionId, h, "number_alone"); } })
        .catch((e: unknown) => { s.errors.push(e instanceof Error ? e.message.slice(0, 200) : "listen failed"); });
    }, h.strong ? this.o.strongJoinWaitMs ?? STRONG_JOIN_WAIT_MS : this.o.numberJoinWaitMs ?? NUMBER_JOIN_WAIT_MS);
    timer.unref?.();
    s.timer = timer;
    return null;
  }

  // Transcribes one stretch of audio with vitals words first in the hints, then cleans it and applies the vitals vocabulary.
  private async ear(s: Session, sessionId: string, parts: Float32Array[], seqs: number[], rate: number, silence: number, arrived: number): Promise<Heard> {
    const joined = encodeWav(concat(parts), rate);
    const keywords = buildKeywords({ vitals: VITALS_KEYWORDS, wards: [], documents: s.ctx.keywords, staff: [], beds: [] });
    const asrId = `${sessionId}-${seqs.length > 1 ? `${seqs[0]}.` : ""}${seqs.at(-1)}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
    let heard: FinalTranscript;
    let dropped = false;
    // The voiceprint is worked out while the words are transcribed, so attribution adds no time to the line.
    const print = this.o.embed && this.guard.lineOf(sessionId, seqs).live !== false ? this.o.embed(joined).catch(() => null) : Promise.resolve(null);
    try {
      heard = await this.o.transcribe(joined, keywords, asrId);
    } catch (e) {
      if (!(e instanceof VoiceError)) throw e;
      // A hint the service refuses must not lose the clinician's words, so one retry goes without hints.
      if (e.status !== 400 || !keywords.length) throw new ListenError(e.code === "bad_wav" ? 400 : 502, e.message);
      dropped = true;
      heard = await this.o.transcribe(joined, [], `${asrId}-nk`.slice(0, 64));
    }
    const v = vitalsVocabulary(cleanTranscript(heard.text));
    const voiceprint = await print;
    return { samples: parts, seqs, rate, audio_ms: totalMs(parts, rate), trailing_ms: silence, arrived, text: v.text, raw: heard.text, cost_usd: heard.cost_usd, keywords_dropped: dropped, rewrites: v.rewrites, strong: false, joined: false, heard_at: Date.now(), voiceprint };
  }

  // Hands one finished utterance to the runtime as an ambient line, with its audio kept in memory for the second ear.
  private async deliver(s: Session, sessionId: string, h: Heard, why: ListenOutcome["why"]): Promise<ListenUtterance> {
    // A joined line that waited again and went on alone still says it was joined.
    const finished = h.joined && why === "number_alone" ? "joined_across_cut" : why;
    // A line said while the person was not at the screen keeps its words but never reaches the voice match.
    const present = this.guard.lineOf(sessionId, h.seqs);
    const absent = present.live === false ? { voiceprint: null, unverified_reason: `not_present:${present.reason}` } : null;
    const r = await this.rt.say({
      owner: s.owner, target: { admission_id: s.ctx.admission_id }, text: h.text, source: "audio", spoken_at: new Date(h.arrived - h.audio_ms).toISOString(),
      audio: { audio_ms: h.audio_ms, cost_usd: h.cost_usd, session_id: sessionId },
      ambient: { session_id: sessionId, seqs: h.seqs, raw_text: h.raw.slice(0, 2000), ended_at: new Date(h.arrived - h.trailing_ms).toISOString(), final_at: new Date(h.arrived).toISOString(), trailing_silence_ms: h.trailing_ms, finished_by: finished },
      context: s.ctx, clip: encodeWav(concat(h.samples), h.rate), rewrites: h.rewrites, heard_at: h.heard_at, ...(this.o.embed ? absent ?? { voiceprint: h.voiceprint } : {})
    });
    const u: ListenUtterance = { id: r.line_id, line_id: r.line_id, task_id: r.task_id, text: h.text, seqs: h.seqs, class: null, classes: [] };
    s.unreported.push(u);
    return u;
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
