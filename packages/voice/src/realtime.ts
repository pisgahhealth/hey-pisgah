import { ASR_MODEL, VoiceError } from "./transcribe.js";
import { nodeSocket, type RealtimeSocket, type SocketFactory } from "./ws.js";

export const REALTIME_URL = "wss://api.meta.ai/v1/asr/realtime";
export type RealtimeMode = "ENDPOINTING" | "PUSH_TO_TALK";
export type RealtimeRate = 16_000 | 24_000;
// Meta closes a realtime session at 60 minutes; ours are replaced before that.
export const META_SESSION_MAX_MS = 60 * 60_000;
// Meta wants the handshake within 10 seconds of the socket opening.
export const HANDSHAKE_DEADLINE_MS = 10_000;

// The server events the realtime reference lists; unknown types are passed on as "other" and ignored by callers.
export type RealtimeEvent =
  | { type: "transcript"; transcript: string; final: boolean; audioProcessedMs: number }
  | { type: "speechStart"; turnId: number; audioProcessedMs: number }
  | { type: "speechEnd"; turnId: number; audioProcessedMs: number }
  | { type: "speechComplete"; turnId: number; transcript: string; audioProcessedMs: number }
  | { type: "speaker"; label: string; audioProcessedMs: number }
  | { type: "audioProgress"; audioProcessedMs: number }
  | { type: "error"; message: string; sessionId: string; errorType?: string; errorCode?: string }
  | { type: "other"; raw: string };

export type HandshakeOptions = { key: string; rate: RealtimeRate; mode: RealtimeMode; keywords?: readonly string[]; languageBias?: readonly string[]; model?: string };

// The first text frame: the credential, the encoding, the model, the mode and the hints; hint fields are left out when empty so the default frame stays the documented minimum.
export function handshakeFrame(o: HandshakeOptions): Record<string, unknown> {
  return {
    authorization: { accessToken: `Bearer ${o.key}` }, audioEncoding: o.rate === 24_000 ? "PCM_24KHZ" : "PCM_16KHZ", model: o.model ?? ASR_MODEL, mode: o.mode,
    partialMode: "CUMULATIVE", emitAudioProgress: false,
    ...(o.keywords?.length ? { keywords: [...o.keywords] } : {}), ...(o.languageBias?.length ? { languageBias: [...o.languageBias] } : {})
  };
}

// One server text frame: the handshake acknowledgement (the only frame with no type) or an event.
export function readServerFrame(text: string): { ack: string } | RealtimeEvent {
  let x: unknown;
  try { x = JSON.parse(text); } catch { return { type: "other", raw: text.slice(0, 200) }; }
  if (!x || typeof x !== "object") return { type: "other", raw: text.slice(0, 200) };
  const o = x as Record<string, unknown>;
  const ms = typeof o["audioProcessedMs"] === "number" ? o["audioProcessedMs"] : 0;
  if (!("type" in o)) return typeof o["sessionId"] === "string" ? { ack: o["sessionId"] } : { type: "other", raw: text.slice(0, 200) };
  switch (o["type"]) {
    case "transcript": return typeof o["transcript"] === "string" ? { type: "transcript", transcript: o["transcript"], final: o["final"] === true, audioProcessedMs: ms } : { type: "other", raw: text.slice(0, 200) };
    case "speechStart": case "speechEnd": return typeof o["turnId"] === "number" ? { type: o["type"], turnId: o["turnId"], audioProcessedMs: ms } : { type: "other", raw: text.slice(0, 200) };
    case "speechComplete": return typeof o["turnId"] === "number" && typeof o["transcript"] === "string" ? { type: "speechComplete", turnId: o["turnId"], transcript: o["transcript"], audioProcessedMs: ms } : { type: "other", raw: text.slice(0, 200) };
    case "speaker": return { type: "speaker", label: String(o["label"] ?? ""), audioProcessedMs: ms };
    case "audioProgress": return { type: "audioProgress", audioProcessedMs: ms };
    case "error": return { type: "error", message: String(o["message"] ?? "").slice(0, 300), sessionId: String(o["sessionId"] ?? ""), ...(typeof o["errorType"] === "string" ? { errorType: o["errorType"] } : {}), ...(typeof o["errorCode"] === "string" ? { errorCode: o["errorCode"] } : {}) };
    default: return { type: "other", raw: text.slice(0, 200) };
  }
}

export type RealtimeOptions = HandshakeOptions & {
  sessionId: string; url?: string; socket?: SocketFactory; timeoutMs?: number;
  onEvent: (e: RealtimeEvent) => void; onClose?: (code: number, reason: string) => void;
};

// One realtime session: opened once the handshake is acknowledged, audio sent as 16-bit PCM, ended with endStream and read until the server closes.
export class RealtimeSession {
  private ended = false;
  private closedWith: { code: number; reason: string } | null = null;
  private readonly waiters: ((c: { code: number; reason: string }) => void)[] = [];
  sentBytes = 0;
  private constructor(private readonly sock: RealtimeSocket, readonly sessionId: string, readonly rate: RealtimeRate, readonly openedAt: number) {}

  static open(o: RealtimeOptions): Promise<RealtimeSession> {
    if (!o.key) return Promise.reject(new VoiceError("no_key", "no Voice Transcribe key"));
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(o.sessionId)) return Promise.reject(new RangeError("session ids are 1 to 64 letters, digits, dots, dashes or underscores"));
    return new Promise((resolve, reject) => {
      let session: RealtimeSession | null = null;
      let settled = false;
      const fail = (e: VoiceError) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } };
      const timer = setTimeout(() => { fail(new VoiceError("timeout", "the realtime handshake was not acknowledged in time")); sock.close(1000); }, o.timeoutMs ?? HANDSHAKE_DEADLINE_MS);
      timer.unref?.();
      const sock = (o.socket ?? nodeSocket)(`${o.url ?? REALTIME_URL}?sessionId=${encodeURIComponent(o.sessionId)}`, {
        open: () => sock.sendText(JSON.stringify(handshakeFrame(o))),
        text: (t) => {
          const f = readServerFrame(t);
          if ("ack" in f) {
            if (settled) return;
            settled = true; clearTimeout(timer);
            session = new RealtimeSession(sock, f.ack, o.rate, Date.now());
            resolve(session);
            return;
          }
          if (!session) { if (f.type === "error") fail(new VoiceError("upstream", `the realtime handshake was refused (${f.errorType ?? "error"})`)); return; }
          o.onEvent(f);
        },
        close: (code, reason) => {
          if (!session) { fail(new VoiceError("upstream", `the realtime socket closed with ${code} before the handshake`, code)); return; }
          session.closedWith = { code, reason: reason.slice(0, 200) };
          for (const w of session.waiters.splice(0)) w(session.closedWith);
          o.onClose?.(code, reason);
        },
        error: () => { /* the close that follows carries the outcome */ }
      });
    });
  }

  get closed(): { code: number; reason: string } | null { return this.closedWith; }

  // Sends samples as 16-bit little-endian PCM at the session's rate.
  send(samples: Float32Array): void {
    if (this.ended || this.closedWith) return;
    const b = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767))), i * 2);
    this.sentBytes += b.length;
    this.sock.sendBinary(b);
  }

  // Milliseconds of audio sent so far.
  get sentMs(): number { return (this.sentBytes / 2 / this.rate) * 1000; }

  // Ends input and waits for the server to finish and close, or for the wait to run out.
  end(waitMs = 15_000): Promise<{ code: number; reason: string }> {
    if (this.closedWith) return Promise.resolve(this.closedWith);
    if (!this.ended) { this.ended = true; this.sock.sendText(JSON.stringify({ type: "endStream" })); }
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.sock.close(1000); resolve({ code: 1006, reason: "no close from the server in time" }); }, waitMs);
      t.unref?.();
      this.waiters.push((c) => { clearTimeout(t); resolve(c); });
    });
  }

  // Closes at once, dropping anything the server still holds.
  abort(): void { this.ended = true; this.sock.close(1000); }
}
