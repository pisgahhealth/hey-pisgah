import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { concat, encodeWav, type FinalTranscript, type SocketFactory } from "@hey-pisgah/voice";
import { ListenSessions, type StreamSegment, type Transcriber } from "../src/emr/listen.js";
import { MetaStreamListener } from "../src/emr/meta-stream.js";
import type { EmrRuntime } from "../src/emr/runtime.js";
import { ADM, OWNER } from "./emr-helpers.js";

// The 3 Nov 21:37 encounter: every line was final 4.65 s after its audio ended, a burst waited on the line before it, and two lines had no realtime turn at all.
const RATE = 16_000;
const quiet = (ms: number) => new Float32Array((RATE * ms) / 1000);
const tone = (ms: number) => { const x = new Float32Array((RATE * ms) / 1000); for (let k = 0; k < x.length; k++) x[k] = 0.3 * Math.sin((2 * Math.PI * 220 * k) / RATE); return x; };
const FRAME = 20;
const rmsOf = (b: Int16Array) => { let s = 0; for (const v of b) s += (v / 32768) ** 2; return Math.sqrt(s / Math.max(1, b.length)); };

// Meta's realtime ear as it behaves live: it hears audio no faster than real time from the handshake, ends a turn after endpointMs of quiet, and may miss a turn or send it late.
function pacedMeta(o: { turns: string[]; skip?: number; lateMs?: number; endpointMs?: number }) {
  const conns: { sentMs: number }[] = [];
  const factory: SocketFactory = (_url, on) => {
    const c = { sentMs: 0 };
    conns.push(c);
    const loud: boolean[] = [];
    let carry = new Int16Array(0), opened = 0, pos = 0, start = -1, last = -1, k = 0, closed = false, acked = false;
    let tick: ReturnType<typeof setInterval> | null = null;
    const send = (ev: Record<string, unknown>) => { if (!closed) on.text(JSON.stringify(ev)); };
    const endTurn = () => {
      const id = k++, s = start, e = last, text = o.turns[id] ?? "";
      start = -1;
      const turn = () => { send({ type: "speechStart", turnId: id, audioProcessedMs: s }); send({ type: "speechEnd", turnId: id, audioProcessedMs: e }); send({ type: "speechComplete", turnId: id, transcript: text, audioProcessedMs: e }); };
      if (id !== o.skip) { send({ type: "speechEnd", turnId: id, audioProcessedMs: e }); send({ type: "speechComplete", turnId: id, transcript: text, audioProcessedMs: e }); }
      else if (o.lateMs !== undefined) setTimeout(turn, o.lateMs);
    };
    const hear = (upTo: number) => {
      for (; pos < upTo; pos++) {
        const at = pos * FRAME;
        if (loud[pos]) { if (start < 0) { start = at; if (k !== o.skip) send({ type: "speechStart", turnId: k, audioProcessedMs: at }); } last = at + FRAME; }
        else if (start >= 0 && at + FRAME - last >= (o.endpointMs ?? 600)) endTurn();
      }
    };
    queueMicrotask(() => on.open());
    return {
      sendText: (t) => {
        const x = JSON.parse(t) as Record<string, unknown>;
        if (!acked) { acked = true; queueMicrotask(() => { opened = Date.now(); on.text(JSON.stringify({ sessionId: `meta-${conns.length}` })); tick = setInterval(() => hear(Math.min(loud.length, Math.floor((Date.now() - opened) / FRAME))), FRAME); }); return; }
        if (x["type"] === "endStream") { hear(loud.length); if (start >= 0) endTurn(); if (tick) clearInterval(tick); queueMicrotask(() => { closed = true; on.close(1000, "No more transcript segments"); }); }
      },
      sendBinary: (b) => {
        const x = new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
        c.sentMs += (x.length / RATE) * 1000;
        const all = new Int16Array(carry.length + x.length);
        all.set(carry); all.set(x, carry.length);
        const n = (RATE * FRAME) / 1000;
        let i = 0;
        for (; i + n <= all.length; i += n) loud.push(rmsOf(all.subarray(i, i + n)) >= 0.01);
        carry = all.slice(i);
      },
      close: () => { if (tick) clearInterval(tick); if (!closed) { closed = true; queueMicrotask(() => on.close(1000, "")); } }
    };
  };
  return { factory, conns };
}

// A stand-in for the listen chain that keeps every segment with the time it arrived.
function chain() {
  const got: (StreamSegment & { at: number })[] = [];
  const l = {
    hintsFor: async () => [], nextWords: () => undefined, flush: async () => undefined, unreportedOf: () => ({ utterances: [], errors: [] }),
    segment: async (c: StreamSegment) => { got.push({ ...c, at: Date.now() }); return []; },
    admit: () => ({ refused: null, presence: { live: null } })
  } as unknown as ListenSessions;
  return { l, got };
}

// Feeds audio as a live strip does, one 80 ms part every 80 ms, each bound to when it was captured; returns when each stretch ended.
async function live(m: MetaStreamListener, sid: string, parts: [kind: "tone" | "quiet", ms: number][]): Promise<number[]> {
  const ends: number[] = [];
  for (const [kind, ms] of parts) {
    for (let t = 0; t < ms; t += 80) { await vi.advanceTimersByTimeAsync(80); m.feed(sid, kind === "tone" ? tone(80) : quiet(80), Date.now() - 80); }
    ends.push(Date.now());
  }
  return ends;
}

beforeEach(() => { vi.useFakeTimers({ now: 1_800_000_000_000 }); });
afterEach(() => { vi.useRealTimers(); });

describe("a spoken line reaches the listen chain about a second after it ends", () => {
  it("catches a stream that opened with a backlog up to live, so a word-ending line is final within about 1 s of its end", async () => {
    const meta = pacedMeta({ turns: ["Good morning.", "Chart his pulse rate please."] });
    const { l, got } = chain();
    const m = new MetaStreamListener(l, { key: () => "k", socket: meta.factory });
    await m.open({ owner: OWNER, target: { admission_id: ADM }, session_id: "lag", rate: RATE });
    // The strip held 6 s while the stream opened (a greeting, then quiet), and it arrives in one part.
    m.feed("lag", concat([tone(1000), quiet(5000)]), Date.now() - 6000);
    const ends = await live(m, "lag", [["quiet", 2000], ["tone", 1520], ["quiet", 2480]]);
    await vi.advanceTimersByTimeAsync(1000);
    const line = got.find((s) => s.raw === "Chart his pulse rate please.");
    expect(line).toBeDefined();
    const ms = line!.at - ends[1]!;
    console.log(`word-ending line final ${ms} ms after its audio ended`);
    expect(ms).toBeLessThanOrEqual(1100);
    expect(line!.trailing_ms).toBeLessThanOrEqual(1100);
    const r = await m.end("lag");
    expect(r.trimmed_ms).toBeGreaterThan(4000);
  });

  it("leaves a live stream with no backlog alone: nothing is trimmed and the line is final at the realtime ear's own end of turn", async () => {
    const meta = pacedMeta({ turns: ["Chart his pulse rate please."] });
    const { l, got } = chain();
    const m = new MetaStreamListener(l, { key: () => "k", socket: meta.factory });
    await m.open({ owner: OWNER, target: { admission_id: ADM }, session_id: "live", rate: RATE });
    const ends = await live(m, "live", [["quiet", 1200], ["tone", 1520], ["quiet", 2480]]);
    await vi.advanceTimersByTimeAsync(500);
    expect(got.map((s) => s.raw)).toEqual(["Chart his pulse rate please."]);
    expect(got[0]!.at - ends[1]!).toBeLessThanOrEqual(1100);
    expect((await m.end("live")).trimmed_ms).toBe(0);
  });
});

describe("speech the realtime ear never turns into words", () => {
  const said = [["quiet", 480], ["tone", 1520], ["quiet", 1520], ["tone", 2000], ["quiet", 1520], ["tone", 1360], ["quiet", 8000]] as [kind: "tone" | "quiet", ms: number][];
  const turns = ["Chart his pulse.", "Send a full blood count and a malaria test.", "Thank you."];

  it("is read by the fallback ear 6 s after it ends and delivered once, and the realtime turn that comes late for it is dropped and counted", async () => {
    const meta = pacedMeta({ turns, skip: 1, lateMs: 9000 });
    const { l, got } = chain();
    const fallback = vi.fn(async (_wav: Uint8Array) => "send a full blood count and a malaria test");
    const m = new MetaStreamListener(l, { key: () => "k", socket: meta.factory, fallback });
    await m.open({ owner: OWNER, target: { admission_id: ADM }, session_id: "miss", rate: RATE });
    const ends = await live(m, "miss", said);
    await vi.advanceTimersByTimeAsync(4000);
    expect(fallback).toHaveBeenCalledTimes(1);
    const fb = got.filter((s) => s.finished_by === "fallback_parakeet");
    expect(fb.map((s) => s.raw)).toEqual(["send a full blood count and a malaria test"]);
    expect(fb[0]!.at - ends[3]!).toBeLessThanOrEqual(6300);
    const r = await m.end("miss");
    expect(got.map((s) => s.raw)).toEqual(["Chart his pulse.", "Thank you.", "send a full blood count and a malaria test"]);
    expect(r).toMatchObject({ fallbacks: 1, late_dropped: 1 });
  });

  it("still reads a second stretch when a late realtime turn covers it and a stretch the fallback ear already claimed", async () => {
    // Meta needs a second of quiet to end a turn here, so one turn covers both stretches, and it arrives after the first was claimed but before the second's wait is over.
    const meta = pacedMeta({ turns: ["first part and second part"], skip: 0, lateMs: 4000, endpointMs: 1000 });
    const { l, got } = chain();
    const reads = ["first part", "second part"];
    const fallback = vi.fn(async (_wav: Uint8Array) => reads.shift() ?? "");
    const m = new MetaStreamListener(l, { key: () => "k", socket: meta.factory, fallback });
    await m.open({ owner: OWNER, target: { admission_id: ADM }, session_id: "two", rate: RATE });
    await live(m, "two", [["quiet", 480], ["tone", 1520], ["quiet", 880], ["tone", 1520], ["quiet", 9040]]);
    const r = await m.end("two");
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(got.map((s) => [s.raw, s.finished_by])).toEqual([["first part", "fallback_parakeet"], ["second part", "fallback_parakeet"]]);
    expect(r).toMatchObject({ fallbacks: 2, late_dropped: 1 });
  });

  it("waits from when Meta could hear a stretch, so a stream that opened 8 s behind real time keeps Meta's own lines", async () => {
    const meta = pacedMeta({ turns: ["Good morning.", "Chart his pulse."] });
    const { l, got } = chain();
    const fallback = vi.fn(async (_wav: Uint8Array) => "never");
    const m = new MetaStreamListener(l, { key: () => "k", socket: meta.factory, fallback });
    await m.open({ owner: OWNER, target: { admission_id: ADM }, session_id: "behind", rate: RATE });
    m.feed("behind", concat([tone(1500), quiet(1000), tone(1500), quiet(4000)]), Date.now() - 8000);
    await live(m, "behind", [["quiet", 9040]]);
    const r = await m.end("behind");
    expect(fallback).not.toHaveBeenCalled();
    expect(got.map((s) => s.raw)).toEqual(["Good morning.", "Chart his pulse."]);
    expect(r).toMatchObject({ fallbacks: 0, late_dropped: 0 });
  });

  it("never calls the fallback ear when every stretch of speech got its realtime turn", async () => {
    const meta = pacedMeta({ turns });
    const { l, got } = chain();
    const fallback = vi.fn(async (_wav: Uint8Array) => "never");
    const m = new MetaStreamListener(l, { key: () => "k", socket: meta.factory, fallback });
    await m.open({ owner: OWNER, target: { admission_id: ADM }, session_id: "all", rate: RATE });
    await live(m, "all", said);
    const r = await m.end("all");
    expect(fallback).not.toHaveBeenCalled();
    expect(got.map((s) => s.raw)).toEqual(turns);
    expect(r).toMatchObject({ fallbacks: 0, late_dropped: 0 });
  });
});

// The runtime as the listen chain sees it: the session's context and each line handed to say, with the time it was handed.
function runtime() {
  const said: { text: string; at: number; finished_by: string | undefined; second_reading?: string; seqs?: number[] }[] = [];
  const rt = {
    listenContext: async () => ({ admission_id: ADM, patient_id: null, label: "", facts: {}, keywords: [] }), port: {}, speculate: () => false, task: () => undefined,
    say: async (s: { text: string; ambient?: { finished_by?: string; second_reading?: string; seqs?: number[] } }) => { said.push({ text: s.text, at: Date.now(), finished_by: s.ambient?.finished_by, ...(s.ambient?.second_reading ? { second_reading: s.ambient.second_reading } : {}), ...(s.ambient?.seqs ? { seqs: s.ambient.seqs } : {}) }); return { task_id: "t-1", line_id: `u-${said.length}` }; }
  } as unknown as EmrRuntime;
  return { rt, said };
}
const chunkOf = (talkMs: number, quietMs: number) => encodeWav(concat([tone(talkMs), quiet(quietMs)]), RATE);
// Voice Transcribe as a script by chunk numbers, taking latencyMs for every call.
const slowEar = (byId: Record<string, string>, latencyMs: number, calls: string[] = []): Transcriber => async (wav, _k, id): Promise<FinalTranscript> => {
  calls.push(id);
  await new Promise((r) => setTimeout(r, latencyMs));
  return { final: true, text: byId[id] ?? "", audio_ms: 0, session_id: id, cost_usd: 0 };
};

describe("finished chunks are transcribed as they end and delivered in spoken order", () => {
  it("delivers three chunks ending a second apart each within one transcription latency of its end, in order", async () => {
    const { rt, said } = runtime();
    const listen = new ListenSessions(rt, { transcribe: slowEar({ "s1-0": "Good morning.", "s1-1": "He has a cough.", "s1-2": "Send a full blood count." }, 2000) });
    const ends: number[] = [];
    for (let seq = 0; seq < 3; seq++) {
      if (seq) await vi.advanceTimersByTimeAsync(1000);
      ends.push(Date.now());
      void listen.chunk({ owner: OWNER, target: { admission_id: ADM }, session_id: "s1", seq, wav: chunkOf(1000, 700) });
    }
    await vi.advanceTimersByTimeAsync(6000);
    expect(said.map((x) => x.text)).toEqual(["Good morning.", "He has a cough.", "Send a full blood count."]);
    const lat = said.map((x, i) => x.at - ends[i]!);
    console.log(`delivered after its end: ${lat.join(", ")} ms`);
    for (const ms of lat) expect(ms).toBeLessThanOrEqual(2100);
  });

  it("still joins a line cut where a value must follow with the next chunk, transcribing the joined audio once", async () => {
    const { rt, said } = runtime();
    const calls: string[] = [];
    const listen = new ListenSessions(rt, { transcribe: slowEar({ "s2-0": "Temperature thirty eight point", "s2-1": "nine.", "s2-0.1": "Temperature thirty eight point nine." }, 500, calls) });
    void listen.chunk({ owner: OWNER, target: { admission_id: ADM }, session_id: "s2", seq: 0, wav: chunkOf(1300, 700) });
    await vi.advanceTimersByTimeAsync(800);
    void listen.chunk({ owner: OWNER, target: { admission_id: ADM }, session_id: "s2", seq: 1, wav: chunkOf(500, 700) });
    // The joined line ends on a number, so it still waits its number window before it goes.
    await vi.advanceTimersByTimeAsync(5000);
    expect(said).toEqual([expect.objectContaining({ text: "Temperature 38.9.", finished_by: "joined_across_cut" })]);
    // The second chunk is never read alone: the chain already knew the first line waits for it.
    expect(calls).toEqual(["s2-0", "s2-0.1"]);
  });

  it("delivers a fallback line alone, never joined with a line waiting for its number, and after that line when it was said first", async () => {
    const { rt, said } = runtime();
    const listen = new ListenSessions(rt, { transcribe: slowEar({}, 0), numberJoinWaitMs: 3000 });
    const t0 = Date.now();
    const seg = (sid: string, raw: string, from: number, extra: Partial<StreamSegment> = {}) => listen.segment({ owner: OWNER, target: { admission_id: ADM }, session_id: sid, samples: tone(1000), rate: RATE, raw, trailing_ms: 0, arrived: Date.now(), capture_start: t0 + from, capture_end: t0 + from + 1000, ...extra });
    // The missed speech was said before the number line, so the number line keeps waiting for its own continuation.
    await seg("s3", "Pulse ninety", 5000);
    await seg("s3", "eight", 0, { finished_by: "fallback_parakeet" });
    expect(said).toEqual([expect.objectContaining({ text: "eight", finished_by: "fallback_parakeet" })]);
    await vi.advanceTimersByTimeAsync(3100);
    expect(said.map((x) => [x.text, x.finished_by])).toEqual([["eight", "fallback_parakeet"], ["Pulse 90", "number_alone"]]);
    // The missed speech was said after the number line, so the number line goes first, alone.
    said.length = 0;
    await seg("s4", "Pulse ninety", 0);
    await seg("s4", "eight", 5000, { finished_by: "fallback_parakeet" });
    expect(said.map((x) => [x.text, x.finished_by])).toEqual([["Pulse 90", "number_alone"], ["eight", "fallback_parakeet"]]);
  });

  // The four chunks held while the arrival opened in the live run of 4 Nov 04:45 (task t-6ec6a177), flushed to the patient at once: length, quiet at the end, and when each was captured.
  const flushed = (nameLeadMs: number) => [
    { seq: 1, lead: 0, total: 1680, tail: 700, at: 37_960 },
    { seq: 2, lead: 0, total: 2060, tail: 470, at: 40_900 },
    { seq: 3, lead: nameLeadMs, total: 2160, tail: 690, at: 42_960 },
    { seq: 4, lead: 0, total: 2820, tail: 690, at: 46_920 }
  ];
  const flushEar = { "h-1": "uh confusion.", "h-2": "her name is", "h-3": "Ada Obi.", "h-2.3": "her name is Ada Obi.", "h-4": "her temperature is 38.5" };
  async function replayFlush(nameLeadMs: number) {
    const { rt, said } = runtime();
    const listen = new ListenSessions(rt, { transcribe: slowEar(flushEar, 300), numberJoinWaitMs: 3000 });
    const t0 = Date.now();
    await vi.advanceTimersByTimeAsync(45_690);
    // The arrival is confirmed and every held chunk is handed to the patient's session in one go, each with its own capture and arrival time.
    for (const c of flushed(nameLeadMs)) void listen.chunk({ owner: OWNER, target: { admission_id: ADM }, session_id: "h", seq: c.seq, wav: encodeWav(concat([quiet(c.lead), tone(c.total - c.lead - c.tail), quiet(c.tail)]), RATE), captured_at: t0 + c.at, arrived_at: t0 + c.at + c.total + 50 });
    await vi.advanceTimersByTimeAsync(6000);
    return said;
  }

  it("joins 'her name is' with the name when held chunks are flushed at the arrival hand-over, and leaves the temperature alone", async () => {
    const said = await replayFlush(100);
    expect(said.map((x) => [x.text, x.finished_by, x.seqs])).toEqual([["uh confusion.", "quiet_tail", [1]], ["her name is Ada Obi.", "quiet_tail", [2, 3]], ["her temperature is 38.5", "number_alone", [4]]]);
  });

  it("keeps the name its own line when the pause before it was as long as the strip's tail, and a live short chunk with nothing behind it goes at once", async () => {
    const said = await replayFlush(700);
    expect(said.map((x) => [x.text, x.finished_by, x.seqs])).toEqual([["uh confusion.", "quiet_tail", [1]], ["her name is", "short_chunk", [2]], ["Ada Obi.", "quiet_tail", [3]], ["her temperature is 38.5", "number_alone", [4]]]);
    const live = runtime();
    const listen = new ListenSessions(live.rt, { transcribe: slowEar({ "l-2": "her name is" }, 300) });
    void listen.chunk({ owner: OWNER, target: { admission_id: ADM }, session_id: "l", seq: 2, wav: encodeWav(concat([tone(1590), quiet(470)]), RATE) });
    await vi.advanceTimersByTimeAsync(400);
    expect(live.said.map((x) => [x.text, x.finished_by])).toEqual([["her name is", "short_chunk"]]);
  });

  it("marks a fallback line with no independent second ear as having none, and one the serve routes as Voice Transcribe", async () => {
    const alone = runtime();
    const bare = new ListenSessions(alone.rt, { transcribe: slowEar({}, 0) });
    await bare.segment({ owner: OWNER, target: { admission_id: ADM }, session_id: "s5", samples: tone(1500), rate: RATE, raw: "Temperature thirty seven point six.", trailing_ms: 0, arrived: Date.now(), finished_by: "fallback_parakeet" });
    expect(alone.said).toEqual([expect.objectContaining({ finished_by: "fallback_parakeet", second_reading: "none" })]);
    const routed = runtime();
    const clips: Uint8Array[] = [];
    const served = new ListenSessions(routed.rt, { transcribe: slowEar({}, 0), fallbackClip: (clip) => { clips.push(clip); return "meta_rest"; } });
    await served.segment({ owner: OWNER, target: { admission_id: ADM }, session_id: "s6", samples: tone(1500), rate: RATE, raw: "Temperature thirty seven point six.", trailing_ms: 0, arrived: Date.now(), finished_by: "fallback_parakeet" });
    await served.segment({ owner: OWNER, target: { admission_id: ADM }, session_id: "s6", samples: tone(1500), rate: RATE, raw: "He has a cough.", trailing_ms: 0, arrived: Date.now() });
    expect(routed.said.map((x) => x.second_reading)).toEqual(["meta_rest", undefined]);
    // Only the fallback line's clip is routed away from the local ear.
    expect(clips).toHaveLength(1);
  });
});
