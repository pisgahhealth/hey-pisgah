import { SILENCE_RMS, concat } from "@hey-pisgah/voice";
import type { ListenSessions, ListenUtterance } from "./listen.js";
import type { EmrTarget } from "./port.js";
import { streamRepair, type StreamAsr, type StreamDecoder } from "./local-ears.js";
import { to16k } from "./speaker.js";

// The streaming ear ends a stretch after this much quiet, the same pause the strip waits before it cuts a chunk.
export const STREAM_ENDPOINT_MS = 700;
// Quiet kept before the first loud frame, so the second readings hear the start of the first word.
export const STREAM_PREROLL_MS = 300;
// Speech that runs this long with no pause is ended where it stands.
export const STREAM_MAX_MS = 30_000;
const FRAME_MS = 20;
// A live microphone cannot send audio much faster than it is spoken; past this lead a stream is a recording.
export const STREAM_LIVE_SLACK_MS = 2000;

type Live = {
  owner: string; target: EmrTarget; sid: string; sids: Set<string>; stretch: { target: EmrTarget; sid: string } | null; rate: number; frame: number; dec: StreamDecoder; carry: Float32Array;
  pre: Float32Array[]; buf: Float32Array[]; speech: boolean; quiet_ms: number; speech_ms: number; partial: string; work: Promise<unknown>; errors: string[]; opened: number; fed: number;
};

const rms = (x: Float32Array) => { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / Math.max(1, x.length)); };

export class StreamRefused extends Error { constructor(readonly reason: "faster_than_live") { super(`replayed audio refused: ${reason}`); } }

// Audio frames as they are spoken: the local model decodes while the clinician talks, a pause of STREAM_ENDPOINT_MS ends a stretch, and the listen rules take it from there.
export class StreamListener {
  private readonly live = new Map<string, Live>();
  constructor(private readonly listen: ListenSessions, private readonly asr: StreamAsr, private readonly o: { endpointMs?: number; now?: () => number; refuseFasterThanLive?: boolean; onHeard?: (sessionId: string, us: ListenUtterance[]) => void } = {}) {}

  // Opens a stream under session_id; its lines go to listen_sid's listening session, which is session_id unless given.
  open(c: { owner: string; target: EmrTarget; session_id: string; rate: number; listen_sid?: string }): void {
    if (this.live.has(c.session_id)) throw new Error("this listening session is already streaming");
    const sid = c.listen_sid ?? c.session_id;
    this.live.set(c.session_id, {
      owner: c.owner, target: c.target, sid, sids: new Set([sid]), stretch: null, rate: c.rate, frame: Math.round((c.rate * FRAME_MS) / 1000), dec: this.asr.open(), carry: new Float32Array(0),
      pre: [], buf: [], speech: false, quiet_ms: 0, speech_ms: 0, partial: "", work: Promise.resolve(), errors: [], opened: this.o.now?.() ?? Date.now(), fed: 0
    });
  }

  // Takes any number of samples; whole frames are decoded at once and the rest waits for the next call.
  feed(sessionId: string, samples: Float32Array): void {
    const l = this.live.get(sessionId);
    if (!l) throw new Error("this listening session is not streaming");
    l.fed += samples.length;
    // The same rule the chunk path's replay guard applies: with refusal on, audio that runs ahead of the clock is refused before it is heard.
    if (this.o.refuseFasterThanLive && (l.fed / l.rate) * 1000 > (this.o.now?.() ?? Date.now()) - l.opened + STREAM_LIVE_SLACK_MS) throw new StreamRefused("faster_than_live");
    const all = l.carry.length ? concat([l.carry, samples]) : samples;
    let i = 0;
    for (; i + l.frame <= all.length; i += l.frame) this.frame(sessionId, l, all.slice(i, i + l.frame));
    l.carry = all.slice(i);
  }

  // Ends the stream: speech still open is finished as it stands, every stretch is handed on, and a line waiting on a number goes alone.
  async end(sessionId: string): Promise<{ utterances: ListenUtterance[]; errors: string[] }> {
    const l = this.live.get(sessionId);
    if (!l) return { utterances: [], errors: [] };
    if (l.speech) this.cut(sessionId, l);
    this.live.delete(sessionId);
    await l.work;
    for (const sid of l.sids) await this.listen.flush(sid);
    const utterances: ListenUtterance[] = [], errors = [...l.errors];
    for (const sid of l.sids) { const r = this.listen.unreportedOf(sid); utterances.push(...r.utterances); errors.push(...r.errors); }
    return { utterances, errors };
  }

  // A patient change: the stretch being said keeps the patient it began with, as a chunk keeps the page its words began on, and the next stretch takes the new one.
  async retarget(sessionId: string, c: { target: EmrTarget; listen_sid: string }): Promise<void> {
    const l = this.live.get(sessionId);
    if (!l) throw new Error("this listening session is not streaming");
    l.target = c.target;
    l.sid = c.listen_sid;
    l.sids.add(c.listen_sid);
  }

  // Waits for every stretch handed on so far.
  async drain(sessionId: string): Promise<void> { await this.live.get(sessionId)?.work; }

  private frame(sessionId: string, l: Live, x: Float32Array): void {
    const quiet = rms(x) < SILENCE_RMS;
    l.dec.accept(l.rate === 16_000 ? x : to16k(x, l.rate));
    if (!l.speech) {
      if (quiet) {
        l.pre.push(x);
        if (l.pre.length * FRAME_MS > STREAM_PREROLL_MS) l.pre.shift();
        return;
      }
      l.speech = true;
      l.stretch = { target: l.target, sid: l.sid };
      l.buf = [...l.pre, x];
      l.pre = [];
      l.quiet_ms = 0;
      l.speech_ms = FRAME_MS;
      return;
    }
    l.buf.push(x);
    l.speech_ms += FRAME_MS;
    l.quiet_ms = quiet ? l.quiet_ms + FRAME_MS : 0;
    // While a line that ended on a number waits, the next words are looked at as they are said, after every stretch before them.
    const said = l.dec.text();
    const sid = l.stretch?.sid ?? l.sid;
    if (said !== l.partial) { l.partial = said; l.work = l.work.then(() => this.listen.nextWords(sid, said)); }
    if (l.quiet_ms >= (this.o.endpointMs ?? STREAM_ENDPOINT_MS) || l.speech_ms >= STREAM_MAX_MS) this.cut(sessionId, l);
  }

  // Ends one stretch: the model gives its words, a fresh decoder takes the next audio, and the stretch joins the listen chain.
  private cut(sessionId: string, l: Live): void {
    const raw = streamRepair(l.dec.finish());
    const samples = concat(l.buf);
    const trailing = l.quiet_ms;
    const now = this.o.now?.() ?? Date.now();
    const { target, sid } = l.stretch ?? { target: l.target, sid: l.sid };
    l.dec = this.asr.open();
    l.speech = false; l.buf = []; l.quiet_ms = 0; l.speech_ms = 0; l.partial = ""; l.stretch = null;
    if (!raw) return;
    l.work = l.work.then(() => this.listen.segment({ owner: l.owner, target, session_id: sid, samples, rate: l.rate, raw, trailing_ms: trailing, arrived: now, heard_at: now }))
      .then((us) => { if (us.length) this.o.onHeard?.(sid, us); })
      .catch((e: unknown) => { l.errors.push(e instanceof Error ? e.message.slice(0, 200) : "segment failed"); });
  }
}
