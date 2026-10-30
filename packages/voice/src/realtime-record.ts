import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SocketFactory } from "./ws.js";

// One kept realtime connection: the handshake without its credential, every server frame with the audio bytes sent before it, and the close with the audio's hash.
export type KeptFrame = { conn: number; kind: "open"; handshake: Record<string, unknown> } | { conn: number; kind: "frame"; sent_bytes: number; text: string } | { conn: number; kind: "close"; sent_bytes: number; code: number; reason: string; audio_sha256: string };

const withoutKey = (t: string): Record<string, unknown> => { try { const { authorization: _a, ...rest } = JSON.parse(t) as Record<string, unknown>; return rest; } catch { return {}; } };

// Wraps a live socket so every realtime connection is kept as its events, never its audio, for a replay that cannot resend audio faster than it was spoken.
export function recordingSocket(inner: SocketFactory, file: string): SocketFactory {
  let n = existsSync(file) ? Math.max(-1, ...readKept(file).map((f) => f.conn)) + 1 : 0;
  mkdirSync(dirname(file), { recursive: true });
  const put = (f: KeptFrame) => appendFileSync(file, `${JSON.stringify(f)}\n`);
  return (url, on) => {
    const conn = n++;
    const hash = createHash("sha256");
    let sent = 0, first = true;
    const sock = inner(url, {
      open: on.open, error: on.error,
      text: (t) => { put({ conn, kind: "frame", sent_bytes: sent, text: t }); on.text(t); },
      close: (code, reason) => { put({ conn, kind: "close", sent_bytes: sent, code, reason, audio_sha256: hash.copy().digest("hex") }); on.close(code, reason); }
    });
    return {
      sendText: (t) => { if (first) { first = false; put({ conn, kind: "open", handshake: withoutKey(t) }); } sock.sendText(t); },
      sendBinary: (b) => { sent += b.length; hash.update(b); sock.sendBinary(b); },
      close: (code, reason) => sock.close(code, reason)
    };
  };
}

export const readKept = (file: string): KeptFrame[] => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as KeptFrame);

// Answers realtime connections from kept events in the order they were opened: each frame comes once the same audio bytes have been sent, and audio that differs from the kept run fails.
export function replaySocket(file: string): SocketFactory {
  const kept = readKept(file);
  let n = 0;
  return (_url, on) => {
    const conn = n++;
    const frames = kept.filter((f) => f.conn === conn);
    const close = frames.find((f): f is Extract<KeptFrame, { kind: "close" }> => f.kind === "close");
    const queue = frames.filter((f): f is Extract<KeptFrame, { kind: "frame" }> => f.kind === "frame");
    const hash = createHash("sha256");
    let sent = 0, done = false, started = false;
    const finish = (code: number, reason: string) => { if (!done) { done = true; setImmediate(() => on.close(code, reason)); } };
    const flush = (all: boolean) => { while (queue.length && (all || queue[0]!.sent_bytes <= sent)) { const t = queue.shift()!.text; setImmediate(() => on.text(t)); } };
    setImmediate(() => { if (!frames.length) { on.text(JSON.stringify({ type: "error", message: "no kept realtime session for this connection", sessionId: "" })); finish(1008, "no kept session"); } else on.open(); });
    return {
      sendText: (t) => {
        if (done) return;
        if (!started) { started = true; flush(false); return; }
        if (/"endStream"/.test(t)) {
          if (close && hash.copy().digest("hex") !== close.audio_sha256) { setImmediate(() => on.text(JSON.stringify({ type: "error", message: "the audio differs from the kept run", sessionId: "" }))); finish(1008, "audio differs from the kept run"); return; }
          flush(true);
          finish(close?.code ?? 1000, close?.reason ?? "");
        }
      },
      sendBinary: (b) => { if (done) return; sent += b.length; hash.update(b); flush(false); if (close && close.code !== 1000 && sent >= close.sent_bytes && !queue.length) finish(close.code, close.reason); },
      close: () => finish(1000, "")
    };
  };
}
