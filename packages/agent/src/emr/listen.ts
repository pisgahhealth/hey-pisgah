import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { VITALS_KEYWORDS, VoiceError, buildKeywords, cleanTranscript, concat, continuesNumber, danglingEnd, wholeInRange, decodeWav, encodeWav, leadingSilenceMs, parseWav, trailingSilenceMs, vitalsVocabulary, type FinalTranscript, type Rewrite } from "@hey-pisgah/voice";
import type { EmrRuntime } from "./runtime.js";
import { primaryClass } from "./classes.js";
import { afterWake } from "./entry.js";
import type { EmrContext, EmrTarget } from "./port.js";
import { LINE_MATCH_MAX_MS, ReplayGuard, matchWindows, printLine, type Embedder, type GuardVerdict, type HeartbeatOf, type LivenessMarker, type PresenceMode, type PresenceRule, type Voiceprint } from "./speaker.js";

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
// How long audio held at the cap waits for a next chunk or the strip's end marker before it is finished alone; longer than one capped chunk.
export const HELD_END_WAIT_MS = CHUNK_CAP_MS + 2000;

// One stretch the streaming ear ended at a pause, with its words, its audio and the quiet already heard at its end.
export type StreamSegment = { owner: string; target: EmrTarget; session_id: string; samples: Float32Array; rate: number; raw: string; trailing_ms: number; arrived: number; heard_at?: number };
export type ListenChunk = { owner: string; target: EmrTarget; session_id: string; seq: number; wav: Uint8Array; arrived_at?: number; captured_at?: number; presence?: LivenessMarker | null };
// The strip's end-of-utterance marker: no audio, only the place in the session where speech stopped.
export type ListenEnd = Omit<ListenChunk, "wav">;
// What the strip shows for each utterance: accepted on arrival, processing while heard or held, then failed or completed.
export type UtteranceStatus = { status: "accepted" | "processing" | "failed" | "completed"; waiting?: "join"; error?: string; task_id?: string; line_id?: string; note?: string };
export type ListenUtterance = { id: string; line_id: string; task_id: string; text: string; seqs: number[]; class: string | null; classes: string[] };
export type ListenOutcome = {
  seq: number; final: boolean;
  why: "quiet_tail" | "short_chunk" | "released_whole" | "pause_after_cap" | "held_for_join" | "held_for_number" | "joined_across_cut" | "number_alone" | "empty" | "duplicate" | "late" | "held_dropped_gap" | "held_too_long" | "failed" | "end_marker" | "held_timeout";
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
  // Other first-ear readings of the same audio, cleaned the same way, for the second-opinion rule.
  alternates?: string[];
  // Set when a whole-number line was delivered at once (D17) and still waits for a continuation; it is never delivered again.
  released?: ListenUtterance;
  // The released line this one carries on ("eighty" then "two"), so the record it wrote is amended.
  continues?: string;
  // The segment's voiceprint from the local speaker model, worked out beside the transcription; the audio itself is never kept.
  voiceprint: Voiceprint | null;
};
type Session = {
  owner: string; ctx: EmrContext; next: number; held: Held | null; waiting: Heard | null; timer: NodeJS.Timeout | null; heldTimer: NodeJS.Timeout | null; outcomes: Map<number, ListenOutcome>;
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
  // In heartbeat presence, the strip session's signed heartbeat, given by the agent service.
  heartbeat?: HeartbeatOf;
  heldEndWaitMs?: number;
  // Staff names sent in the recognition hints after the patient's own words; empty unless the serve is given them.
  staff?: readonly string[];
  // D17: a line ending on a whole-number vital in range is delivered at once, and a continuation inside the number wait amends it.
  releaseWhole?: boolean;
  onStatus?: (owner: string, sessionId: string, seq: number, st: UtteranceStatus) => void;
};

const totalMs = (parts: readonly Float32Array[], rate: number) => Math.round((parts.reduce((n, p) => n + p.length, 0) / rate) * 1000);

// Continuous listening: chunks of one session are heard in order, capped chunks are joined as audio, a number cut at a pause is joined with what follows, and only a finished utterance reaches the runtime.
export class ListenSessions {
  private readonly sessions = new Map<string, Session>();
  private closed = false;
  private readonly guard: ReplayGuard;
  constructor(private readonly rt: EmrRuntime, private readonly o: ListenOptions) { this.guard = new ReplayGuard(o.presence ?? "observed", o.presenceRule, o.replay === "refuse", o.heartbeat); }

  // The one live check for audio from either path: a strip chunk, or a piece of a frames stream (its samples as given, numbered by the stream).
  admit(c: { owner: string; session_id: string; seq: number | string; samples: Float32Array; rate: number; arrived_at?: number; captured_at?: number | undefined; presence?: LivenessMarker | null | undefined }): GuardVerdict {
    const bytes = new Uint8Array(c.samples.buffer, c.samples.byteOffset, c.samples.byteLength);
    let speech = false;
    for (const v of c.samples) if (Math.abs(v) > 0.01) { speech = true; break; }
    return this.guard.check({ owner: c.owner, session_id: c.session_id, seq: c.seq, wav: bytes, audio_ms: Math.round((c.samples.length / c.rate) * 1000), speech, arrived_at: c.arrived_at ?? this.now(), captured_at: c.captured_at, marker: c.presence });
  }

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
    const { samples, sampleRate } = decodeWav(c.wav);
    const g = this.admit({ owner: c.owner, session_id: c.session_id, seq: c.seq, samples, rate: sampleRate, arrived_at: c.arrived_at ?? this.now(), captured_at: c.captured_at, presence: c.presence });
    if (g.refused) throw new ListenError(409, `replayed audio refused: ${g.refused}`);
    return this.queue(c, info.durationMs, (sess) => this.hear(sess, c), wait);
  }

  // The strip's marker that speech stopped: audio held at the cap is finished now instead of waiting for a chunk that will never come.
  async end(c: ListenEnd, wait = false): Promise<ListenReply> {
    return this.queue(c, 0, (sess) => this.hearEnd(sess, c), wait);
  }

  private async queue(c: ListenEnd, audioMs: number, work: (s: Session) => Promise<ListenOutcome>, wait: boolean): Promise<ListenReply> {
    const sess = await this.sessionFor(c.owner, c.target, c.session_id, c.arrived_at ?? this.now());
    this.status(sess, c.session_id, [c.seq], { status: "accepted" });
    const run = sess.chain.then(() => { this.status(sess, c.session_id, [c.seq], { status: "processing" }); return work(sess); }).then((out) => this.after(sess, c.session_id, out)).catch((e: unknown): ListenOutcome => {
      const msg = e instanceof Error ? e.message.slice(0, 200) : "listen failed";
      sess.errors.push(`seq ${c.seq}: ${msg}`);
      this.status(sess, c.session_id, [c.seq], { status: "failed", error: `Not heard: ${msg}` });
      return { seq: c.seq, final: false, why: "failed", trailing_silence_ms: 0, audio_ms: audioMs, transcript: null, raw_transcript: null, cost_usd: 0, keywords_dropped: false, utterance: null, error: msg };
    });
    sess.chain = run;
    const outcome = wait ? await run : undefined;
    const utterances = sess.unreported.splice(0).map((u) => this.withClass(u));
    const errors = sess.errors.splice(0);
    return { session_id: c.session_id, seq: c.seq, accepted: true, utterances, partial: null, ...(outcome ? { outcome } : {}), ...(errors.length ? { errors } : {}) };
  }

  private async sessionFor(owner: string, target: EmrTarget, sessionId: string, at: number): Promise<Session> {
    let s = this.sessions.get(sessionId);
    if (s && s.owner !== owner) throw new ListenError(403, "the session belongs to another owner");
    if (!s) {
      const ctx = await this.rt.port.resolve(target, { owner, evidence: `transcript:listen-${sessionId}`.slice(0, 200), spoken_at: new Date(at).toISOString() });
      s = this.sessions.get(sessionId) ?? { owner, ctx, next: 0, held: null, waiting: null, timer: null, heldTimer: null, outcomes: new Map(), chain: Promise.resolve(), dropped: 0, unreported: [], errors: [] };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  // The recognition hints a session sends: vitals words first, then the patient's own words and the staff names.
  async hintsFor(owner: string, target: EmrTarget, sessionId: string, at: number): Promise<string[]> {
    return this.keywordsOf(await this.sessionFor(owner, target, sessionId, at));
  }

  private keywordsOf(s: Session): string[] {
    return buildKeywords({ vitals: VITALS_KEYWORDS, wards: [], documents: s.ctx.keywords, staff: this.o.staff ?? [], beds: [] });
  }

  // One finished stretch from the streaming ear: its words are already heard, so only the join and delivery rules run; a number wait counts the quiet already heard.
  async segment(c: StreamSegment): Promise<ListenUtterance[]> {
    const s = await this.sessionFor(c.owner, c.target, c.session_id, c.arrived);
    const seq = s.next++;
    this.status(s, c.session_id, [seq], { status: "processing" });
    const run = s.chain.then(async () => {
      // The words carried across a wake are dropped from the line here too, as on the chunk path.
      const v = vitalsVocabulary(afterWake(cleanTranscript(c.raw)));
      const print = this.o.embed ? printLine(this.o.embed, matchWindows([c.samples], c.rate), c.rate) : Promise.resolve(null);
      const heard: Heard = {
        samples: [c.samples], seqs: [seq], rate: c.rate, audio_ms: totalMs([c.samples], c.rate), trailing_ms: c.trailing_ms, arrived: c.arrived,
        text: v.text, raw: c.raw, cost_usd: 0, keywords_dropped: false, rewrites: v.rewrites, strong: false, joined: false, heard_at: c.heard_at ?? this.now(), voiceprint: await print
      };
      if (!heard.text) return;
      const w = s.waiting;
      if (w && w.rate === c.rate) {
        this.clearWait(s);
        // A strong cut is always joined; a number is joined only when these words carry it on.
        if (w.strong || continuesNumber(heard.text)) {
          const raw = `${w.raw.replace(/[.,;:!?]+$/, "")} ${c.raw}`;
          const jv = vitalsVocabulary(cleanTranscript(raw));
          // The joined line is matched on every piece it was heard in, so a continuation in another voice never inherits the first speaker's authority.
          const samples = [...w.samples, c.samples];
          const voiceprint = this.o.embed ? await printLine(this.o.embed, matchWindows(samples, c.rate), c.rate) : null;
          const joined: Heard = { ...heard, samples, seqs: [...w.seqs, seq], audio_ms: w.audio_ms + heard.audio_ms, text: jv.text, raw, rewrites: jv.rewrites, joined: true, voiceprint, ...(w.released ? { continues: w.released.line_id } : {}) };
          await this.settleHeard(s, c.session_id, joined, "joined_across_cut", joined.trailing_ms);
          return;
        }
        await this.deliver(s, c.session_id, w, "number_alone");
      } else if (w) {
        this.clearWait(s);
        await this.deliver(s, c.session_id, w, "number_alone");
      }
      await this.settleHeard(s, c.session_id, heard, "quiet_tail", heard.trailing_ms);
    }).catch((e: unknown) => { s.errors.push(`segment ${seq}: ${e instanceof Error ? e.message.slice(0, 200) : "listen failed"}`); });
    s.chain = run;
    await run;
    return s.unreported.splice(0).map((u) => this.withClass(u));
  }

  // Words the streaming ear hears while a number-ended line waits: two or more words that do not carry the number on let the line go now.
  nextWords(sessionId: string, partial: string): void {
    const s = this.sessions.get(sessionId);
    const w = s?.waiting;
    if (!s || !w || w.strong || partial.trim().split(/\s+/).length < 2 || continuesNumber(vitalsVocabulary(cleanTranscript(partial)).text)) return;
    this.clearWait(s);
    s.chain = s.chain.then(() => this.deliver(s, sessionId, w, "number_alone")).catch((e: unknown) => { s.errors.push(e instanceof Error ? e.message.slice(0, 200) : "listen failed"); });
  }

  // Utterances finished since the last read, and errors, for a caller that does not post chunks.
  unreportedOf(sessionId: string): { utterances: ListenUtterance[]; errors: string[] } {
    const s = this.sessions.get(sessionId);
    return { utterances: (s?.unreported.splice(0) ?? []).map((u) => this.withClass(u)), errors: s?.errors.splice(0) ?? [] };
  }

  private status(s: Session, sessionId: string, seqs: readonly number[], st: UtteranceStatus): void {
    for (const seq of seqs) this.o.onStatus?.(s.owner, sessionId, seq, st);
  }

  // A chunk that did not finish a line is still being heard, held for the next words; an empty one is done with nothing to act on.
  private after(s: Session, sessionId: string, out: ListenOutcome): ListenOutcome {
    if (out.why === "empty") this.status(s, sessionId, [out.seq], { status: "completed", note: "nothing heard" });
    else if (out.why === "held_too_long") this.status(s, sessionId, [out.seq], { status: "failed", error: "Not heard: too long without a pause." });
    else if (!out.utterance || !out.utterance.seqs.includes(out.seq)) {
      if (out.why === "held_for_join" || out.why === "held_for_number" || out.why === "held_dropped_gap") this.status(s, sessionId, [out.seq], { status: "processing", waiting: "join" });
      else if (out.why === "end_marker" || out.why === "late" || out.why === "duplicate") this.status(s, sessionId, [out.seq], { status: "completed" });
    }
    return out;
  }

  private clearHeld(s: Session): void {
    if (s.heldTimer) clearTimeout(s.heldTimer);
    s.heldTimer = null;
  }

  // Held audio that nothing follows is finished alone after the wait, on the session's own chain.
  private armHeld(s: Session, sessionId: string): void {
    this.clearHeld(s);
    const h = s.held;
    if (!h || this.closed) return;
    const t = setTimeout(() => {
      s.heldTimer = null;
      s.chain = s.chain.then(async () => { if (s.held === h) await this.finishHeld(s, sessionId, "held_timeout"); })
        .catch((e: unknown) => { const msg = e instanceof Error ? e.message.slice(0, 200) : "listen failed"; s.errors.push(msg); this.status(s, sessionId, h.seqs, { status: "failed", error: `Not heard: ${msg}` }); });
    }, this.o.heldEndWaitMs ?? HELD_END_WAIT_MS);
    t.unref?.();
    s.heldTimer = t;
  }

  private async finishHeld(s: Session, sessionId: string, why: ListenOutcome["why"]): Promise<ListenUtterance | null> {
    const h = s.held;
    if (!h) return null;
    s.held = null;
    this.clearHeld(s);
    try {
      const heard = await this.ear(s, sessionId, h.samples, h.seqs, h.rate, h.trailing_ms, h.arrived);
      if (!heard.text) { this.status(s, sessionId, h.seqs, { status: "completed", note: "nothing heard" }); return null; }
      return await this.settleHeard(s, sessionId, heard, why);
    } catch (e) {
      this.status(s, sessionId, h.seqs, { status: "failed", error: `Not heard: ${e instanceof Error ? e.message.slice(0, 200) : "listen failed"}` });
      throw e;
    }
  }

  private async hearEnd(s: Session, c: ListenEnd): Promise<ListenOutcome> {
    const base = { seq: c.seq, trailing_silence_ms: 0, audio_ms: 0, transcript: null, raw_transcript: null, cost_usd: 0, keywords_dropped: false, utterance: null };
    const prior = s.outcomes.get(c.seq);
    if (prior) return { ...prior, why: "duplicate" };
    if (c.seq < s.next) return { ...base, final: false, why: "late" };
    // A missing chunk before the marker means the held audio is not the whole utterance, so it is dropped as a chunk would drop it.
    if (c.seq > s.next && s.held) { this.status(s, c.session_id, s.held.seqs, { status: "failed", error: "Not heard: part of the audio never arrived." }); s.held = null; s.dropped += 1; this.clearHeld(s); }
    s.next = c.seq + 1;
    const u = await this.finishHeld(s, c.session_id, "end_marker");
    const out: ListenOutcome = { ...base, final: true, why: "end_marker", utterance: u };
    s.outcomes.set(c.seq, out);
    return out;
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
    for (const s of this.sessions.values()) { this.clearWait(s); this.clearHeld(s); }
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
    this.clearHeld(s);
    let gap = false;
    let delivered: ListenUtterance | null = null;
    const alone = async () => { const w = s.waiting; if (w) { this.clearWait(s); delivered = await this.deliver(s, c.session_id, w, "number_alone"); } };
    // A missing chunk means the held audio is not the whole utterance, so it is dropped rather than finished; a finished line waiting on it goes on alone.
    if (c.seq > s.next && s.held) { this.status(s, c.session_id, s.held.seqs, { status: "failed", error: "Not heard: part of the audio never arrived." }); s.held = null; s.dropped += 1; gap = true; }
    if (c.seq > s.next) await alone();
    s.next = c.seq + 1;
    if (s.held && s.held.rate !== sampleRate) { s.held = null; s.dropped += 1; }
    if (s.waiting && s.waiting.rate !== sampleRate) await alone();
    // A cap that fell in the quiet after speech left a whole utterance on hold; when the pause runs on into this chunk, that utterance is finished alone.
    if (s.held) {
      const pause = s.held.trailing_ms + leadingSilenceMs(samples, sampleRate) + Math.max(0, arrived - s.held.arrived - audioMs);
      if (pause >= this.finalMs()) delivered = (await this.finishHeld(s, c.session_id, "pause_after_cap")) ?? delivered;
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
      if (h.audio_ms > (this.o.maxHeldMs ?? MAX_HELD_MS)) { this.status(s, c.session_id, h.seqs, { status: "failed", error: "Not heard: too long without a pause." }); s.held = null; s.dropped += 1; return done({ ...base, final: false, why: "held_too_long", utterance: delivered }); }
      this.armHeld(s, c.session_id);
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
        if (w.released) heard.continues = w.released.line_id;
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
  private async settleHeard(s: Session, sessionId: string, h: Heard, why: ListenOutcome["why"], quietHeardMs = 0): Promise<ListenUtterance | null> {
    if (!h.text) return null;
    const end = danglingEnd(h.text);
    if (!end || this.closed) return this.deliver(s, sessionId, h, why);
    h.strong = end === "strong";
    // D17: a whole number in range is written now; the line still waits, delivered, so a continuation can amend it.
    if (!h.strong && this.o.releaseWhole && wholeInRange(h.text)) h.released = await this.deliver(s, sessionId, h, "released_whole");
    s.waiting = h;
    // A line that ends on a number may be complete, so its decision starts while it waits; the runtime uses it only if these same words are delivered.
    if (!h.strong && !h.released) this.rt.speculate({ owner: s.owner, ctx: s.ctx, session_id: sessionId, text: h.text, clip: encodeWav(concat(h.samples), h.rate) });
    const timer = setTimeout(() => {
      s.timer = null;
      s.chain = s.chain.then(async () => { if (s.waiting === h) { s.waiting = null; await this.deliver(s, sessionId, h, "number_alone"); } })
        .catch((e: unknown) => { s.errors.push(e instanceof Error ? e.message.slice(0, 200) : "listen failed"); });
    }, Math.max(0, (h.strong ? this.o.strongJoinWaitMs ?? STRONG_JOIN_WAIT_MS : this.o.numberJoinWaitMs ?? NUMBER_JOIN_WAIT_MS) - quietHeardMs));
    timer.unref?.();
    s.timer = timer;
    return h.released ?? null;
  }

  // Transcribes one stretch of audio with vitals words first in the hints, then cleans it and applies the vitals vocabulary.
  private async ear(s: Session, sessionId: string, parts: Float32Array[], seqs: number[], rate: number, silence: number, arrived: number): Promise<Heard> {
    const joined = encodeWav(concat(parts), rate);
    const keywords = this.keywordsOf(s);
    const asrId = `${sessionId}-${seqs.length > 1 ? `${seqs[0]}.` : ""}${seqs.at(-1)}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
    let heard: FinalTranscript;
    let dropped = false;
    // The voiceprint is worked out while the words are transcribed, so attribution adds no time to the line; each heard piece is its own window.
    const print = this.o.embed && this.guard.lineOf(sessionId, seqs, s.owner).live !== false ? printLine(this.o.embed, matchWindows(parts, rate), rate) : Promise.resolve(null);
    try {
      heard = await this.o.transcribe(joined, keywords, asrId);
    } catch (e) {
      if (!(e instanceof VoiceError)) throw e;
      // A hint the service refuses must not lose the clinician's words, so one retry goes without hints.
      if (e.status !== 400 || !keywords.length) throw new ListenError(e.code === "bad_wav" ? 400 : 502, e.message);
      dropped = true;
      heard = await this.o.transcribe(joined, [], `${asrId}-nk`.slice(0, 64));
    }
    const v = vitalsVocabulary(afterWake(cleanTranscript(heard.text)));
    const voiceprint = await print;
    const alternates = heard.alternates?.map((x) => vitalsVocabulary(afterWake(cleanTranscript(x))).text);
    return { samples: parts, seqs, rate, audio_ms: totalMs(parts, rate), trailing_ms: silence, arrived, text: v.text, raw: heard.text, cost_usd: heard.cost_usd, keywords_dropped: dropped, rewrites: v.rewrites, strong: false, joined: false, heard_at: Date.now(), voiceprint, ...(alternates?.length ? { alternates } : {}) };
  }

  // Hands one finished utterance to the runtime as an ambient line, with its audio kept in memory for the second ear.
  private async deliver(s: Session, sessionId: string, h: Heard, why: ListenOutcome["why"]): Promise<ListenUtterance> {
    // A released line that nothing carried on is already with the runtime.
    if (h.released && why === "number_alone") return h.released;
    // A joined line that waited again and went on alone still says it was joined.
    const finished = h.joined && why === "number_alone" ? "joined_across_cut" : why;
    // A line said while the person was not at the screen keeps its words but never reaches the voice match.
    const present = this.guard.lineOf(sessionId, h.seqs, s.owner);
    const tooLong = h.audio_ms > LINE_MATCH_MAX_MS ? { voiceprint: null, unverified_reason: "too_long_to_match" } : null;
    const absent = present.live === false ? { voiceprint: null, unverified_reason: `not_present:${present.reason}` } : tooLong;
    // A patient with no admission yet (or none the port knows after a restart) is named by the patient, so the line still reaches that patient's tasks.
    const target: EmrTarget = { admission_id: s.ctx.admission_id, ...(!s.ctx.admission_id && s.ctx.patient_id ? { patient_id: s.ctx.patient_id } : {}) };
    const r = await this.rt.say({
      owner: s.owner, target, text: h.text, source: "audio", spoken_at: new Date(h.arrived - h.audio_ms).toISOString(),
      audio: { audio_ms: h.audio_ms, cost_usd: h.cost_usd, session_id: sessionId },
      ambient: { session_id: sessionId, seqs: h.seqs, raw_text: h.raw.slice(0, 2000), ended_at: new Date(h.arrived - h.trailing_ms).toISOString(), final_at: new Date(h.arrived).toISOString(), trailing_silence_ms: h.trailing_ms, finished_by: finished, ...(why === "released_whole" ? { released: true } : {}), ...(h.continues ? { continues: h.continues } : {}) },
      context: s.ctx, clip: encodeWav(concat(h.samples), h.rate), rewrites: h.rewrites, heard_at: h.heard_at, ...(h.alternates ? { alternates: h.alternates } : {}), ...(this.o.embed ? absent ?? { voiceprint: h.voiceprint } : {})
    });
    const u: ListenUtterance = { id: r.line_id, line_id: r.line_id, task_id: r.task_id, text: h.text, seqs: h.seqs, class: null, classes: [] };
    s.unreported.push(u);
    this.status(s, sessionId, h.seqs, { status: "completed", task_id: r.task_id, line_id: r.line_id });
    return u;
  }
}

// Sends the same audio to the first ear several times at once; the first reading that answers in order is the line, and the others ride along as alternates.
export function parallelReadings(inner: Transcriber, n: number): Transcriber {
  if (n <= 1) return inner;
  return async (wav, keywords, sessionId) => {
    const rs = await Promise.allSettled(Array.from({ length: n }, (_, i) => inner(wav, keywords, i ? `${sessionId.slice(0, 60)}-r${i}` : sessionId)));
    const ok = rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (!ok.length) throw (rs[0] as PromiseRejectedResult).reason;
    const [first, ...rest] = ok as [FinalTranscript, ...FinalTranscript[]];
    return { ...first, cost_usd: ok.reduce((c, r) => c + r.cost_usd, 0), alternates: rest.map((r) => r.text) };
  };
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
