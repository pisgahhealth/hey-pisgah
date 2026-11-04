import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { open as openSealed, seal } from "@hey-pisgah/store";
import { VITALS_KEYWORDS, VoiceError, buildKeywords, cleanTranscript, concat, continuesNumber, danglingEnd, wholeInRange, decodeWav, encodeWav, leadingSilenceMs, parseWav, trailingSilenceMs, vitalsVocabulary, type FinalTranscript, type Rewrite } from "@hey-pisgah/voice";
import type { EmrRuntime } from "./runtime.js";
import { primaryClass } from "./classes.js";
import { afterWake } from "./entry.js";
import type { EmrContext, EmrTarget } from "./port.js";
import { LINE_MATCH_MAX_MS, LISTEN_WINDOW_MS, ReplayGuard, matchWindows, printLine, type Embedder, type GuardVerdict, type HeartbeatOf, type LivenessMarker, type PresenceMode, type PresenceRule, type Voiceprint } from "./speaker.js";

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
// The quiet after speech at which the strip ends a chunk; a shorter pause between two flushed chunks is inside one utterance.
export const STRIP_TAIL_MS = 700;
// How long audio held at the cap waits for a next chunk or the strip's end marker before it is finished alone; longer than one capped chunk.
export const HELD_END_WAIT_MS = CHUNK_CAP_MS + 2000;
// How many finished chunks are transcribed at once ahead of the session's chain, across all sessions.
export const READS_IN_FLIGHT = 3;

// One stretch the streaming ear ended at a pause, with its words, its audio and the quiet already heard at its end.
// A stretch the fallback ear read is delivered as it is, never joined, and its voiceprint may already be under way.
export type StreamSegment = { owner: string; target: EmrTarget; session_id: string; samples: Float32Array; rate: number; raw: string; trailing_ms: number; arrived: number; heard_at?: number; capture_start?: number; capture_end?: number; turn_seq?: number; finished_by?: "fallback_parakeet"; voiceprint?: Promise<Voiceprint | null> };
export type ListenChunk = { owner: string; target: EmrTarget; session_id: string; seq: number; wav: Uint8Array; arrived_at?: number; captured_at?: number; presence?: LivenessMarker | null };
// The strip's end-of-utterance marker: no audio, only the place in the session where speech stopped.
export type ListenEnd = Omit<ListenChunk, "wav">;
// What the strip shows for each utterance: accepted on arrival, processing while heard or held, then failed or completed.
export type UtteranceStatus = { status: "accepted" | "processing" | "failed" | "completed"; waiting?: "join"; error?: string; task_id?: string; line_id?: string; note?: string };
export type ListenUtterance = { id: string; line_id: string; task_id: string; text: string; seqs: number[]; class: string | null; classes: string[] };
export type ListenOutcome = {
  seq: number; final: boolean;
  why: "quiet_tail" | "short_chunk" | "released_whole" | "pause_after_cap" | "held_for_join" | "held_for_number" | "joined_across_cut" | "number_alone" | "empty" | "duplicate" | "late" | "held_dropped_gap" | "held_too_long" | "failed" | "end_marker" | "held_timeout" | "fallback_parakeet";
  trailing_silence_ms: number; audio_ms: number; transcript: string | null; raw_transcript: string | null; cost_usd: number; keywords_dropped: boolean;
  utterance: ListenUtterance | null; error?: string;
};
// What POST /tasks/listen answers: the utterances finished since the last answer, and, when the caller waited, this chunk's outcome.
export type ListenReply = { session_id: string; seq: number; accepted: true; utterances: ListenUtterance[]; partial: null; outcome?: ListenOutcome; errors?: string[] };
// short marks audio held because the strip cut it before its quiet tail while later chunks were already waiting, as when held chunks are flushed at once.
type Held = { samples: Float32Array[]; seqs: number[]; audio_ms: number; rate: number; trailing_ms: number; arrived: number; capture_start?: number; capture_end?: number; short?: boolean };
// One transcribed stretch of audio, either finished or waiting for the next chunk because it ends mid-number.
type Heard = {
  samples: Float32Array[]; seqs: number[]; rate: number; audio_ms: number; trailing_ms: number; arrived: number;
  text: string; raw: string; cost_usd: number; keywords_dropped: boolean; rewrites: Rewrite[]; strong: boolean; joined: boolean; heard_at: number; capture_start?: number; capture_end?: number; turn_seqs?: number[];
  // Other first-ear readings of the same audio, cleaned the same way, for the second-opinion rule.
  alternates?: string[];
  // Set when a whole-number line was delivered at once (D17) and still waits for a continuation; it is never delivered again.
  released?: ListenUtterance;
  // The released line this one carries on ("eighty" then "two"), so the record it wrote is amended.
  continues?: string;
  // Words kept across a restart without their audio: the line is joined by its words and no voice match can cover them.
  partial?: boolean;
  // The segment's voiceprint from the local speaker model, worked out beside the transcription; the audio itself is never kept.
  voiceprint: Voiceprint | null;
};
// One transcription started when its chunk arrived, used by the chain when it reaches those same chunks.
type Read = { heard: FinalTranscript; dropped: boolean; at: number; voiceprint: Voiceprint | null };
type Session = {
  owner: string; ctx: EmrContext; next: number; held: Held | null; waiting: Heard | null; timer: NodeJS.Timeout | null; heldTimer: NodeJS.Timeout | null; outcomes: Map<number, ListenOutcome>;
  chain: Promise<unknown>; dropped: number; unreported: ListenUtterance[]; errors: string[];
  // The chunks as they arrive, ahead of the chain: the next number expected, the capped audio held so far, and the transcriptions under way by chunk numbers.
  seen: number; ahead: Held | null; reads: Map<string, Promise<Read>>;
  // How many chunks and markers are queued behind the one being heard.
  queued: number;
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
  // Where a line waiting for its number keeps its words, never its audio, so a restart or another session for the same patient can finish it.
  joinFile?: string;
  // Given the clip of a line the fallback ear read, the serve routes that clip's second reading to an ear other than the one that read it and names it; without it the line says "none".
  fallbackClip?: (clip: Uint8Array) => "meta_rest" | "none";
};
// A line waiting for the rest of its number, as kept on disk: the owner, the patient, the words and when the wait began.
export type PendingJoin = { key: string; owner: string; target: EmrTarget; session_id: string; text: string; raw: string; strong: boolean; at: number; released: ListenUtterance | null };

const totalMs = (parts: readonly Float32Array[], rate: number) => Math.round((parts.reduce((n, p) => n + p.length, 0) / rate) * 1000);
// An early transcription is found by its chunk numbers and its length, so audio joined to words carried from elsewhere is never taken for it.
const readKey = (parts: readonly Float32Array[], seqs: readonly number[]) => `${seqs.join(",")}:${parts.reduce((n, p) => n + p.length, 0)}`;

// Continuous listening: chunks of one session are heard in order, capped chunks are joined as audio, a number cut at a pause is joined with what follows, and only a finished utterance reaches the runtime.
export class ListenSessions {
  private readonly sessions = new Map<string, Session>();
  private closed = false;
  private readonly guard: ReplayGuard;
  // The session holding each owner's waiting line for one patient, so the next words for that patient finish it whichever session they come on.
  private readonly waitingFor = new Map<string, { s: Session; sessionId: string }>();
  // Lines that were waiting when the serve last stopped, by owner and patient, each with its own deadline.
  private readonly restored = new Map<string, { p: PendingJoin; timer: NodeJS.Timeout }>();
  // A join file this serve could not read, kept aside under its own name with the reason.
  private joinTrouble: { kept: string; error: string } | null = null;
  // Sessions being opened, so two lines arriving together for a new session share it and keep their order.
  private readonly opening = new Map<string, Promise<Session>>();
  private reading = 0;
  private readonly readQueue: (() => void)[] = [];
  constructor(private readonly rt: EmrRuntime, private readonly o: ListenOptions) {
    this.guard = new ReplayGuard(o.presence ?? "observed", o.presenceRule, o.replay === "refuse", o.heartbeat);
    this.restore();
  }

  private joinKey(owner: string, ctx: EmrContext): string { return `${owner}\u0000${ctx.patient_id || ctx.admission_id || ""}`; }
  private persistJoins(): void {
    const f = this.o.joinFile;
    if (!f) return;
    const rows: PendingJoin[] = [...[...this.waitingFor.entries()].flatMap(([key, x]) => (x.s.waiting ? [{ key, owner: x.s.owner, target: x.s.ctx.admission_id ? { admission_id: x.s.ctx.admission_id } : { patient_id: x.s.ctx.patient_id ?? "" }, session_id: x.sessionId, text: x.s.waiting.text, raw: x.s.waiting.raw, strong: x.s.waiting.strong, at: x.s.waiting.arrived, released: x.s.waiting.released ?? null }] : [])), ...[...this.restored.values()].map((r) => r.p)];
    if (!rows.length && !existsSync(f)) return;
    mkdirSync(dirname(f), { recursive: true });
    // The waiting words are sealed under the store key like the rest of what was heard.
    writeFileSync(`${f}.next`, seal(JSON.stringify(rows), "join-pending"));
    renameSync(`${f}.next`, f);
  }
  private markWaiting(s: Session, sessionId: string): void {
    this.waitingFor.set(this.joinKey(s.owner, s.ctx), { s, sessionId });
    this.persistJoins();
  }
  private unmarkWaiting(s: Session): void {
    const key = this.joinKey(s.owner, s.ctx);
    if (this.waitingFor.get(key)?.s !== s) return;
    this.waitingFor.delete(key);
    this.persistJoins();
  }
  // A waiting line for this patient held by another session, or kept from before a restart, becomes this session's, so these words can carry it on.
  private adoptWaiting(s: Session, sessionId: string, rate: number): void {
    if (s.waiting) return;
    const key = this.joinKey(s.owner, s.ctx);
    const other = this.waitingFor.get(key);
    if (other && other.s !== s && other.s.waiting && other.s.waiting.rate === rate) {
      const w = other.s.waiting;
      this.status(other.s, other.sessionId, w.seqs, { status: "completed", note: "carried on in the next words" });
      this.clearWait(other.s);
      s.waiting = { ...w, seqs: [] };
      this.markWaiting(s, sessionId);
      return;
    }
    const r = this.restored.get(key);
    if (!r) return;
    clearTimeout(r.timer);
    this.restored.delete(key);
    s.waiting = this.wordsOnly(r.p, rate);
    this.markWaiting(s, sessionId);
  }
  private wordsOnly(p: PendingJoin, rate: number): Heard {
    return { samples: [], seqs: [], rate, audio_ms: 0, trailing_ms: 0, arrived: p.at, text: p.text, raw: p.raw, cost_usd: 0, keywords_dropped: false, rewrites: [], strong: p.strong, joined: false, heard_at: p.at, voiceprint: null, partial: true, ...(p.released ? { released: p.released } : {}) };
  }
  // Lines that were waiting when the serve stopped wait one more join window from now; with nothing to carry them on they go on alone, so no words are lost.
  private restore(): void {
    const f = this.o.joinFile;
    if (!f || !existsSync(f)) return;
    let rows: PendingJoin[];
    try {
      rows = JSON.parse(openSealed(readFileSync(f, "utf8"), "join-pending")) as PendingJoin[];
      if (!Array.isArray(rows)) throw new Error("the file is not a list of waiting lines");
    } catch (e) {
      // An unreadable file still holds words not yet written, so it is kept aside byte for byte and reported, never read as empty and overwritten.
      const kept = `${f}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      renameSync(f, kept);
      this.joinTrouble = { kept, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
      return;
    }
    for (const p of rows) {
      const timer = setTimeout(() => {
        if (this.restored.get(p.key)?.timer !== timer) return;
        this.restored.delete(p.key);
        this.persistJoins();
        void this.sessionFor(p.owner, p.target, `${p.session_id}`.slice(0, 80), this.now()).then((s) => {
          s.chain = s.chain.then(() => this.deliver(s, p.session_id, this.wordsOnly(p, 16_000), "number_alone")).catch((e: unknown) => { s.errors.push(e instanceof Error ? e.message.slice(0, 200) : "listen failed"); });
        }, () => undefined);
      }, p.strong ? this.o.strongJoinWaitMs ?? STRONG_JOIN_WAIT_MS : this.o.numberJoinWaitMs ?? NUMBER_JOIN_WAIT_MS);
      timer.unref?.();
      this.restored.set(p.key, { p, timer });
    }
  }

  // The one live check for audio from either path: a strip chunk, or a piece of a frames stream (its samples as given, numbered by the stream).
  admit(c: { owner: string; session_id: string; seq: number | string; samples: Float32Array; rate: number; arrived_at?: number; captured_at?: number | undefined; presence?: LivenessMarker | null | undefined }): GuardVerdict {
    const bytes = new Uint8Array(c.samples.buffer, c.samples.byteOffset, c.samples.byteLength);
    let speech = false;
    for (const v of c.samples) if (Math.abs(v) > 0.01) { speech = true; break; }
    return this.guard.check({ owner: c.owner, session_id: c.session_id, seq: c.seq, wav: bytes, audio_ms: Math.round((c.samples.length / c.rate) * 1000), speech, arrived_at: c.arrived_at ?? this.now(), captured_at: c.captured_at, marker: c.presence });
  }

  // The join file kept aside at start because it could not be read, or null.
  joinProblem(): { kept: string; error: string } | null { return this.joinTrouble ? { ...this.joinTrouble } : null; }

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
    // The chunk keeps the time it arrived, so a chain running behind never reads its own delay as a pause.
    const arrived = { ...c, arrived_at: c.arrived_at ?? this.now() };
    const g = this.admit({ owner: c.owner, session_id: c.session_id, seq: c.seq, samples, rate: sampleRate, arrived_at: arrived.arrived_at, captured_at: c.captured_at, presence: c.presence });
    if (g.refused) throw new ListenError(409, `replayed audio refused: ${g.refused}`);
    return this.queue(arrived, info.durationMs, (sess) => this.hear(sess, arrived), wait, (sess) => this.foresee(sess, arrived, samples, sampleRate));
  }

  // The strip's marker that speech stopped: audio held at the cap is finished now instead of waiting for a chunk that will never come.
  async end(c: ListenEnd, wait = false): Promise<ListenReply> {
    return this.queue(c, 0, (sess) => this.hearEnd(sess, c), wait, (sess) => { if (c.seq < sess.seen) return; const a = c.seq === sess.seen ? sess.ahead : null; sess.ahead = null; sess.seen = c.seq + 1; if (a) this.readAhead(sess, c.session_id, a.samples, a.seqs, a.rate); });
  }

  private async queue(c: ListenEnd, audioMs: number, work: (s: Session) => Promise<ListenOutcome>, wait: boolean, early?: (s: Session) => void): Promise<ListenReply> {
    const sess = await this.sessionFor(c.owner, c.target, c.session_id, c.arrived_at ?? this.now());
    this.status(sess, c.session_id, [c.seq], { status: "accepted" });
    early?.(sess);
    sess.queued += 1;
    const run = sess.chain.then(() => { sess.queued -= 1; this.status(sess, c.session_id, [c.seq], { status: "processing" }); return work(sess); }).then((out) => this.after(sess, c.session_id, out)).catch((e: unknown): ListenOutcome => {
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
    let s = this.sessions.get(sessionId) ?? await this.opening.get(sessionId);
    if (s && s.owner !== owner) throw new ListenError(403, "the session belongs to another owner");
    if (!s) {
      const open = this.rt.listenContext(target, { owner, evidence: `transcript:listen-${sessionId}`.slice(0, 200), spoken_at: new Date(at).toISOString() }).then((ctx) => {
        const made = this.sessions.get(sessionId) ?? { owner, ctx, next: 0, held: null, waiting: null, timer: null, heldTimer: null, outcomes: new Map(), chain: Promise.resolve(), dropped: 0, unreported: [], errors: [], seen: 0, ahead: null, reads: new Map(), queued: 0 };
        this.sessions.set(sessionId, made);
        return made;
      }).finally(() => { this.opening.delete(sessionId); });
      this.opening.set(sessionId, open);
      s = await open;
      if (s.owner !== owner) throw new ListenError(403, "the session belongs to another owner");
    }
    return s;
  }

  // The voiceprint of a stretch of audio, started by a caller as soon as the audio is complete; null without the speaker model.
  printOf(samples: Float32Array, rate: number): Promise<Voiceprint | null> {
    return this.o.embed ? printLine(this.o.embed, matchWindows([samples], rate, LISTEN_WINDOW_MS), rate) : Promise.resolve(null);
  }

  // The recognition hints a session sends: vitals words first, then the patient's own words and the staff names.
  async hintsFor(owner: string, target: EmrTarget, sessionId: string, at: number): Promise<string[]> {
    return this.keywordsOf(await this.sessionFor(owner, target, sessionId, at));
  }

  // The drug and test words the owner may order come after the staff names, so the cap trims them before anything sent before.
  private keywordsOf(s: Session): string[] {
    const o = this.rt.port.orderables?.();
    const orders = o ? [...Object.values(o.drugs).flatMap((d) => d.words), ...Object.values(o.tests).flat()] : [];
    return buildKeywords({ vitals: VITALS_KEYWORDS, wards: [], documents: s.ctx.keywords, staff: [...(this.o.staff ?? []), ...orders], beds: [] });
  }

  // One finished stretch from the streaming ear: its words are already heard, so only the join and delivery rules run; a number wait counts the quiet already heard.
  async segment(c: StreamSegment): Promise<ListenUtterance[]> {
    // The voiceprint starts as the segment arrives, so it never waits on the line before it.
    const print = c.voiceprint ?? this.printOf(c.samples, c.rate);
    print.catch(() => undefined);
    const s = await this.sessionFor(c.owner, c.target, c.session_id, c.arrived);
    const seq = s.next++;
    this.status(s, c.session_id, [seq], { status: "processing" });
    const run = s.chain.then(async () => {
      // The words carried across a wake are dropped from the line here too, as on the chunk path.
      const v = vitalsVocabulary(afterWake(cleanTranscript(c.raw)));
      const heard: Heard = {
        samples: [c.samples], seqs: [seq], rate: c.rate, audio_ms: totalMs([c.samples], c.rate), trailing_ms: c.trailing_ms, arrived: c.arrived,
        text: v.text, raw: c.raw, cost_usd: 0, keywords_dropped: false, rewrites: v.rewrites, strong: false, joined: false, heard_at: c.heard_at ?? this.now(), voiceprint: await print, ...(c.capture_start !== undefined ? { capture_start: c.capture_start } : {}), ...(c.capture_end !== undefined ? { capture_end: c.capture_end } : {}), ...(c.turn_seq !== undefined ? { turn_seqs: [c.turn_seq] } : {})
      };
      if (!heard.text) return;
      // Speech the realtime ear missed arrives late and out of turn, so it is delivered alone and never joins or holds another line.
      if (c.finished_by) {
        const w = s.waiting;
        // A line waiting for its number that was said before the missed speech goes first, alone, so the two keep their spoken order.
        if (w && (w.capture_end ?? w.arrived) <= (c.capture_start ?? c.arrived)) { this.clearWait(s); await this.deliver(s, c.session_id, w, "number_alone"); }
        await this.deliver(s, c.session_id, heard, c.finished_by);
        return;
      }
      this.adoptWaiting(s, c.session_id, c.rate);
      const w = s.waiting;
      if (w && w.rate === c.rate) {
        this.clearWait(s);
        // A strong cut is always joined; a number is joined only when these words carry it on.
        if (w.strong || continuesNumber(heard.text)) {
          const raw = `${w.raw.replace(/[.,;:!?]+$/, "")} ${c.raw}`;
          const jv = vitalsVocabulary(cleanTranscript(raw));
          // The joined line is matched on every piece it was heard in, so a continuation in another voice never inherits the first speaker's authority.
          const samples = [...w.samples, c.samples];
          const voiceprint = this.o.embed ? await printLine(this.o.embed, matchWindows(samples, c.rate, LISTEN_WINDOW_MS), c.rate) : null;
          const joined: Heard = { ...heard, samples, seqs: [...w.seqs, seq], audio_ms: w.audio_ms + heard.audio_ms, text: jv.text, raw, rewrites: jv.rewrites, joined: true, voiceprint, ...(w.capture_start !== undefined ? { capture_start: w.capture_start } : {}), ...((w.turn_seqs || heard.turn_seqs) ? { turn_seqs: [...(w.turn_seqs ?? []), ...(heard.turn_seqs ?? [])] } : {}), ...(w.released ? { continues: w.released.line_id } : {}), ...(w.partial ? { partial: true } : {}) };
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
      const heard = await this.ear(s, sessionId, h.samples, h.seqs, h.rate, h.trailing_ms, h.arrived, { ...(h.capture_start !== undefined ? { capture_start: h.capture_start } : {}), ...(h.capture_end !== undefined ? { capture_end: h.capture_end } : {}) });
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

  // Ends every session of this owner on this patient as the strip's end marker does, at its next number, so held audio is finished and later chunks are late; answers the ids ended.
  async endFor(owner: string, target: EmrTarget, also: string | null = null): Promise<string[]> {
    const ours = (id: string, s: Session) => s.owner === owner && (id === also || (!!target.admission_id && s.ctx.admission_id === target.admission_id) || (!!target.patient_id && s.ctx.patient_id === target.patient_id));
    const ids = [...this.sessions.entries()].filter(([id, s]) => ours(id, s)).map(([id]) => id);
    await Promise.all(ids.map((id) => { const s = this.sessions.get(id)!; return this.end({ owner, target, session_id: id, seq: Math.max(s.next, s.seen) }, true); }));
    return ids;
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
    // A stopped serve leaves the waiting lines on disk for the next start, so only the timers stop here.
    for (const s of this.sessions.values()) { if (s.timer) clearTimeout(s.timer); s.timer = null; this.clearHeld(s); }
    for (const r of this.restored.values()) clearTimeout(r.timer);
  }

  private clearWait(s: Session): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    if (s.waiting) this.unmarkWaiting(s);
    s.waiting = null;
  }

  private withClass(u: ListenUtterance): ListenUtterance {
    const classes = this.o.classesOf?.(u.task_id, u.line_id) ?? this.rt.task(u.task_id)?.lines.find((l) => l.id === u.line_id)?.classes ?? [];
    return { ...u, classes: [...classes], class: primaryClass(classes) };
  }

  private now(): number { return this.o.now?.() ?? Date.now(); }
  private finalMs(): number { return this.o.finalSilenceMs ?? FINAL_SILENCE_MS; }

  // Mirrors the chain's cap and pause rules as each chunk arrives, and starts transcribing the audio the chain will ask for, so no line waits on the one before it.
  private foresee(s: Session, c: ListenChunk, samples: Float32Array, rate: number): void {
    if (c.seq < s.seen) return;
    if (c.seq > s.seen) s.ahead = null;
    s.seen = c.seq + 1;
    const silence = trailingSilenceMs(samples, rate);
    const audioMs = Math.round((samples.length / rate) * 1000);
    const arrived = c.arrived_at ?? this.now();
    let a = s.ahead && s.ahead.rate === rate ? s.ahead : null;
    if (a && a.trailing_ms + leadingSilenceMs(samples, rate) + Math.max(0, arrived - a.arrived - audioMs) >= this.finalMs()) { this.readAhead(s, c.session_id, a.samples, a.seqs, rate); a = null; }
    if (audioMs >= (this.o.capMs ?? CHUNK_CAP_MS) - 50 && silence < this.finalMs()) {
      a ??= { samples: [], seqs: [], audio_ms: 0, rate, trailing_ms: 0, arrived };
      a.samples.push(samples); a.seqs.push(c.seq); a.audio_ms += audioMs; a.trailing_ms = silence; a.arrived = arrived;
      s.ahead = a;
      return;
    }
    s.ahead = null;
    // A line already waiting where a value must follow is joined with this audio as one, so this audio alone is never sent.
    if (s.waiting?.strong && !s.waiting.partial) return;
    this.readAhead(s, c.session_id, [...(a?.samples ?? []), samples], [...(a?.seqs ?? []), c.seq], rate);
  }

  private readAhead(s: Session, sessionId: string, parts: Float32Array[], seqs: number[], rate: number): void {
    const key = readKey(parts, seqs);
    if (this.closed || s.reads.has(key)) return;
    const p = this.bounded(() => this.read(s, sessionId, parts, seqs, rate));
    p.catch(() => undefined);
    s.reads.set(key, p);
    // A transcription the chain never asked for (a gap, a timeout) is forgotten after a while.
    if (s.reads.size > 16) s.reads.delete(s.reads.keys().next().value!);
  }

  private async bounded<T>(f: () => Promise<T>): Promise<T> {
    while (this.reading >= READS_IN_FLIGHT) await new Promise<void>((r) => this.readQueue.push(r));
    this.reading += 1;
    try { return await f(); } finally { this.reading -= 1; this.readQueue.shift()?.(); }
  }

  private async hear(s: Session, c: ListenChunk): Promise<ListenOutcome> {
    const prior = s.outcomes.get(c.seq);
    if (prior) return { ...prior, why: "duplicate" };
    const arrived = c.arrived_at ?? this.now();
    const { samples, sampleRate } = decodeWav(c.wav);
    const silence = trailingSilenceMs(samples, sampleRate);
    const audioMs = Math.round((samples.length / sampleRate) * 1000);
    const capture = c.captured_at === undefined ? {} : { capture_start: c.captured_at, capture_end: c.captured_at + audioMs - silence };
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
    this.adoptWaiting(s, c.session_id, sampleRate);
    if (s.waiting && s.waiting.rate !== sampleRate) await alone();
    // A cap that fell in the quiet after speech left a whole utterance on hold; when the pause runs on into this chunk, that utterance is finished alone.
    if (s.held) {
      const h0 = s.held;
      // Audio cut short of the strip's tail joins this chunk only when the pause between them, on capture times when both have them, is shorter than that tail.
      const gapMs = h0.short && c.captured_at !== undefined && h0.capture_end !== undefined ? c.captured_at - (h0.capture_end + h0.trailing_ms) : arrived - h0.arrived - audioMs;
      const pause = h0.trailing_ms + leadingSilenceMs(samples, sampleRate) + Math.max(0, gapMs);
      if (pause >= (h0.short ? STRIP_TAIL_MS : this.finalMs())) delivered = (await this.finishHeld(s, c.session_id, h0.short ? "short_chunk" : "pause_after_cap")) ?? delivered;
    }
    const capped = audioMs >= (this.o.capMs ?? CHUNK_CAP_MS) - 50 && silence < this.finalMs();
    // A chunk cut before its quiet tail with more chunks already waiting behind it is held like a capped one, so "her name is" and the name that follows are one line.
    const short = !capped && !gap && silence < this.finalMs() && s.queued > 0;
    if (capped || short) {
      // A line that ended where a value must follow carries on into this capped audio; a line ending on a number does not wait on audio that cannot be read yet.
      const w = s.waiting;
      let h = s.held;
      if (w && w.strong && !h) { this.clearWait(s); h = { samples: [...w.samples], seqs: [...w.seqs], audio_ms: w.audio_ms, rate: w.rate, trailing_ms: 0, arrived: w.arrived, ...(w.capture_start !== undefined ? { capture_start: w.capture_start } : {}) }; }
      else await alone();
      h ??= { samples: [], seqs: [], audio_ms: 0, rate: sampleRate, trailing_ms: 0, arrived, ...capture };
      h.samples.push(samples); h.seqs.push(c.seq); h.audio_ms += audioMs; h.trailing_ms = silence; h.arrived = arrived; if (capture.capture_end !== undefined) h.capture_end = capture.capture_end;
      h.short = short;
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
    const captured = { ...capture, ...(h?.capture_start !== undefined ? { capture_start: h.capture_start } : {}) };
    let cost = 0;
    let heard: Heard;
    const w = s.waiting;
    if (w) {
      this.clearWait(s);
      // A strong cut is always joined; a number is joined only when the next words carry it on.
      // Words kept without their audio are joined by their words, so these words are heard on their own first.
      const next = w.strong && !w.partial ? null : await this.ear(s, c.session_id, parts, seqs, sampleRate, silence, arrived, captured);
      if (next) cost += next.cost_usd;
      if (w.strong || continuesNumber(next!.text)) {
        heard = w.partial ? this.joinWords(w, next!) : await this.ear(s, c.session_id, [...w.samples, ...parts], [...w.seqs, ...seqs], sampleRate, silence, arrived, { ...captured, ...(w.capture_start !== undefined ? { capture_start: w.capture_start } : {}) });
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
      heard = await this.ear(s, c.session_id, parts, seqs, sampleRate, silence, arrived, captured);
      cost = heard.cost_usd;
    }
    if (!heard.text) return done({ ...this.outcomeOf(base, heard, delivered, "empty", cost), final: true });
    const u = await this.settleHeard(s, c.session_id, heard, why);
    return done(this.outcomeOf(base, heard, u ?? delivered, u ? why : "held_for_number", cost));
  }

  private joinWords(w: Heard, next: Heard): Heard {
    const raw = `${w.raw.replace(/[.,;:!?]+$/, "")} ${next.raw}`;
    const jv = vitalsVocabulary(cleanTranscript(raw));
    return { ...next, text: jv.text, raw, rewrites: jv.rewrites, partial: true, voiceprint: null, ...(w.capture_start !== undefined ? { capture_start: w.capture_start } : {}) };
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
    this.markWaiting(s, sessionId);
    // A line that ends on a number may be complete, so its decision starts while it waits; the runtime uses it only if these same words are delivered.
    if (!h.strong && !h.released) this.rt.speculate({ owner: s.owner, ctx: s.ctx, session_id: sessionId, text: h.text, clip: encodeWav(concat(h.samples), h.rate) });
    const timer = setTimeout(() => {
      s.timer = null;
      s.chain = s.chain.then(async () => { if (s.waiting === h) { this.clearWait(s); await this.deliver(s, sessionId, h, "number_alone"); } })
        .catch((e: unknown) => { s.errors.push(e instanceof Error ? e.message.slice(0, 200) : "listen failed"); });
    }, Math.max(0, (h.strong ? this.o.strongJoinWaitMs ?? STRONG_JOIN_WAIT_MS : this.o.numberJoinWaitMs ?? NUMBER_JOIN_WAIT_MS) - quietHeardMs));
    timer.unref?.();
    s.timer = timer;
    return h.released ?? null;
  }

  // Transcribes one stretch of audio with vitals words first in the hints, then cleans it and applies the vitals vocabulary.
  private async ear(s: Session, sessionId: string, parts: Float32Array[], seqs: number[], rate: number, silence: number, arrived: number, captured: { capture_start?: number; capture_end?: number } = {}): Promise<Heard> {
    // The same chunks already being transcribed since they arrived are not sent again.
    const key = readKey(parts, seqs);
    const early = s.reads.get(key);
    s.reads.delete(key);
    const { heard, dropped, at, voiceprint } = await (early ?? this.read(s, sessionId, parts, seqs, rate));
    const v = vitalsVocabulary(afterWake(cleanTranscript(heard.text)));
    const alternates = heard.alternates?.map((x) => vitalsVocabulary(afterWake(cleanTranscript(x))).text);
    return { samples: parts, seqs, rate, audio_ms: totalMs(parts, rate), trailing_ms: silence, arrived, text: v.text, raw: heard.text, cost_usd: heard.cost_usd, keywords_dropped: dropped, rewrites: v.rewrites, strong: false, joined: false, heard_at: at, voiceprint, ...captured, ...(alternates?.length ? { alternates } : {}) };
  }

  private async read(s: Session, sessionId: string, parts: Float32Array[], seqs: number[], rate: number): Promise<Read> {
    const joined = encodeWav(concat(parts), rate);
    const keywords = this.keywordsOf(s);
    const asrId = `${sessionId}-${seqs.length > 1 ? `${seqs[0]}.` : ""}${seqs.at(-1)}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
    let heard: FinalTranscript;
    let dropped = false;
    // The voiceprint is worked out while the words are transcribed, so attribution adds no time to the line; each heard piece is its own window.
    const print = this.o.embed && this.guard.lineOf(sessionId, seqs, s.owner).live !== false ? printLine(this.o.embed, matchWindows(parts, rate, LISTEN_WINDOW_MS), rate) : Promise.resolve(null);
    print.catch(() => undefined);
    try {
      heard = await this.o.transcribe(joined, keywords, asrId);
    } catch (e) {
      if (!(e instanceof VoiceError)) throw e;
      // A hint the service refuses must not lose the clinician's words, so one retry goes without hints.
      if (e.status !== 400 || !keywords.length) throw new ListenError(e.code === "bad_wav" ? 400 : 502, e.message);
      dropped = true;
      heard = await this.o.transcribe(joined, [], `${asrId}-nk`.slice(0, 64));
    }
    return { heard, dropped, at: Date.now(), voiceprint: await print };
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
    // Words kept across a restart lost their audio, so no voice match can cover the whole line.
    const lost = h.partial ? { voiceprint: null, unverified_reason: "first_piece_not_kept" } : null;
    const absent = present.live === false ? { voiceprint: null, unverified_reason: `not_present:${present.reason}` } : tooLong ?? lost;
    // A patient with no admission yet (or none the port knows after a restart) is named by the patient, so the line still reaches that patient's tasks.
    const target: EmrTarget = { admission_id: s.ctx.admission_id, ...(!s.ctx.admission_id && s.ctx.patient_id ? { patient_id: s.ctx.patient_id } : {}) };
    const clip = h.samples.length && !h.partial ? encodeWav(concat(h.samples), h.rate) : undefined;
    // A line the fallback ear read says which independent ear gives its second reading, "none" when there is none, so the runtime holds its numbers rather than let one ear agree with itself.
    const second = why === "fallback_parakeet" ? { second_reading: clip && this.o.fallbackClip ? this.o.fallbackClip(clip) : "none" } : {};
    const ambient = { session_id: sessionId, seqs: h.seqs, raw_text: h.raw.slice(0, 2000), ended_at: new Date(h.capture_end ?? h.arrived - h.trailing_ms).toISOString(), final_at: new Date(h.arrived).toISOString(), trailing_silence_ms: h.trailing_ms, finished_by: finished, ...(h.capture_start !== undefined ? { captured: true } : {}), ...(h.turn_seqs ? { turn_seqs: h.turn_seqs } : {}), ...(why === "released_whole" ? { released: true } : {}), ...(h.continues ? { continues: h.continues } : {}), ...second };
    const r = await this.rt.say({
      owner: s.owner, target, text: h.text, source: "audio", spoken_at: new Date(h.capture_start ?? h.arrived - h.audio_ms).toISOString(),
      audio: { audio_ms: h.audio_ms, cost_usd: h.cost_usd, session_id: sessionId }, ambient,
      context: s.ctx, ...(clip ? { clip } : {}), rewrites: h.rewrites, heard_at: h.heard_at, ...(h.alternates ? { alternates: h.alternates } : {}), ...(this.o.embed ? absent ?? { voiceprint: h.voiceprint } : {})
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
