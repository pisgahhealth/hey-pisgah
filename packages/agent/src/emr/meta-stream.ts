import { ASR_MODEL, RealtimeSession, USD_PER_AUDIO_HOUR, VoiceError, concat, resample, type RealtimeEvent, type RealtimeMode, type RealtimeRate, type SocketFactory } from "@hey-pisgah/voice";
import type { ListenSessions, ListenUtterance } from "./listen.js";
import type { ReadingLedger } from "./local-ears.js";
import type { EmrTarget } from "./port.js";
import { STREAM_LIVE_SLACK_MS, StreamRefused } from "./stream-listen.js";

export const META_STREAM_MODEL = `meta:${ASR_MODEL}:realtime` as const;
// A realtime session is replaced well before Meta's 60-minute limit, between lines when it can be.
export const META_SESSION_CAP_MS = 50 * 60_000;
// Past the cap plus this, the session is replaced even in the middle of a line.
export const META_SESSION_HARD_MS = 58 * 60_000;
// Audio kept before and after Meta's turn edges, since those edges are processing positions, not acoustic boundaries.
export const META_TURN_PREROLL_MS = 300;
export const META_TURN_TAIL_MS = 300;
// How much recent audio is kept in memory for the second ear; nothing is written to disk.
export const META_KEEP_MS = 60_000;
// Reconnects tried after a dropped connection before the stream fails.
export const META_RECONNECTS = 3;

export type MetaStreamOptions = {
  key: () => string; socket?: SocketFactory; url?: string; mode?: RealtimeMode; languageBias?: readonly string[];
  ledger?: ReadingLedger; runOf?: (taskId: string) => string | null; now?: () => number;
  refuseFasterThanLive?: boolean; capMs?: number; hardMs?: number; reconnectDelayMs?: number;
};

type Turn = { start_ms: number; end_ms: number | null };
type Conn = { s: RealtimeSession; base_ms: number; turns: Map<number, Turn>; open: Set<number>; current: number | null; ending: boolean; opened: number };
type Live = {
  owner: string; target: EmrTarget; rate: number; send_rate: RealtimeRate; keywords: string[];
  conn: Conn | null; draining: Promise<unknown>[]; ring: { at_ms: number; x: Float32Array }[]; fed_ms: number; fed: number;
  wall: { ms: number; at: number }[]; billed_ms: number; work: Promise<unknown>; errors: string[]; opened: number; failed: Error | null;
  reconnecting: Promise<void> | null; dropped_ms: number; ended: boolean;
};

export class MetaStreamFailed extends Error { constructor(message: string, readonly code: number | null) { super(message); } }

const sendRateOf = (rate: number): RealtimeRate => (rate === 24_000 ? 24_000 : 16_000);
const centsOf = (ms: number) => Math.round((ms / 3_600_000) * USD_PER_AUDIO_HOUR * 1e6) / 1e6;

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

  async open(c: { owner: string; target: EmrTarget; session_id: string; rate: number }): Promise<void> {
    if (this.live.has(c.session_id)) throw new Error("this listening session is already streaming");
    const keywords = await this.listen.hintsFor(c.owner, c.target, c.session_id, this.now());
    const l: Live = {
      owner: c.owner, target: c.target, rate: c.rate, send_rate: sendRateOf(c.rate), keywords, conn: null, draining: [], ring: [], fed_ms: 0, fed: 0,
      wall: [], billed_ms: 0, work: Promise.resolve(), errors: [], opened: this.now(), failed: null, reconnecting: null, dropped_ms: 0, ended: false
    };
    this.live.set(c.session_id, l);
    try { l.conn = await this.connect(c.session_id, l); } catch (e) { this.live.delete(c.session_id); throw e; }
  }

  private async connect(sessionId: string, l: Live): Promise<Conn> {
    const conn: Conn = { s: null as unknown as RealtimeSession, base_ms: l.fed_ms, turns: new Map(), open: new Set(), current: null, ending: false, opened: this.now() };
    const sid = `hp-${sessionId}-${Date.now().toString(36)}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
    conn.s = await RealtimeSession.open({
      key: this.o.key(), rate: l.send_rate, mode: this.o.mode ?? "ENDPOINTING", keywords: l.keywords, languageBias: this.o.languageBias ?? [], sessionId: sid,
      ...(this.o.socket ? { socket: this.o.socket } : {}), ...(this.o.url ? { url: this.o.url } : {}),
      onEvent: (e) => this.onEvent(sessionId, l, conn, e), onClose: (code, reason) => this.onClose(sessionId, l, conn, code, reason)
    });
    conn.base_ms = l.fed_ms;
    return conn;
  }

  // Takes any number of samples at the session's rate and sends them on at once; the clock is the sender's, as Meta asks.
  feed(sessionId: string, samples: Float32Array): void {
    const l = this.live.get(sessionId);
    if (!l) throw new Error("this listening session is not streaming");
    if (l.failed) throw l.failed;
    l.fed += samples.length;
    const now = this.now();
    if (this.o.refuseFasterThanLive && (l.fed / l.rate) * 1000 > now - l.opened + STREAM_LIVE_SLACK_MS) throw new StreamRefused("faster_than_live");
    l.ring.push({ at_ms: l.fed_ms, x: samples });
    l.fed_ms += (samples.length / l.rate) * 1000;
    while (l.ring.length > 1 && l.ring[1]!.at_ms < l.fed_ms - META_KEEP_MS) l.ring.shift();
    l.wall.push({ ms: l.fed_ms, at: now });
    if (l.wall.length > 4000) l.wall.splice(0, l.wall.length - 3000);
    if (!l.conn || l.reconnecting) { l.dropped_ms += (samples.length / l.rate) * 1000; return; }
    l.conn.s.send(l.rate === l.send_rate ? samples : resample(samples, l.rate, l.send_rate));
    const age = now - l.conn.opened;
    if ((age >= (this.o.capMs ?? META_SESSION_CAP_MS) && !l.conn.open.size) || age >= (this.o.hardMs ?? META_SESSION_HARD_MS)) this.rotate(sessionId, l);
  }

  // A new session takes the frames from the next one on, and the old one is ended so the server can finish the turns it holds.
  private rotate(sessionId: string, l: Live): void {
    const old = l.conn!;
    l.reconnecting = this.connect(sessionId, l).then((c) => { l.conn = c; old.ending = true; l.draining.push(old.s.end()); }, (e: unknown) => {
      l.failed = new MetaStreamFailed(`the realtime ear could not open a new session: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300), e instanceof VoiceError ? e.status : null);
    }).finally(() => { l.reconnecting = null; });
  }

  private abs(conn: Conn, ms: number): number { return conn.base_ms + ms; }

  private onEvent(sessionId: string, l: Live, conn: Conn, e: RealtimeEvent): void {
    if (e.type === "speechStart") { conn.turns.set(e.turnId, { start_ms: this.abs(conn, e.audioProcessedMs), end_ms: null }); conn.open.add(e.turnId); conn.current = e.turnId; return; }
    if (e.type === "transcript") {
      if (e.final || conn.current === null || !conn.open.has(conn.current) || !e.transcript.trim()) return;
      const said = e.transcript;
      // The next words are looked at as they are said, after every turn before them.
      l.work = l.work.then(() => this.listen.nextWords(sessionId, said));
      return;
    }
    if (e.type === "speechEnd") { const t = conn.turns.get(e.turnId); if (t) t.end_ms = this.abs(conn, e.audioProcessedMs); return; }
    if (e.type === "error") { l.errors.push(`realtime: ${e.message}`.slice(0, 200)); return; }
    if (e.type !== "speechComplete") return;
    conn.open.delete(e.turnId);
    const t = conn.turns.get(e.turnId) ?? { start_ms: Math.max(0, this.abs(conn, e.audioProcessedMs) - 3000), end_ms: null };
    conn.turns.delete(e.turnId);
    const end = t.end_ms ?? this.abs(conn, e.audioProcessedMs);
    const at = this.now();
    const samples = this.slice(l, t.start_ms - META_TURN_PREROLL_MS, end + META_TURN_TAIL_MS);
    const processed = this.abs(conn, e.audioProcessedMs);
    const cost = centsOf(Math.max(0, processed - l.billed_ms));
    l.billed_ms = Math.max(l.billed_ms, processed);
    const latency = Math.max(0, at - this.wallAt(l, end));
    const raw = e.transcript.trim();
    l.work = l.work.then(async () => {
      const us: ListenUtterance[] = raw ? await this.listen.segment({ owner: l.owner, target: l.target, session_id: sessionId, samples, rate: l.rate, raw, trailing_ms: Math.max(0, l.fed_ms - end), arrived: at, heard_at: at }) : [];
      this.row(us[0]?.task_id ?? null, us[0]?.line_id ?? null, latency, cost, null);
    }).catch((err: unknown) => { l.errors.push(err instanceof Error ? err.message.slice(0, 200) : "segment failed"); });
  }

  private onClose(sessionId: string, l: Live, conn: Conn, code: number, reason: string): void {
    if (conn.ending || l.ended || l.conn !== conn) return;
    if (conn.open.size) l.errors.push("a line was cut off when the realtime connection dropped");
    conn.open.clear();
    if (code === 1008) { l.failed = new MetaStreamFailed(`the realtime ear refused the stream (${reason || code})`.slice(0, 300), code); return; }
    l.conn = null;
    // A dropped or failed session is opened again with backoff; audio said while it is down is lost and counted.
    l.reconnecting = (async () => {
      for (let i = 0; i < META_RECONNECTS; i++) {
        await new Promise((r) => setTimeout(r, (this.o.reconnectDelayMs ?? 500) * 2 ** i));
        if (l.ended) return;
        try { l.conn = await this.connect(sessionId, l); l.errors.push(`realtime connection dropped (${code}) and was opened again`); return; } catch { /* tried again below */ }
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

  // Ends the stream: input is closed, the server finishes every turn it holds, each is handed on, and a line waiting on a number goes alone.
  async end(sessionId: string): Promise<{ utterances: ListenUtterance[]; errors: string[]; failed: string | null }> {
    const l = this.live.get(sessionId);
    if (!l) return { utterances: [], errors: [], failed: null };
    await l.reconnecting;
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
    this.live.delete(sessionId);
    await l.work;
    await this.listen.flush(sessionId);
    // The audio after the last completed turn is billed too, so the ledger sums to the audio sent.
    const rest = Math.max(0, (c ? this.abs(c, c.s.sentMs) : l.fed_ms) - l.billed_ms);
    if (rest > 0) this.row(null, null, 0, centsOf(rest), null);
    if (l.dropped_ms > 0) l.errors.push(`${Math.round(l.dropped_ms)} ms of audio arrived while the realtime ear was reconnecting and was not heard`);
    const r = this.listen.unreportedOf(sessionId);
    return { utterances: r.utterances, errors: [...l.errors, ...r.errors], failed: l.failed?.message ?? null };
  }

  async drain(sessionId: string): Promise<void> { await this.live.get(sessionId)?.work; }
}
