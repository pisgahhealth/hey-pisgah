import { ASR_MODEL, RealtimeSession, SILENCE_RMS, USD_PER_AUDIO_HOUR, VoiceError, concat, resample, type RealtimeEvent, type RealtimeMode, type RealtimeRate, type SocketFactory } from "@hey-pisgah/voice";
import type { ListenSessions, ListenUtterance } from "./listen.js";
import type { ReadingLedger } from "./local-ears.js";
import type { EmrTarget } from "./port.js";
import { STREAM_LIVE_SLACK_MS, StreamRefused } from "./stream-listen.js";

export const META_STREAM_MODEL = `meta:${ASR_MODEL}:realtime` as const;
// Meta closes a realtime session at 60 minutes, so the next one opens at 57 and both hear the same audio until they join.
export const META_ROLL_AT_MS = 57 * 60_000;
// The two sessions overlap for at most a minute, as Meta advises, before the join is forced.
export const META_OVERLAP_MS = 60_000;
// The join waits for this much quiet audio with neither session inside a turn, so every turn belongs to exactly one session.
export const META_JOIN_QUIET_MS = 1_000;
// A sender this far behind the clock is padded with silence, since Meta closes a stream that arrives slower than real time.
export const META_PAD_AFTER_MS = 250;
// Padding brings the audio sent to within this much of the clock.
export const META_PAD_LAG_MS = 100;
// Audio is sent no further than this ahead of the session's clock, inside Meta's five seconds ahead of processing, so the audio held while a session opens still goes at once.
export const META_LEAD_MAX_MS = 4_000;
// A join waits at most this long for the old session to finish and close; past it the old one is closed and the join completes.
export const META_JOIN_WAIT_MS = 8_000;
const PAD_TICK_MS = 100;
// After a dropped connection or a patient change at most this much recent audio is sent again, inside Meta's five seconds ahead of processing.
export const META_RESEND_MAX_MS = 4_000;
// A turn sharing at least this much time with a turn another session already delivered is the same speech heard twice, and is dropped.
export const META_SAME_SPEECH_MS = 200;
// Audio kept before and after Meta's turn edges, since those edges are processing positions, not acoustic boundaries.
export const META_TURN_PREROLL_MS = 300;
export const META_TURN_TAIL_MS = 300;
// How much recent audio is kept in memory for the second ear and for a resend; nothing is written to disk.
export const META_KEEP_MS = 60_000;
// Reconnects tried after a dropped connection before the stream fails.
export const META_RECONNECTS = 3;

export type MetaStreamOptions = {
  key: () => string; socket?: SocketFactory; url?: string; mode?: RealtimeMode; languageBias?: readonly string[];
  ledger?: ReadingLedger; runOf?: (taskId: string) => string | null; now?: () => number;
  refuseFasterThanLive?: boolean; rollAtMs?: number; overlapMs?: number; joinQuietMs?: number; padAfterMs?: number; paceMs?: number; joinWaitMs?: number; reconnectDelayMs?: number;
  // Every utterance a completed turn became, as it is delivered, for a caller that reports lines while the stream is still open.
  onHeard?: (sessionId: string, us: ListenUtterance[]) => void;
};

type Turn = { start_ms: number; end_ms: number | null };
// A connection owns the turns that start in [from_ms, until_ms) for its own patient; until the session before it has closed, its finished turns wait in held.
type Conn = {
  s: RealtimeSession; base_ms: number; turns: Map<number, Turn>; open: Set<number>; current: number | null; ending: boolean; opened: number; from_ms: number; until_ms: number; processed_ms: number;
  target: EmrTarget; listen_sid: string; after: Promise<unknown> | null; held: (() => void)[]; on_empty: (() => void) | null; on_close: (() => void) | null;
};
type Live = {
  owner: string; rate: number; send_rate: RealtimeRate; sids: Set<string>; delivered: { start_ms: number; end_ms: number; conn: Conn }[];
  conn: Conn | null; next: Conn | null; closing: Conn | null; rolling: Promise<void> | null; roll_since: number; roll_retry_at: number;
  draining: Promise<unknown>[]; ring: { at_ms: number; x: Float32Array }[]; fed_ms: number; fed: number; quiet_ms: number; padded_ms: number; resent_ms: number; last_end_ms: number;
  inbox: { x: Float32Array; at: number }[]; debt_ms: number; trimmed_ms: number;
  wall: { ms: number; at: number }[]; billed_ms: number; work: Promise<unknown>; errors: string[]; opened: number; failed: Error | null;
  reconnecting: Promise<void> | null; dropped_ms: number; ended: boolean; pad: ReturnType<typeof setInterval> | null;
};

export class MetaStreamFailed extends Error { constructor(message: string, readonly code: number | null) { super(message); } }

const sendRateOf = (rate: number): RealtimeRate => (rate === 24_000 ? 24_000 : 16_000);
const centsOf = (ms: number) => Math.round((ms / 3_600_000) * USD_PER_AUDIO_HOUR * 1e6) / 1e6;
const rms = (x: Float32Array) => { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / Math.max(1, x.length)); };

// Opens one realtime session and ends it at once, so a switched-on ear that cannot connect stops the service before it serves.
export async function probeRealtime(o: Pick<MetaStreamOptions, "key" | "socket" | "url" | "mode" | "languageBias">): Promise<string> {
  const s = await RealtimeSession.open({ key: o.key(), rate: 16_000, mode: o.mode ?? "ENDPOINTING", languageBias: o.languageBias ?? [], sessionId: `hp-probe-${Date.now().toString(36)}`, ...(o.socket ? { socket: o.socket } : {}), ...(o.url ? { url: o.url } : {}), onEvent: () => undefined });
  await s.end(5000);
  return s.sessionId;
}

// Meta's realtime ear as the first ear: frames go to the socket as they arrive, partial words reach the number join, and each completed turn joins the listen chain.
export class MetaStreamListener {
  private readonly live = new Map<string, Live>();
  constructor(private readonly listen: ListenSessions, private readonly o: MetaStreamOptions) {}

  private now(): number { return this.o.now?.() ?? Date.now(); }

  // Opens a stream under session_id; its lines go to listen_sid's listening session, which is session_id unless given.
  async open(c: { owner: string; target: EmrTarget; session_id: string; rate: number; listen_sid?: string }): Promise<void> {
    if (this.live.has(c.session_id)) throw new Error("this listening session is already streaming");
    const l: Live = {
      owner: c.owner, rate: c.rate, send_rate: sendRateOf(c.rate), sids: new Set(), delivered: [], conn: null, next: null, closing: null, rolling: null, roll_since: 0, roll_retry_at: 0,
      draining: [], ring: [], fed_ms: 0, fed: 0, quiet_ms: 0, padded_ms: 0, resent_ms: 0, last_end_ms: -Infinity, inbox: [], debt_ms: 0, trimmed_ms: 0,
      wall: [], billed_ms: 0, work: Promise.resolve(), errors: [], opened: this.now(), failed: null, reconnecting: null, dropped_ms: 0, ended: false, pad: null
    };
    this.live.set(c.session_id, l);
    try { l.conn = await this.connect(c.session_id, l, c.target, c.listen_sid ?? c.session_id, -Infinity); } catch (e) { this.live.delete(c.session_id); throw e; }
    l.pad = setInterval(() => { this.flushInbox(c.session_id, l, false); this.pad(c.session_id); }, PAD_TICK_MS);
    l.pad.unref?.();
  }

  // Hints are fixed for a session's life, so each patient gets a session opened with that patient's words.
  private async connect(sessionId: string, l: Live, target: EmrTarget, listenSid: string, fromMs: number): Promise<Conn> {
    l.sids.add(listenSid);
    const keywords = await this.listen.hintsFor(l.owner, target, listenSid, this.now());
    const conn: Conn = { s: null as unknown as RealtimeSession, base_ms: l.fed_ms, turns: new Map(), open: new Set(), current: null, ending: false, opened: this.now(), from_ms: fromMs, until_ms: Infinity, processed_ms: 0, target, listen_sid: listenSid, after: null, held: [], on_empty: null, on_close: null };
    const sid = `hp-${sessionId}-${Date.now().toString(36)}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
    conn.s = await RealtimeSession.open({
      key: this.o.key(), rate: l.send_rate, mode: this.o.mode ?? "ENDPOINTING", keywords, languageBias: this.o.languageBias ?? [], sessionId: sid,
      ...(this.o.socket ? { socket: this.o.socket } : {}), ...(this.o.url ? { url: this.o.url } : {}),
      onEvent: (e) => this.onEvent(sessionId, l, conn, e), onClose: (code, reason) => this.onClose(sessionId, l, conn, code, reason)
    });
    conn.base_ms = l.fed_ms;
    conn.opened = this.now();
    return conn;
  }

  // Takes any number of samples at the session's rate, captured from capturedAt on; they are sent at once unless the stream is already ahead of the clock.
  feed(sessionId: string, samples: Float32Array, capturedAt?: number): void {
    const l = this.live.get(sessionId);
    if (!l) throw new Error("this listening session is not streaming");
    if (l.failed) throw l.failed;
    l.fed += samples.length;
    const now = this.now();
    if (this.o.refuseFasterThanLive && (l.fed / l.rate) * 1000 > now - l.opened + STREAM_LIVE_SLACK_MS) throw new StreamRefused("faster_than_live");
    l.inbox.push({ x: samples, at: capturedAt ?? now - (samples.length / l.rate) * 1000 });
    this.flushInbox(sessionId, l, false);
  }

  // Sends waiting audio no further than paceMs ahead of the clock; with all, everything waiting goes now.
  private flushInbox(sessionId: string, l: Live, all: boolean): void {
    while (l.inbox.length) {
      const head = l.inbox[0]!;
      let take = head.x;
      if (!all && l.conn && !l.reconnecting) {
        const room = (this.o.paceMs ?? META_LEAD_MAX_MS) - (l.conn.s.sentMs - (this.now() - l.conn.opened));
        if (room <= 0) return;
        const n = Math.round((room * l.rate) / 1000);
        if (n < head.x.length) { take = head.x.subarray(0, n); head.x = head.x.subarray(n); head.at += (n / l.rate) * 1000; this.spoken(sessionId, l, take, head.at - (n / l.rate) * 1000); continue; }
      }
      l.inbox.shift();
      this.spoken(sessionId, l, take, head.at);
    }
  }

  // Spoken audio after a stall that was padded: its silent frames repay the padding, so the stream comes back to the clock without losing a word.
  private spoken(sessionId: string, l: Live, x: Float32Array, at: number): void {
    if (l.debt_ms <= 0) { this.take(sessionId, l, x, false, at); return; }
    const fr = Math.round(l.rate * 0.02);
    let from = 0;
    for (let i = 0; i < x.length; i += fr) {
      const f = x.subarray(i, i + fr);
      if (l.debt_ms > 0 && rms(f) < SILENCE_RMS) {
        if (i > from) this.take(sessionId, l, x.subarray(from, i), false, at + (from / l.rate) * 1000);
        const ms = (f.length / l.rate) * 1000;
        l.debt_ms -= ms;
        l.trimmed_ms += ms;
        from = i + f.length;
      }
    }
    if (from < x.length) this.take(sessionId, l, x.subarray(from), false, at + (from / l.rate) * 1000);
  }

  // One stretch of audio, spoken or padding, into the ring and to every connection hearing it; the wall table keeps when each was captured, padding at the time it was sent.
  private take(sessionId: string, l: Live, samples: Float32Array, padded: boolean, capturedAt?: number): void {
    const now = this.now();
    const ms = (samples.length / l.rate) * 1000;
    l.ring.push({ at_ms: l.fed_ms, x: samples });
    l.fed_ms += ms;
    while (l.ring.length > 1 && l.ring[1]!.at_ms < l.fed_ms - META_KEEP_MS) l.ring.shift();
    l.wall.push({ ms: l.fed_ms, at: padded || capturedAt === undefined ? now : capturedAt + ms });
    if (l.wall.length > 4000) l.wall.splice(0, l.wall.length - 3000);
    l.quiet_ms = padded || rms(samples) < SILENCE_RMS ? l.quiet_ms + ms : 0;
    if (padded) l.padded_ms += ms;
    // While the connection is down the audio waits in the ring and is sent again once it is back.
    if (!l.conn || l.reconnecting) return;
    const out = this.out(l, samples);
    l.conn.s.send(out);
    l.next?.s.send(out);
    l.closing?.s.send(out);
    if (!l.next && !l.rolling && now - l.conn.opened >= (this.o.rollAtMs ?? META_ROLL_AT_MS) && now >= l.roll_retry_at) this.roll(sessionId, l, now);
    if (l.next) this.tryJoin(l, now);
  }

  private out(l: Live, x: Float32Array): Float32Array { return l.rate === l.send_rate ? x : resample(x, l.rate, l.send_rate); }

  // A sender that has fallen behind the clock gets silence, so the endpoint never sees ingress below real time.
  private pad(sessionId: string): void {
    const l = this.live.get(sessionId);
    if (!l || l.ended || l.failed || !l.conn || l.reconnecting) return;
    const after = this.o.padAfterMs ?? META_PAD_AFTER_MS;
    if (after <= 0 || l.inbox.length) return;
    const lag = this.now() - l.conn.opened - l.conn.s.sentMs;
    if (lag <= after) return;
    const pad = lag - META_PAD_LAG_MS;
    l.debt_ms += pad;
    this.take(sessionId, l, new Float32Array(Math.round((pad * l.rate) / 1000)), true);
  }

  // The next session opens beside the current one and hears every frame from here on; until the join it owns no turn.
  private roll(sessionId: string, l: Live, now: number): void {
    l.roll_since = now;
    const cur = l.conn!;
    l.rolling = this.connect(sessionId, l, cur.target, cur.listen_sid, Infinity).then((c) => {
      if (l.ended || l.failed || l.conn !== cur) { c.ending = true; c.s.abort(); return; }
      l.next = c;
    }, (e: unknown) => {
      l.roll_retry_at = this.now() + 5000;
      l.errors.push(`the next realtime session did not open: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    }).finally(() => { l.rolling = null; });
  }

  // The roll-over join is at a quiet point both sessions agree on; past the overlap it is forced where the audio stands.
  private tryJoin(l: Live, now: number): void {
    const old = l.conn!, nx = l.next!;
    const quietMs = this.o.joinQuietMs ?? META_JOIN_QUIET_MS;
    const quiet = l.quiet_ms >= quietMs && !old.open.size && !nx.open.size;
    if (!quiet && now - l.roll_since < (this.o.overlapMs ?? META_OVERLAP_MS)) return;
    // The second session heard the overlap too, and that audio is billed.
    this.row(null, null, 0, centsOf(l.fed_ms - nx.base_ms), null);
    l.next = null;
    this.join(l, old, nx, quiet ? l.fed_ms - quietMs / 2 : l.fed_ms, "roll");
  }

  // Turns starting before the join are the old session's and the rest the new one's; the old one finishes any turn it is in, and the new one's turns wait until it has closed so a turn heard by both is delivered once.
  private join(l: Live, old: Conn, nx: Conn, at: number, kind: "roll" | "patient"): void {
    old.until_ms = at;
    nx.from_ms = at;
    old.ending = true;
    l.conn = nx;
    // Whatever way the old session ends, completed, closed or timed out, the join completes and the new session's lines go on.
    const closed = new Promise<void>((resolve) => {
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const open = [...old.open].map((id) => old.turns.get(id)?.start_ms).filter((x): x is number => typeof x === "number");
        old.open.clear();
        if (l.closing === old) l.closing = null;
        if (open.length && kind === "roll") nx.from_ms = Math.min(nx.from_ms, ...open);
        // A line cut off on the old patient is never handed to the new one; it is reported for saying again.
        if (open.length && kind === "patient") { l.delivered.push({ start_ms: Math.min(...open), end_ms: l.fed_ms, conn: old }); l.errors.push("a line was cut off when the realtime connection dropped during a patient change; say it again"); }
        resolve();
      };
      const timer = setTimeout(() => { old.s.abort(); settle(); }, this.o.joinWaitMs ?? META_JOIN_WAIT_MS);
      timer.unref?.();
      old.on_close = settle;
      const finish = () => { l.draining.push(old.s.end().then(settle, settle)); };
      if (old.open.size) { l.closing = old; old.on_empty = finish; } else finish();
    });
    nx.after = closed;
    void closed.then(() => { nx.after = null; for (const go of nx.held.splice(0)) go(); });
  }

  // A patient change: a new session with the new patient's hints takes the audio from the change on; the old one finishes the line it is in.
  async retarget(sessionId: string, c: { target: EmrTarget; listen_sid: string }): Promise<void> {
    const l = this.live.get(sessionId);
    if (!l) throw new Error("this listening session is not streaming");
    await l.reconnecting;
    await l.rolling;
    if (l.failed) throw l.failed;
    const old = l.conn;
    if (!old || old.listen_sid === c.listen_sid) return;
    if (l.next) { const nx = l.next; nx.ending = true; this.row(null, null, 0, centsOf(l.fed_ms - nx.base_ms), null); nx.s.abort(); l.next = null; }
    const at = l.fed_ms;
    old.until_ms = at;
    const nx = await this.connect(sessionId, l, c.target, c.listen_sid, at);
    // The audio said while the new session opened is sent to it at once, a few hundred milliseconds ahead of the clock.
    const again = this.slice(l, at, l.fed_ms);
    nx.base_ms = at;
    if (again.length) nx.s.send(this.out(l, again));
    this.join(l, old, nx, at, "patient");
  }

  private abs(conn: Conn, ms: number): number { return conn.base_ms + ms; }
  private owns(conn: Conn, startMs: number): boolean { return startMs >= conn.from_ms && startMs < conn.until_ms; }
  // Speech another session already delivered, heard again across a join, a resend or an overlap.
  private heardBefore(l: Live, conn: Conn, startMs: number, endMs: number): boolean {
    return l.delivered.some((d) => d.conn !== conn && Math.min(d.end_ms, endMs) - Math.max(d.start_ms, startMs) >= META_SAME_SPEECH_MS);
  }

  private onEvent(sessionId: string, l: Live, conn: Conn, e: RealtimeEvent): void {
    if ("audioProcessedMs" in e) conn.processed_ms = Math.max(conn.processed_ms, e.audioProcessedMs);
    // Turns may overlap, so every turn is kept by its id and none is assumed to finish in order.
    if (e.type === "speechStart") { conn.turns.set(e.turnId, { start_ms: this.abs(conn, e.audioProcessedMs), end_ms: null }); conn.open.add(e.turnId); conn.current = e.turnId; return; }
    if (e.type === "transcript") {
      if (e.final || conn.current === null || !conn.open.has(conn.current) || !e.transcript.trim()) return;
      const t = conn.turns.get(conn.current);
      if (t && !this.owns(conn, t.start_ms)) return;
      const said = e.transcript, sid = conn.listen_sid;
      // The next words are looked at as they are said, after every turn before them.
      l.work = l.work.then(() => this.listen.nextWords(sid, said));
      return;
    }
    if (e.type === "speechEnd") { const t = conn.turns.get(e.turnId); if (t) t.end_ms = this.abs(conn, e.audioProcessedMs); return; }
    if (e.type === "error") { l.errors.push(`realtime: ${e.message}`.slice(0, 200)); return; }
    if (e.type !== "speechComplete") return;
    conn.open.delete(e.turnId);
    const t = conn.turns.get(e.turnId) ?? { start_ms: Math.max(0, this.abs(conn, e.audioProcessedMs) - 3000), end_ms: null };
    conn.turns.delete(e.turnId);
    const end = t.end_ms ?? this.abs(conn, e.audioProcessedMs);
    const processed = this.abs(conn, e.audioProcessedMs);
    const at = this.now();
    const raw = e.transcript.trim();
    const deliver = () => {
      if (!this.owns(conn, t.start_ms) || this.heardBefore(l, conn, t.start_ms, end)) return;
      l.delivered.push({ start_ms: t.start_ms, end_ms: end, conn });
      if (l.delivered.length > 50) l.delivered.shift();
      l.last_end_ms = Math.max(l.last_end_ms, end);
      const samples = this.slice(l, t.start_ms - META_TURN_PREROLL_MS, end + META_TURN_TAIL_MS);
      const cost = centsOf(Math.max(0, processed - l.billed_ms));
      l.billed_ms = Math.max(l.billed_ms, processed);
      // Both are counted from when the end of the line was captured, so a late or paced upload is never measured as faster than it was.
      const latency = Math.max(0, at - this.wallAt(l, end));
      const sid = conn.listen_sid, target = conn.target;
      l.work = l.work.then(async () => {
        const us: ListenUtterance[] = raw ? await this.listen.segment({ owner: l.owner, target, session_id: sid, samples, rate: l.rate, raw, trailing_ms: latency, arrived: at, heard_at: at }) : [];
        if (us.length) this.o.onHeard?.(sid, us);
        this.row(us[0]?.task_id ?? null, us[0]?.line_id ?? null, latency, cost, null);
      }).catch((err: unknown) => { l.errors.push(err instanceof Error ? err.message.slice(0, 200) : "segment failed"); });
    };
    if (conn.after) conn.held.push(deliver); else deliver();
    if (conn === l.closing && !conn.open.size) { l.closing = null; conn.on_empty?.(); }
  }

  private onClose(sessionId: string, l: Live, conn: Conn, code: number, reason: string): void {
    conn.on_close?.();
    if (conn.ending || l.ended) return;
    if (conn === l.next) { l.next = null; l.roll_retry_at = this.now() + 5000; l.errors.push(`the next realtime session closed (${code}) before the join`); return; }
    if (l.conn !== conn) return;
    if (code === 1008) { l.failed = new MetaStreamFailed(`the realtime ear refused the stream (${reason || code})`.slice(0, 300), code); return; }
    const open = [...conn.open].map((id) => conn.turns.get(id)?.start_ms).filter((x): x is number => typeof x === "number");
    conn.open.clear();
    // A session that closes while the next one is open hands over to it at once, from the turn it was cut in or the end of its last turn.
    if (l.next) {
      const nx = l.next;
      nx.from_ms = open.length ? Math.min(...open) : Math.max(l.last_end_ms, nx.base_ms);
      l.conn = nx;
      l.next = null;
      l.errors.push(`realtime session closed (${code}) during the overlap; the next one took over`);
      return;
    }
    // Audio the endpoint may not have heard, from the turn it was cut in or its last processed position, is sent again to the new session.
    let from = open.length ? Math.min(...open) - META_TURN_PREROLL_MS : this.abs(conn, conn.processed_ms);
    from = Math.max(from, l.last_end_ms, l.ring[0]?.at_ms ?? 0);
    l.conn = null;
    l.reconnecting = (async () => {
      for (let i = 0; i < META_RECONNECTS; i++) {
        await new Promise((r) => setTimeout(r, (this.o.reconnectDelayMs ?? 500) * 2 ** i));
        if (l.ended) return;
        try {
          const c = await this.connect(sessionId, l, conn.target, conn.listen_sid, l.last_end_ms);
          if (l.fed_ms - from > META_RESEND_MAX_MS) { l.dropped_ms += l.fed_ms - META_RESEND_MAX_MS - from; from = l.fed_ms - META_RESEND_MAX_MS; }
          const again = this.slice(l, from, l.fed_ms);
          c.base_ms = from;
          if (again.length) c.s.send(this.out(l, again));
          l.resent_ms += (again.length / l.rate) * 1000;
          l.conn = c;
          l.errors.push(`realtime connection dropped (${code}) and was opened again; ${Math.round((again.length / l.rate) * 1000)} ms sent again${open.length ? ", from the start of the line it was cut in" : ""}`);
          return;
        } catch { /* tried again below */ }
      }
      l.failed = new MetaStreamFailed(`the realtime ear dropped (${code}) and could not reconnect`, code);
    })().finally(() => { l.reconnecting = null; });
  }

  private wallAt(l: Live, ms: number): number { return l.wall.find((w) => w.ms >= ms)?.at ?? l.wall.at(-1)?.at ?? this.now(); }

  private slice(l: Live, fromMs: number, toMs: number): Float32Array {
    const parts: Float32Array[] = [];
    for (const r of l.ring) {
      const len = (r.x.length / l.rate) * 1000;
      if (r.at_ms + len <= fromMs || r.at_ms >= toMs) continue;
      const a = Math.max(0, Math.round(((fromMs - r.at_ms) * l.rate) / 1000)), b = Math.min(r.x.length, Math.round(((toMs - r.at_ms) * l.rate) / 1000));
      parts.push(r.x.subarray(a, b));
    }
    return concat(parts);
  }

  private row(taskId: string | null, lineId: string | null, latency: number, cost: number, error: string | null): void {
    this.o.ledger?.(taskId ? this.o.runOf?.(taskId) ?? null : null, { provider: "meta", model: META_STREAM_MODEL, purpose: "interpret_speech", latency_ms: Math.round(latency), cost_usd: cost, task_id: taskId, line_id: lineId, error });
  }

  // Ends the stream with endStream on every open session, drained to its close, then every turn is handed on and a line waiting on a number goes alone.
  // With dropOpen a line still being said is not handed on, since the sender will send it another way; kept_until is when the last kept audio was captured.
  async end(sessionId: string, o: { dropOpen?: boolean } = {}): Promise<{ utterances: ListenUtterance[]; errors: string[]; failed: string | null; padded_ms: number; resent_ms: number; trimmed_ms: number; kept_until: number | null }> {
    const l = this.live.get(sessionId);
    if (!l) return { utterances: [], errors: [], failed: null, padded_ms: 0, resent_ms: 0, trimmed_ms: 0, kept_until: null };
    if (l.pad) clearInterval(l.pad);
    this.flushInbox(sessionId, l, true);
    await l.reconnecting;
    await l.rolling;
    let keptUntil = l.wall.at(-1)?.at ?? null;
    if (o.dropOpen) {
      const conns = [l.conn, l.closing, l.next].filter((x): x is Conn => !!x);
      const open = conns.flatMap((c) => [...c.open].map((id) => c.turns.get(id)?.start_ms)).filter((x): x is number => typeof x === "number");
      const cut = open.length ? Math.min(...open) : l.fed_ms;
      for (const c of conns) c.until_ms = Math.min(c.until_ms, cut);
      if (open.length) keptUntil = this.wallAt(l, cut - META_TURN_PREROLL_MS);
    }
    // A session opened for a join that never came heard the overlap only; it owns no turn, so it is closed and its audio billed.
    if (l.next) { const nx = l.next; nx.ending = true; this.row(null, null, 0, centsOf(l.fed_ms - nx.base_ms), null); nx.s.abort(); l.next = null; }
    if (l.closing) { const c = l.closing; l.closing = null; c.on_empty?.(); }
    const c = l.conn;
    if (c && !l.failed) {
      c.ending = true;
      const r = await c.s.end();
      // A refusal at the end is the endpoint saying it stopped hearing the stream, so the stream fails as a refusal mid-way does.
      if (r.code === 1008) l.failed = new MetaStreamFailed(`the realtime ear refused the stream (${r.reason || r.code})`.slice(0, 300), r.code);
      else if (r.code !== 1000) l.errors.push(`realtime session closed with ${r.code}${r.reason ? ` (${r.reason.slice(0, 80)})` : ""}`);
    }
    l.ended = true;
    await Promise.all(l.draining);
    await c?.after;
    this.live.delete(sessionId);
    await l.work;
    for (const sid of l.sids) await this.listen.flush(sid);
    // The audio after the last completed turn is billed too, so the ledger sums to the audio sent.
    const rest = Math.max(0, (c ? this.abs(c, c.s.sentMs) : l.fed_ms) - l.billed_ms);
    if (rest > 0) this.row(null, null, 0, centsOf(rest), null);
    if (l.dropped_ms > 0) l.errors.push(`${Math.round(l.dropped_ms)} ms of audio arrived while the realtime ear was reconnecting and was not heard`);
    const utterances: ListenUtterance[] = [], errors = [...l.errors];
    for (const sid of l.sids) { const r = this.listen.unreportedOf(sid); utterances.push(...r.utterances); errors.push(...r.errors); }
    return { utterances, errors, failed: l.failed?.message ?? null, padded_ms: Math.round(l.padded_ms), resent_ms: Math.round(l.resent_ms), trimmed_ms: Math.round(l.trimmed_ms), kept_until: keptUntil };
  }

  async drain(sessionId: string): Promise<void> { await this.live.get(sessionId)?.work; }
}
