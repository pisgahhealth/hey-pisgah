import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";

// What a realtime socket reports; text frames only, since the realtime endpoint sends no binary frames.
export type SocketEvents = { open(): void; text(s: string): void; close(code: number, reason: string): void; error(e: Error): void };
export type RealtimeSocket = { sendText(s: string): void; sendBinary(b: Uint8Array): void; close(code?: number, reason?: string): void };
export type SocketFactory = (url: string, on: SocketEvents) => RealtimeSocket;

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// Frames larger than this from the server are refused, since no realtime event comes near it.
const MAX_FRAME = 1 << 20;

// One masked client frame: FIN set, the opcode, the length in 7, 16 or 64 bits, the mask and the masked payload.
export function encodeFrame(opcode: number, payload: Uint8Array, mask: Uint8Array = randomBytes(4)): Buffer {
  const n = payload.length;
  const head = n < 126 ? 2 : n < 65536 ? 4 : 10;
  const out = Buffer.alloc(head + 4 + n);
  out[0] = 0x80 | opcode;
  if (n < 126) out[1] = 0x80 | n;
  else if (n < 65536) { out[1] = 0x80 | 126; out.writeUInt16BE(n, 2); }
  else { out[1] = 0x80 | 127; out.writeBigUInt64BE(BigInt(n), 2); }
  out.set(mask, head);
  for (let i = 0; i < n; i++) out[head + 4 + i] = payload[i]! ^ mask[i & 3]!;
  return out;
}

export type Frame = { fin: boolean; opcode: number; payload: Buffer };
// Reads whole server frames off the front of a buffer and returns them with the bytes left over.
export function decodeFrames(buf: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = [];
  let at = 0;
  for (;;) {
    if (buf.length - at < 2) break;
    const b0 = buf[at]!, b1 = buf[at + 1]!;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (buf.length - at < 4) break; len = buf.readUInt16BE(at + 2); off = 4; }
    else if (len === 127) { if (buf.length - at < 10) break; const big = buf.readBigUInt64BE(at + 2); if (big > BigInt(MAX_FRAME)) throw new Error("frame too large"); len = Number(big); off = 10; }
    if (len > MAX_FRAME) throw new Error("frame too large");
    const masked = (b1 & 0x80) !== 0;
    const total = off + (masked ? 4 : 0) + len;
    if (buf.length - at < total) break;
    let payload = buf.subarray(at + off + (masked ? 4 : 0), at + total);
    if (masked) { const m = buf.subarray(at + off, at + off + 4); payload = Buffer.from(payload.map((x, i) => x ^ m[i & 3]!)); }
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload: Buffer.from(payload) });
    at += total;
  }
  return { frames, rest: buf.subarray(at) };
}

// A WebSocket client on Node's own http and https, enough for the realtime endpoint: text and binary out, text in, ping answered, close both ways.
export const nodeSocket: SocketFactory = (url, on) => {
  const u = new URL(url);
  const key = randomBytes(16).toString("base64");
  const secure = u.protocol === "wss:";
  const req = (secure ? httpsRequest : httpRequest)({
    host: u.hostname, port: u.port || (secure ? 443 : 80), path: `${u.pathname}${u.search}`, method: "GET",
    headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" }
  });
  let sock: Socket | null = null;
  let closed = false;
  let sentClose = false;
  const finish = (code: number, reason: string) => { if (closed) return; closed = true; sock?.destroy(); on.close(code, reason); };
  const write = (opcode: number, payload: Uint8Array) => { if (sock && !closed && !sock.destroyed) sock.write(encodeFrame(opcode, payload)); };
  req.on("response", (res) => { finish(1006, `upgrade refused with HTTP ${res.statusCode}`); res.resume(); });
  req.on("error", (e) => { if (!closed) { on.error(e); finish(1006, e.message.slice(0, 200)); } });
  req.on("upgrade", (res, s, head) => {
    sock = s;
    const want = createHash("sha1").update(key + GUID).digest("base64");
    if (res.headers["sec-websocket-accept"] !== want) { finish(1006, "bad upgrade answer"); return; }
    s.setNoDelay(true);
    let buf: Buffer = Buffer.from(head);
    let parts: Buffer[] = [];
    let partOp = 0;
    const onData = (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      let r: ReturnType<typeof decodeFrames>;
      try { r = decodeFrames(buf); } catch (e) { on.error(e as Error); finish(1009, "frame too large"); return; }
      buf = r.rest;
      for (const f of r.frames) {
        if (f.opcode === 0x9) { write(0xA, f.payload); continue; }
        if (f.opcode === 0xA) continue;
        if (f.opcode === 0x8) {
          const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
          const reason = f.payload.length > 2 ? f.payload.subarray(2).toString("utf8") : "";
          if (!sentClose) { sentClose = true; write(0x8, f.payload.subarray(0, 2)); }
          finish(code, reason);
          return;
        }
        if (f.opcode === 0x1 || f.opcode === 0x2) { parts = [f.payload]; partOp = f.opcode; }
        else if (f.opcode === 0x0) parts.push(f.payload);
        if (f.fin && (f.opcode === 0x0 || f.opcode === 0x1 || f.opcode === 0x2)) {
          const whole = Buffer.concat(parts);
          parts = [];
          if (partOp === 0x1) on.text(whole.toString("utf8"));
        }
      }
    };
    if (buf.length) { const first = buf; buf = Buffer.alloc(0); onData(first); }
    s.on("data", onData);
    s.on("close", () => finish(1006, "connection closed without a close frame"));
    s.on("error", (e) => { if (!closed) on.error(e); });
    on.open();
  });
  req.end();
  return {
    sendText: (t) => write(0x1, Buffer.from(t, "utf8")),
    sendBinary: (b) => write(0x2, b),
    close: (code = 1000, reason = "") => {
      if (closed) return;
      if (!sock) { req.destroy(); finish(code, reason); return; }
      if (!sentClose) { sentClose = true; const p = Buffer.alloc(2 + Buffer.byteLength(reason)); p.writeUInt16BE(code, 0); p.write(reason, 2); write(0x8, p); }
      setTimeout(() => finish(code, reason), 2000).unref();
    }
  };
};
