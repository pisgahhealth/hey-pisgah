import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ChunkPresence } from "./speaker.js";

// D30's hands-free presence: the strip beats every few seconds while its tab is visible and its microphone is live, signed with a key only that browser session holds.
export const HEARTBEAT_RULE = {
  // How often the strip beats, and how old the last beat may be before the session counts as absent.
  beat_ms: 10_000, fresh_ms: 30_000,
  // A session counts only while the owner's own voice was matched in it this recently, or it opened this recently; provisional, for Samuel to set (N).
  owner_voice_ms: 600_000,
  // How far a beat's own clock may sit from the agent service's.
  skew_ms: 30_000,
  sessions: 2000
} as const;
export type HeartbeatRule = { -readonly [K in keyof typeof HEARTBEAT_RULE]: number };

export type Beat = { owner: string; session_id: string; seq: number; at: number; visible: boolean; mic_live: boolean; mac: string };
// The exact text the strip signs: session, sequence, its clock, then 1 or 0 for visible and for the microphone, one per line.
export const beatText = (b: Omit<Beat, "owner" | "mac">): string => `${b.session_id}\n${b.seq}\n${b.at}\n${b.visible ? 1 : 0}\n${b.mic_live ? 1 : 0}`;
export const beatMac = (key: string, b: Omit<Beat, "owner" | "mac">): string => createHmac("sha256", Buffer.from(key, "base64url")).update(beatText(b), "utf8").digest("hex");

type Held = { key: string; opened: number; seq: number; last: { at: number; visible: boolean; mic_live: boolean } | null; ownerVoice: number | null };
export type BeatAnswer = { ok: true; present: boolean; reason?: string } | { ok: false; reason: "unknown_session" | "bad_mac" | "stale_seq" | "clock_skew" };

// Keys, beats and the last owner match per strip session, in memory only; nothing of the audio is involved.
export class Heartbeats {
  private readonly held = new Map<string, Held>();
  constructor(private readonly rule: HeartbeatRule = HEARTBEAT_RULE, private readonly now: () => number = Date.now) {}

  // A new key for one strip session; a session still beating keeps its key, so nobody else can take it over; a lapsed one is replaced and keeps its owner-voice clock.
  open(owner: string, sessionId: string): { key: string; beat_ms: number; fresh_ms: number; owner_voice_ms: number } | null {
    const id = `${owner}\u0000${sessionId}`;
    const was = this.held.get(id);
    if (was?.last && this.now() - was.last.at <= this.rule.fresh_ms) return null;
    const key = randomBytes(32).toString("base64url");
    this.held.delete(id);
    this.held.set(id, { key, opened: was?.opened ?? this.now(), seq: -1, last: null, ownerVoice: was?.ownerVoice ?? null });
    if (this.held.size > this.rule.sessions) this.held.delete(this.held.keys().next().value!);
    return { key, beat_ms: this.rule.beat_ms, fresh_ms: this.rule.fresh_ms, owner_voice_ms: this.rule.owner_voice_ms };
  }

  // One beat: its signature, a sequence that only moves forward and a clock close to ours, else it is refused and changes nothing.
  beat(b: Beat): BeatAnswer {
    const h = this.held.get(`${b.owner}\u0000${b.session_id}`);
    if (!h) return { ok: false, reason: "unknown_session" };
    const want = Buffer.from(beatMac(h.key, b), "hex"), got = Buffer.from(/^[0-9a-f]{64}$/.test(b.mac) ? b.mac : "", "hex");
    if (got.length !== want.length || !timingSafeEqual(want, got)) return { ok: false, reason: "bad_mac" };
    if (!Number.isSafeInteger(b.seq) || b.seq <= h.seq) return { ok: false, reason: "stale_seq" };
    if (Math.abs(b.at - this.now()) > this.rule.skew_ms) return { ok: false, reason: "clock_skew" };
    h.seq = b.seq;
    h.last = { at: this.now(), visible: b.visible, mic_live: b.mic_live };
    const p = this.present(b.owner, b.session_id);
    return p.live === true ? { ok: true, present: true } : { ok: true, present: false, reason: p.live === false ? p.reason : "unknown" };
  }

  // The owner's own voice was matched on a line from this session.
  ownerVoice(owner: string, sessionId: string): void {
    const h = this.held.get(`${owner}\u0000${sessionId}`);
    if (h) h.ownerVoice = this.now();
  }

  // Present only with a fresh beat saying visible and live, and the owner's voice matched in this session recently, or the session new.
  present(owner: string, sessionId: string): ChunkPresence {
    const h = this.held.get(`${owner}\u0000${sessionId}`);
    const now = this.now();
    if (!h || !h.last || now - h.last.at > this.rule.fresh_ms) return { live: false, reason: "no_heartbeat" };
    if (!h.last.visible) return { live: false, reason: "page_hidden" };
    if (!h.last.mic_live) return { live: false, reason: "mic_not_live" };
    if (now - (h.ownerVoice ?? h.opened) > this.rule.owner_voice_ms) return { live: false, reason: "no_recent_owner_voice" };
    return { live: true };
  }
}
