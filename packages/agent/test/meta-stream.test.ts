import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { recordingSocket, replaySocket, type SocketFactory } from "@hey-pisgah/voice";
import type { EarReading, SecondEar } from "../src/emr/ears.js";
import type { ListenSessions } from "../src/emr/listen.js";
import { asrSwitch } from "../src/emr/local-ears.js";
import { MetaStreamListener } from "../src/emr/meta-stream.js";
import type { EmrRuntime } from "../src/emr/runtime.js";
import { startEmrServe } from "../src/emr/serve.js";
import { KEPT_LEVERS, leversFrom } from "../src/emr/speed.js";
import { ADM, FakeEmr, OWNER, emrRoot, gater } from "./emr-helpers.js";
import { obs } from "./mic-helpers.js";

const RATE = 16_000;
const STRIP = "http://localhost:3311";
const reading = (text: string): EarReading => ({ text, provider: "local", model: "local:test", response_id: null, cost_usd: 0, fallback_reason: null });
const pcm = (parts: [kind: "tone" | "quiet", ms: number][]): Buffer => {
  const n = parts.reduce((s, [, ms]) => s + (ms * RATE) / 1000, 0);
  const b = Buffer.alloc(n * 2);
  let i = 0;
  for (const [kind, ms] of parts) for (let k = 0; k < (ms * RATE) / 1000; k++, i++) b.writeInt16LE(kind === "tone" ? Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 220 * k) / RATE)) : 0, i * 2);
  return b;
};

// A recorded event stream: each event is sent once this many milliseconds of audio have arrived on the connection.
type Scripted = { at_ms: number; ev: Record<string, unknown> };
type FakeConn = { handshake: Record<string, unknown> | null; sentBytes: number; ended: boolean; url: string };
// Meta's realtime endpoint as a script per connection; a connection with no script, or a close code in place of one, answers as the real endpoint does.
function fakeMeta(scripts: (Scripted[] | { refuse: number } | { dropAt: number; code: number; events: Scripted[] })[]) {
  const conns: FakeConn[] = [];
  const factory: SocketFactory = (url, on) => {
    const script = scripts[conns.length] ?? [];
    const c: FakeConn = { handshake: null, sentBytes: 0, ended: false, url };
    conns.push(c);
    const events = Array.isArray(script) ? [...script] : "events" in script ? [...script.events] : [];
    let closed = false;
    const close = (code: number, reason: string) => { if (!closed) { closed = true; setImmediate(() => on.close(code, reason)); } };
    const pump = () => { const ms = (c.sentBytes / 2 / RATE) * 1000; while (events.length && events[0]!.at_ms <= ms) { const e = events.shift()!; setImmediate(() => on.text(JSON.stringify(e.ev))); } };
    setImmediate(() => on.open());
    return {
      sendText: (t) => {
        const x = JSON.parse(t) as Record<string, unknown>;
        if (!c.handshake) {
          c.handshake = x;
          if ("refuse" in script) { setImmediate(() => on.text(JSON.stringify({ type: "error", message: "Unauthorized", sessionId: "", errorType: "authentication_error" }))); close(script.refuse, "Unauthorized"); return; }
          setImmediate(() => on.text(JSON.stringify({ sessionId: `meta-${conns.length}` })));
          return;
        }
        if (x["type"] === "endStream") { c.ended = true; while (events.length) { const e = events.shift()!; setImmediate(() => on.text(JSON.stringify(e.ev))); } setImmediate(() => on.text(JSON.stringify({ type: "transcript", transcript: "", final: true, audioProcessedMs: 0 }))); close(1000, "No more transcript segments"); }
      },
      sendBinary: (b) => { if (closed) return; c.sentBytes += b.length; pump(); if (!Array.isArray(script) && "dropAt" in script && (c.sentBytes / 2 / RATE) * 1000 >= script.dropAt) close(script.code, "Internal error"); },
      close: () => close(1000, "")
    };
  };
  return { factory, conns };
}

// One spoken turn as the endpoint reports it: start, cumulative partials word by word, end, and the completed text 800 ms after speech ends.
function turn(id: number, startMs: number, endMs: number, words: string, final = words): Scripted[] {
  const ws = words.split(" ");
  const step = (endMs - startMs) / ws.length;
  return [
    { at_ms: startMs + 100, ev: { type: "speechStart", turnId: id, audioProcessedMs: startMs } },
    ...ws.map((_, i) => ({ at_ms: startMs + step * (i + 1), ev: { type: "transcript", transcript: ws.slice(0, i + 1).join(" "), final: false, audioProcessedMs: startMs + step * (i + 1) } })),
    { at_ms: endMs + 800, ev: { type: "speechEnd", turnId: id, audioProcessedMs: endMs } },
    { at_ms: endMs + 800, ev: { type: "speechComplete", turnId: id, transcript: final, audioProcessedMs: endMs } }
  ];
}

async function boot(scripts: Parameters<typeof fakeMeta>[0], o: { gate?: (said: string) => ReturnType<typeof obs>; socket?: (f: SocketFactory) => SocketFactory; numberMs?: number; release?: boolean; holdMs?: number; heard?: string; levers?: boolean } = {}) {
  const root = emrRoot();
  const port = new FakeEmr();
  let rt: EmrRuntime | null = null;
  const seen: string[] = [];
  const meta = fakeMeta(scripts);
  const gate = o.gate ?? ((said: string) => (said.includes("37.6") ? obs(said, { temp_c: "37.6" }) : said.includes("116") ? obs(said, { pulse: 116 }) : [{ class: "aside" as const }]));
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater(gate, seen), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  const ear: SecondEar = async () => reading(o.heard ?? "temperature 37.6 pulse 116");
  const s = await startEmrServe({
    storeRoot: root, port, client, listenPort: 0, runtime: { holdMs: o.holdMs ?? 0, proofRetryMs: 1, ...(o.levers ? { speed: leversFrom(KEPT_LEVERS) } : {}) }, preferences: false, ears: ear, asr: "meta-stream", ...(o.release ? { releaseWhole: true } : {}),
    realtimeSocket: o.socket ? o.socket(meta.factory) : meta.factory, realtimeKey: () => "k-test",
    transcribe: async () => { throw new Error("the chunk ear is not used on the frames route"); },
    listen: { numberJoinWaitMs: o.numberMs ?? 5000, strongJoinWaitMs: 5000 }
  });
  rt = s.runtime;
  const stream = async (body: Buffer, session = "ms1", splitMs = 0) => {
    // With splitMs the body arrives in two parts a second and a half apart, as a congested upload would deliver it.
    const at = Math.round((splitMs * RATE) / 1000) * 2;
    const payload = splitMs ? new ReadableStream<Uint8Array>({ async start(c) { c.enqueue(new Uint8Array(body.subarray(0, at))); await new Promise((r) => setTimeout(r, 1500)); c.enqueue(new Uint8Array(body.subarray(at))); c.close(); } }) : new Uint8Array(body);
    const r = await fetch(`${s.url}/tasks/listen/stream?owner=${OWNER}&admissionId=${ADM}&session_id=${session}&rate=${RATE}`, { method: "POST", headers: { "content-type": "audio/pcm", origin: STRIP }, body: payload, ...(splitMs ? { duplex: "half" } : {}) } as RequestInit);
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const ledger = () => readdirSync(join(root, "ledger")).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readStream(root, `ledger/${f.replace(/\.jsonl$/, "")}`)).filter((e) => e.record_type === "reading.call").map((e) => e.payload as Record<string, any>);
  return { s, port, root, seen, meta, stream, ledger };
}

describe("the Meta realtime switch", () => {
  it("is off unless set, and names itself only for meta-stream", () => {
    expect(asrSwitch(undefined)).toBe("rest");
    expect(asrSwitch("meta-stream")).toBe("meta-stream");
    expect(asrSwitch("Meta-Stream ")).toBe("meta-stream");
    expect(asrSwitch("meta")).toBe("rest");
  });

  it("stops the service when the realtime ear cannot connect, with no fallback to another ear", async () => {
    const { factory } = fakeMeta([{ refuse: 1008 }]);
    await expect(startEmrServe({ storeRoot: emrRoot(), port: new FakeEmr(), listenPort: 0, preferences: false, asr: "meta-stream", realtimeSocket: factory, realtimeKey: () => "k-test" }))
      .rejects.toThrow(/Meta realtime ear was switched on but could not connect/);
  });
});

describe("the Meta realtime first ear", () => {
  it("opens an ENDPOINTING session with the hints, sends 16 kHz PCM, and feeds the completed turns to the gate", async () => {
    const { s, port, seen, meta, stream } = await boot([[], [...turn(0, 400, 1900, "Chart his temperature 37.6."), ...turn(1, 2800, 4600, "Chart his pulse 116.")]]);
    const r = await stream(pcm([["quiet", 400], ["tone", 1500], ["quiet", 900], ["tone", 1800], ["quiet", 1500]]));
    expect(r.status).toBe(202);
    await s.runtime.settled();
    // The first connection is the start-up check; the stream opens the second.
    expect(meta.conns).toHaveLength(2);
    const h = meta.conns[1]!.handshake!;
    expect(h).toMatchObject({ authorization: { accessToken: "Bearer k-test" }, audioEncoding: "PCM_16KHZ", model: "muse-voice-transcribe-1.0", mode: "ENDPOINTING", partialMode: "CUMULATIVE", emitAudioProgress: false });
    expect(h["keywords"]).toEqual(expect.arrayContaining(["temperature", "pulse"]));
    expect(h).not.toHaveProperty("languageBias");
    expect(meta.conns[1]!.sentBytes).toBe(pcm([["quiet", 400], ["tone", 1500], ["quiet", 900], ["tone", 1800], ["quiet", 1500]]).length);
    expect(seen).toEqual(["Chart his temperature 37.6.", "Chart his pulse 116."]);
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, temp_c: "37.6" }, { admission_id: ADM, pulse: 116 }]);
    const health = (await (await fetch(`${s.url}/health`)).json()) as Record<string, any>;
    expect(health["ears"]["first_ear"]).toBe("meta:muse-voice-transcribe-1.0:realtime");
    await s.close();
  });

  it("joins a number split across a final and the next turn, deciding on the next turn's partial words", async () => {
    // The endpoint ends a turn after "thirty seven"; the next turn's first partial "point six" carries the number on, so nothing is released early.
    const { s, port, seen, stream } = await boot([[], [...turn(0, 400, 1900, "Chart his temperature thirty seven"), ...turn(1, 2700, 3300, "point six")]]);
    expect((await stream(pcm([["quiet", 400], ["tone", 1500], ["quiet", 800], ["tone", 600], ["quiet", 1500]]))).status).toBe(202);
    await s.runtime.settled();
    expect(seen).toEqual(["Chart his temperature 37.6"]);
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, temp_c: "37.6" }]);
    expect(s.runtime.views(OWNER)[0]!.transcript.map((l) => l.ambient?.finished_by)).toEqual(["joined_across_cut"]);
    await s.close();
  });

  it("lets a finished number go as soon as the next turn's partial words do not carry it on", async () => {
    const { s, seen, stream } = await boot([[], [...turn(0, 400, 1900, "Chart his pulse one hundred and sixteen"), ...turn(1, 2700, 4300, "Emeka hand me the gloves")]], { numberMs: 60_000 });
    const t0 = Date.now();
    expect((await stream(pcm([["quiet", 400], ["tone", 1500], ["quiet", 800], ["tone", 1600], ["quiet", 1500]]))).status).toBe(202);
    await s.runtime.settled();
    // Released by the partial, not by the 60 s number wait.
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(seen).toEqual(["Chart his pulse 116", "Emeka hand me the gloves"]);
    expect(s.runtime.views(OWNER)[0]!.transcript.map((l) => l.ambient?.finished_by)).toEqual(["number_alone", "quiet_tail"]);
    await s.close();
  });

  it("joins a line the endpoint closed mid-sentence, where a value must still follow", async () => {
    const { s, port, seen, stream } = await boot([[], [...turn(0, 400, 1600, "the temperature is about"), ...turn(1, 2500, 3900, "thirty seven point six")]]);
    expect((await stream(pcm([["quiet", 400], ["tone", 1200], ["quiet", 900], ["tone", 1400], ["quiet", 1500]]))).status).toBe(202);
    await s.runtime.settled();
    expect(seen).toEqual(["the temperature is about 37.6"]);
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, temp_c: "37.6" }]);
    await s.close();
  });

  it("keeps one ledger row per completed turn with model, purpose, latency and cost, and bills the audio after the last turn too", async () => {
    const { s, stream, ledger } = await boot([[], [...turn(0, 400, 1900, "Chart his temperature 37.6."), ...turn(1, 2800, 4600, "Emeka hand me the gloves")]]);
    expect((await stream(pcm([["quiet", 400], ["tone", 1500], ["quiet", 900], ["tone", 1800], ["quiet", 1500]]))).status).toBe(202);
    await s.runtime.settled();
    const rows = ledger().filter((r) => r["model"] === "meta:muse-voice-transcribe-1.0:realtime");
    expect(rows.map((r) => [r["provider"], r["purpose"]])).toEqual([["meta", "interpret_speech"], ["meta", "interpret_speech"], ["meta", "interpret_speech"]]);
    // A line that waits on the number join is delivered later, so only the line delivered at once names its line here.
    expect(rows.filter((r) => r["line_id"]).length).toBe(1);
    expect(rows.every((r) => typeof r["latency_ms"] === "number" && r["latency_ms"] >= 0)).toBe(true);
    // 6.1 s of audio at $0.18 an hour, split across the rows.
    expect(rows.reduce((n, r) => n + r["cost_usd"], 0)).toBeCloseTo((6.1 / 3600) * 0.18, 6);
    await s.close();
  });

  it("answers 502 when the endpoint refuses the stream mid-way, and writes nothing it did not hear", async () => {
    const { s, port, stream } = await boot([[], { dropAt: 1000, code: 1008, events: [] }]);
    const r = await stream(pcm([["quiet", 400], ["tone", 1500], ["quiet", 900]]));
    expect(r.status).toBe(502);
    expect(r.body["error"]).toMatch(/realtime ear refused the stream/);
    await s.runtime.settled();
    expect(port.writes).toEqual([]);
    await s.close();
  });

  it("with D17 on, a continuation that arrives before the released pulse is written replaces it, so the record holds one entry", async () => {
    const gate = (said: string) => { const m = /pulse (\d+)/.exec(said); return m ? obs(said, { pulse: Number(m[1]) }) : [{ class: "aside" as const }]; };
    const { s, port, stream } = await boot([[], [...turn(0, 400, 1900, "Chart his pulse eighty"), ...turn(1, 2700, 3100, "two")]], { gate, release: true, holdMs: 4000, heard: "pulse 80 pulse 82" });
    // The whole body arrives at once here, so the next turn is heard before the first write; the sandbox run covers the write-then-amend order.
    expect((await stream(pcm([["quiet", 400], ["tone", 1500], ["quiet", 800], ["tone", 400], ["quiet", 1500]]))).status).toBe(202);
    await s.runtime.settled();
    const v = s.runtime.views(OWNER)[0]!;
    expect(v.transcript.map((l) => [l.text, l.ambient?.finished_by])).toEqual([["Chart his pulse 80", "released_whole"], ["Chart his pulse 82", "released_whole"]]);
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 82 }]);
    expect(v.actions.map((a) => a.state)).toEqual(["cancelled", "completed"]);
    await s.close();
  });

  it("with D17 and the serve's kept levers, settles three turns of pulse, temperature and pulse", async () => {
    const { s, port, stream } = await boot([[], [...turn(0, 400, 1900, "Chart his pulse 116."), ...turn(1, 4400, 5900, "Chart his temperature 37.6."), ...turn(2, 8400, 9900, "Chart his pulse 112.")]], { release: true, holdMs: 4000, levers: true, heard: "pulse 116 temperature 37.6 pulse 112", gate: (said) => { const p = /pulse (\d+)/.exec(said); return p ? obs(said, { pulse: Number(p[1]) }) : said.includes("37.6") ? obs(said, { temp_c: "37.6" }) : [{ class: "aside" as const }]; } });
    expect((await stream(pcm([["quiet", 400], ["tone", 1500], ["quiet", 2500], ["tone", 1500], ["quiet", 2500], ["tone", 1500], ["quiet", 2500]]), "ms1", 7000)).status).toBe(202);
    await s.runtime.settled(20_000);
    // D17 writes a released pulse at once and holds the temperature, so the later pulse can land before the earlier temperature; each value is written once, in whichever order.
    const key = (x: Record<string, unknown>) => JSON.stringify(x);
    expect(port.writes.map((w) => key(w.args)).sort()).toEqual([{ admission_id: ADM, pulse: 116 }, { admission_id: ADM, temp_c: "37.6" }, { admission_id: ADM, pulse: 112 }].map(key).sort());
    // The two pulses went out released and the temperature waited for its hold.
    const v = s.runtime.views(OWNER)[0]!;
    const released = (arg: string) => v.speed.rows.find((r) => r.action_id === v.actions.find((x) => arg in x.args)!.action_id)?.released ?? false;
    expect([released("pulse"), released("temp_c")]).toEqual([true, false]);
    expect(v.speed.rows.filter((r) => r.released)).toHaveLength(2);
    await s.close();
  }, 40_000);

  it("sends the language hint only when switched on", async () => {
    const meta = fakeMeta([[], []]);
    const s = await startEmrServe({ storeRoot: emrRoot(), port: new FakeEmr(), listenPort: 0, preferences: false, asr: "meta-stream", realtimeSocket: meta.factory, realtimeKey: () => "k-test", languageBias: ["English"] });
    expect(meta.conns[0]!.handshake!["languageBias"]).toEqual(["English"]);
    await s.close();
  });
});

describe("a kept realtime run", () => {
  it("replays from its events with no audio kept and no network, and refuses audio that differs", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "hp-rt-")), "realtime.jsonl");
    const script = [[], [...turn(0, 400, 1900, "Chart his temperature 37.6.")]] as Parameters<typeof fakeMeta>[0];
    const body = pcm([["quiet", 400], ["tone", 1500], ["quiet", 1500]]);
    const live = await boot(script, { socket: (f) => recordingSocket(f, file) });
    expect((await live.stream(body)).status).toBe(202);
    await live.s.runtime.settled();
    await live.s.close();
    const kept = readdirSync(join(file, "..")).join(",");
    expect(kept).toBe("realtime.jsonl");
    // The replay never reaches the scripted endpoint: an empty script would hear nothing.
    const again = await boot([], { socket: () => replaySocket(file) });
    expect((await again.stream(body)).status).toBe(202);
    await again.s.runtime.settled();
    expect(again.seen).toEqual(live.seen);
    expect(again.port.writes.map((w) => w.args)).toEqual(live.port.writes.map((w) => w.args));
    await again.s.close();
    const other = await boot([], { socket: () => replaySocket(file) });
    const r = await other.stream(pcm([["quiet", 400], ["tone", 1400], ["quiet", 1600]]));
    expect(r).toMatchObject({ status: 502, body: { error: expect.stringMatching(/refused the stream \(audio differs from the kept run\)/) } });
    await other.s.close();
  });
});

// A stand-in for the listen chain, so the session rules are tested on their own.
function chain() {
  const segments: string[] = [];
  const bySession: string[] = [];
  const partials: string[] = [];
  const l = {
    hintsFor: async () => ["pulse"], nextWords: (_s: string, p: string) => { partials.push(p); }, segment: async (c: { raw: string; session_id: string }) => { segments.push(c.raw); bySession.push(`${c.session_id}: ${c.raw}`); return []; },
    flush: async () => undefined, unreportedOf: () => ({ utterances: [], errors: [] })
  } as unknown as ListenSessions;
  return { l, segments, bySession, partials };
}
const quiet = (ms: number) => new Float32Array((RATE * ms) / 1000);
const tone = (ms: number) => { const x = new Float32Array((RATE * ms) / 1000); for (let k = 0; k < x.length; k++) x[k] = 0.3 * Math.sin((2 * Math.PI * 220 * k) / RATE); return x; };
// Feeds speech and quiet in 50 ms blocks with the given clock moving as the audio does, as a live microphone would.
async function play(m: MetaStreamListener, sid: string, clock: { now: number }, parts: [kind: "tone" | "quiet", ms: number][]) {
  for (const [kind, ms] of parts) for (let t = 0; t < ms; t += 50) { clock.now += 50; m.feed(sid, kind === "tone" ? tone(50) : quiet(50)); await new Promise((r) => setImmediate(r)); }
}
// Meta's rule on pacing: a connection whose audio falls a second behind the clock is closed with 1008 "Ingress below real-time".
function ingressRule(inner: SocketFactory): SocketFactory {
  return (url, on) => {
    let opened = 0, sent = 0, dead = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const die = (code: number, reason: string) => { if (dead) return; dead = true; if (timer) clearInterval(timer); on.close(code, reason); };
    const sock = inner(url, {
      ...on,
      text: (t) => {
        if (dead) return;
        if (!opened && (JSON.parse(t) as Record<string, unknown>)["sessionId"] && !("type" in (JSON.parse(t) as object))) {
          opened = Date.now();
          timer = setInterval(() => { if (Date.now() - opened - (sent / 2 / RATE) * 1000 > 1000) { on.text(JSON.stringify({ type: "error", message: "Ingress below real-time", sessionId: "" })); die(1008, "Ingress below real-time"); } }, 50);
        }
        on.text(t);
      },
      close: (code, reason) => die(code, reason)
    });
    return { ...sock, sendBinary: (b) => { if (!dead) { sent += b.length; sock.sendBinary(b); } } };
  };
}

describe("the realtime session rules", () => {
  it("rolls over before the limit with an overlap, joining at a quiet point, so a line both sessions heard is delivered once and none is lost", async () => {
    const clock = { now: 0 };
    const meta = fakeMeta([
      [...turn(0, 100, 600, "pulse 116"), ...turn(1, 1200, 1700, "pulse 120")],
      // The next session opens at about 1 s of audio and its positions count from there: it hears pulse 120 as well, then pulse 98 after the join.
      [...turn(0, 150, 650, "pulse 120"), ...turn(1, 1950, 2450, "pulse 98")]
    ]);
    const { l, segments } = chain();
    const opts = { key: () => "k", socket: meta.factory, now: () => clock.now, rollAtMs: 1000, overlapMs: 10_000, joinQuietMs: 400, padAfterMs: 0 };
    const m = new MetaStreamListener(l, opts);
    await m.open({ owner: OWNER, target: { admission_id: ADM }, session_id: "roll", rate: RATE });
    await play(m, "roll", clock, [["quiet", 100], ["tone", 500], ["quiet", 600]]);
    // One roll-over is under test: the session that takes over is not rolled again here.
    opts.rollAtMs = 1e9;
    await play(m, "roll", clock, [["tone", 500], ["quiet", 1300], ["tone", 500], ["quiet", 1500]]);
    await m.end("roll");
    expect(meta.conns).toHaveLength(2);
    // The old session was ended with endStream and drained, never dropped.
    expect(meta.conns[0]!.ended).toBe(true);
    expect(segments).toEqual(["pulse 116", "pulse 120", "pulse 98"]);
  });

  it("forces the join after the overlap, and a line said straight through it is delivered once, whole, by the session that began it", async () => {
    const clock = { now: 0 };
    const meta = fakeMeta([
      [...turn(0, 800, 2400, "pulse one hundred and sixteen respiratory rate twenty")],
      [...turn(0, 0, 1350, "rate twenty"), ...turn(1, 2000, 2400, "pulse 98")]
    ]);
    const { l, segments } = chain();
    const opts = { key: () => "k", socket: meta.factory, now: () => clock.now, rollAtMs: 1000, overlapMs: 300, joinQuietMs: 400, padAfterMs: 0 };
    const m = new MetaStreamListener(l, opts);
    await m.open({ owner: OWNER, target: { admission_id: ADM }, session_id: "force", rate: RATE });
    await play(m, "force", clock, [["quiet", 800], ["tone", 400]]);
    opts.rollAtMs = 1e9;
    await play(m, "force", clock, [["tone", 1200], ["quiet", 600], ["tone", 500], ["quiet", 1500]]);
    await m.end("force");
    expect(meta.conns).toHaveLength(2);
    expect(meta.conns[0]!.ended).toBe(true);
    expect(segments).toEqual(["pulse one hundred and sixteen respiratory rate twenty", "pulse 98"]);
  });

  it("opens a session with the new patient's hints on a patient change, keeps the line being said with the patient it began on, and never delivers it twice", async () => {
    const clock = { now: 0 };
    const meta = fakeMeta([
      [...turn(0, 100, 600, "pulse 116"), ...turn(1, 1000, 1800, "and his respiratory rate is 20")],
      // The new patient's session hears from the change at 1.2 s: the end of that line, then a line of its own.
      [...turn(0, 0, 600, "rate is 20"), ...turn(1, 1300, 1800, "pulse 98")]
    ]);
    const { l, bySession } = chain();
    const m = new MetaStreamListener(l, { key: () => "k", socket: meta.factory, now: () => clock.now, padAfterMs: 0 });
    await m.open({ owner: OWNER, target: { admission_id: ADM }, session_id: "pc", rate: RATE });
    await play(m, "pc", clock, [["quiet", 100], ["tone", 500], ["quiet", 400], ["tone", 200]]);
    await m.retarget("pc", { target: { patient_id: "99999999-8888-4777-8666-555555555555" }, listen_sid: "pc.1" });
    await play(m, "pc", clock, [["tone", 600], ["quiet", 700], ["tone", 500], ["quiet", 1500]]);
    await m.end("pc");
    expect(meta.conns).toHaveLength(2);
    expect(meta.conns[0]!.ended).toBe(true);
    expect(bySession).toEqual(["pc: pulse 116", "pc: and his respiratory rate is 20", "pc.1: pulse 98"]);
  });

  it("pads a sender that pauses for 3 s with silence, so the endpoint never refuses it for ingress below real time", async () => {
    const meta = fakeMeta([[...turn(0, 0, 500, "pulse 116")]]);
    const { l, segments } = chain();
    const m = new MetaStreamListener(l, { key: () => "k", socket: ingressRule(meta.factory) });
    await m.open({ owner: OWNER, target: { admission_id: ADM }, session_id: "pad", rate: RATE });
    m.feed("pad", tone(500));
    m.feed("pad", quiet(900));
    await new Promise((r) => setTimeout(r, 3000));
    m.feed("pad", quiet(500));
    const r = await m.end("pad");
    expect(r.failed).toBeNull();
    expect(r.padded_ms).toBeGreaterThan(1000);
    expect(segments).toEqual(["pulse 116"]);
  }, 10_000);

  it("without padding, the same 3 s pause is refused, which is the failure padding prevents", async () => {
    const meta = fakeMeta([[...turn(0, 0, 500, "pulse 116")]]);
    const { l } = chain();
    const m = new MetaStreamListener(l, { key: () => "k", socket: ingressRule(meta.factory), padAfterMs: 0 });
    await m.open({ owner: OWNER, target: { admission_id: ADM }, session_id: "nopad", rate: RATE });
    m.feed("nopad", tone(500));
    m.feed("nopad", quiet(900));
    await new Promise((r) => setTimeout(r, 3000));
    expect(() => m.feed("nopad", quiet(500))).toThrow(/Ingress below real-time/);
    expect((await m.end("nopad")).failed).toMatch(/Ingress below real-time/);
  }, 10_000);

  it("opens the session again after a dropped connection and sends the line it was cut in again, so its words are not lost", async () => {
    let now = 0;
    // The second session hears the resent audio from the start of the cut line, so its positions count from there.
    const meta = fakeMeta([{ dropAt: 500, code: 1011, events: [{ at_ms: 300, ev: { type: "speechStart", turnId: 0, audioProcessedMs: 200 } }] }, [...turn(0, 100, 400, "pulse 116")]]);
    const { l, segments } = chain();
    const m = new MetaStreamListener(l, { key: () => "k", socket: meta.factory, now: () => now, reconnectDelayMs: 1, padAfterMs: 0 });
    await m.open({ owner: OWNER, target: { admission_id: ADM }, session_id: "drop", rate: RATE });
    for (let i = 0; i < 12; i++) { now += 50; m.feed("drop", quiet(50)); await new Promise((r) => setTimeout(r, 2)); }
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 30; i++) { now += 50; m.feed("drop", quiet(50)); await new Promise((r) => setImmediate(r)); }
    const r = await m.end("drop");
    expect(meta.conns).toHaveLength(2);
    expect(segments).toEqual(["pulse 116"]);
    expect(r.errors.join(" ")).toMatch(/dropped \(1011\) and was opened again; \d+ ms sent again, from the start of the line it was cut in/);
    expect(r.resent_ms).toBeGreaterThan(400);
  });

  it("hands each partial to the number join as it is said, before the turn completes", async () => {
    let now = 0;
    const meta = fakeMeta([[...turn(0, 100, 900, "pulse one hundred and sixteen"), ...turn(1, 1200, 2400, "Emeka hand me the gloves")]]);
    const { l, segments, partials } = chain();
    const m = new MetaStreamListener(l, { key: () => "k", socket: meta.factory, now: () => now });
    await m.open({ owner: OWNER, target: { admission_id: ADM }, session_id: "pt", rate: RATE });
    for (let i = 0; i < 36; i++) { now += 50; m.feed("pt", quiet(50)); await new Promise((r) => setImmediate(r)); }
    await m.drain("pt");
    // At 1.8 s the second turn has said two words and is not complete, and the join has seen each partial.
    expect(segments).toEqual(["pulse one hundred and sixteen"]);
    expect(partials.slice(-2)).toEqual(["Emeka", "Emeka hand"]);
    await m.end("pt");
    expect(segments).toEqual(["pulse one hundred and sixteen", "Emeka hand me the gloves"]);
  });

  it("fails the stream at once when the endpoint refuses it mid-way, and never reconnects a refusal", async () => {
    let now = 0;
    const meta = fakeMeta([{ dropAt: 500, code: 1008, events: [] }, []]);
    const { l } = chain();
    const m = new MetaStreamListener(l, { key: () => "k", socket: meta.factory, now: () => now, reconnectDelayMs: 1 });
    await m.open({ owner: OWNER, target: { admission_id: ADM }, session_id: "ref", rate: RATE });
    for (let i = 0; i < 10; i++) { now += 50; m.feed("ref", quiet(50)); await new Promise((r) => setTimeout(r, 2)); }
    await new Promise((r) => setTimeout(r, 20));
    expect(() => m.feed("ref", quiet(50))).toThrow(/refused the stream/);
    expect(meta.conns).toHaveLength(1);
    expect((await m.end("ref")).failed).toMatch(/refused the stream/);
  });

  it("with replay refusal on, refuses frames sent faster than they could be spoken", async () => {
    const meta = fakeMeta([[]]);
    const { l } = chain();
    const m = new MetaStreamListener(l, { key: () => "k", socket: meta.factory, now: () => 0, refuseFasterThanLive: true });
    await m.open({ owner: OWNER, target: { admission_id: ADM }, session_id: "fast", rate: RATE });
    expect(() => m.feed("fast", quiet(5000))).toThrow(/faster_than_live/);
  });
});

describe.skipIf(process.env["META_LIVE"] !== "1")("the real realtime endpoint", () => {
  it("hears a synthetic vitals line sent at the pace it is spoken, through the frames route to the record", async () => {
    const { execFileSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const { decodeWav } = await import("@hey-pisgah/voice");
    const dir = mkdtempSync(join(tmpdir(), "hp-rt-live-"));
    execFileSync("say", ["-o", join(dir, "l.wav"), "--file-format=WAVE", `--data-format=LEI16@${RATE}`, "Chart his pulse one hundred and sixteen. [[slnc 900]]"]);
    const x = decodeWav(new Uint8Array(readFileSync(join(dir, "l.wav")))).samples;
    const root = emrRoot();
    const port = new FakeEmr();
    let rt: EmrRuntime | null = null;
    const seen: string[] = [];
    const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater((said) => (said.includes("116") ? obs(said, { pulse: 116 }) : [{ class: "aside" }]), seen), taskStateOf: (id) => rt?.stateOf(id) ?? null });
    const s = await startEmrServe({ storeRoot: root, port, client, listenPort: 0, runtime: { holdMs: 0, proofRetryMs: 1 }, preferences: false, ears: async () => reading("pulse 116"), asr: "meta-stream" });
    rt = s.runtime;
    const frame = (RATE * 20) / 1000;
    const all = new Float32Array(x.length + RATE * 2);
    all.set(x, RATE / 2);
    let i = 0;
    const t0 = Date.now();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (i >= all.length) { c.close(); return; }
        const due = t0 + (i / RATE) * 1000;
        if (due > Date.now()) await new Promise((r) => setTimeout(r, due - Date.now()));
        const part = all.subarray(i, i + frame);
        i += frame;
        const b = Buffer.alloc(part.length * 2);
        part.forEach((v, k) => b.writeInt16LE(Math.round(v * 32767), k * 2));
        c.enqueue(new Uint8Array(b));
      }
    });
    const r = await fetch(`${s.url}/tasks/listen/stream?owner=${OWNER}&admissionId=${ADM}&session_id=live1&rate=${RATE}`, { method: "POST", headers: { "content-type": "audio/pcm", origin: STRIP }, body, duplex: "half" } as RequestInit);
    expect(r.status).toBe(202);
    await s.runtime.settled();
    expect(seen.join(" ")).toMatch(/116/);
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 116 }]);
    const rows = readdirSync(join(root, "ledger")).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readStream(root, `ledger/${f.replace(/\.jsonl$/, "")}`)).filter((e) => e.record_type === "reading.call").map((e) => e.payload as Record<string, any>);
    expect(rows.some((x) => x["model"] === "meta:muse-voice-transcribe-1.0:realtime" && x["purpose"] === "interpret_speech" && x["cost_usd"] > 0)).toBe(true);
    await s.close();
  }, 60_000);
});
