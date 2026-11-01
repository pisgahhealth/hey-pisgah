import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav, type FinalTranscript } from "@hey-pisgah/voice";
import type { ListenSessions, StreamSegment } from "../src/emr/listen.js";
import { localDirs, parakeetEar, sherpaStreamAsr, type StreamAsr, type StreamDecoder } from "../src/emr/local-ears.js";
import { matchWindows, printLine, sherpaEmbedder } from "../src/emr/speaker.js";
import { percentile } from "../src/emr/runtime.js";
import { StreamListener } from "../src/emr/stream-listen.js";
import { ModelPool, earWorkers } from "../src/emr/workers/pool.js";

const RATE = 16_000;
const encodeWavOf = (x: Float32Array) => encodeWav(x, RATE);
const PART = (RATE * 80) / 1000;
const digest = (x: Float32Array) => createHash("sha256").update(new Uint8Array(x.buffer, x.byteOffset, x.byteLength)).digest("hex").slice(0, 16);

// What the listen rules were handed, per listening session: every stretch with its words, audio and quiet, and every partial in order.
type Heard = { segments: Record<string, { raw: string; samples: string; n: number; trailing_ms: number; arrived: number }[]>; partials: Record<string, string[]> };

// A stub of the listen rules that records what the streaming ear hands on.
function recorder(): { listen: ListenSessions; heard: Heard } {
  const heard: Heard = { segments: {}, partials: {} };
  const listen = {
    admit: () => ({ refused: null, presence: { live: null } }),
    segment: async (s: StreamSegment) => { (heard.segments[s.session_id] ??= []).push({ raw: s.raw, samples: digest(s.samples), n: s.samples.length, trailing_ms: s.trailing_ms, arrived: s.arrived }); return []; },
    nextWords: (sid: string, p: string) => { (heard.partials[sid] ??= []).push(p); },
    flush: async () => undefined,
    unreportedOf: () => ({ utterances: [], errors: [] })
  } as unknown as ListenSessions;
  return { listen, heard };
}

// Feeds each session's audio in 80 ms parts on a shared clock, interleaved across sessions, waiting for each part to be heard as a paced strip would.
async function hear(asr: StreamAsr, audio: Float32Array[], o: { interleave?: boolean } = {}): Promise<Heard & { errors: string[] }> {
  const { listen, heard } = recorder();
  const clock = { now: 1_000_000 };
  const sl = new StreamListener(listen, asr, { now: () => clock.now });
  audio.forEach((_, i) => sl.open({ owner: "o", target: { admission_id: `a${i}` }, session_id: `s${i}`, rate: RATE }));
  const longest = Math.max(...audio.map((x) => x.length));
  for (let at = 0; at < longest; at += PART) {
    clock.now += 80;
    for (const [i, x] of audio.entries()) {
      if (at >= x.length) continue;
      sl.feed(`s${i}`, x.subarray(at, at + PART), clock.now - 80);
      if (!o.interleave) await sl.drain(`s${i}`);
    }
    if (o.interleave) for (const i of audio.keys()) await sl.drain(`s${i}`);
  }
  const errors: string[] = [];
  for (const i of audio.keys()) errors.push(...(await sl.end(`s${i}`)).errors);
  return { ...heard, errors };
}

const tone = (ms: number, hz: number) => Float32Array.from({ length: (ms * RATE) / 1000 }, (_, k) => 0.3 * Math.sin((2 * Math.PI * hz * k) / RATE));
const quiet = (ms: number) => new Float32Array((ms * RATE) / 1000);
const join2 = (xs: Float32Array[]) => { const o = new Float32Array(xs.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of xs) { o.set(x, i); i += x.length; } return o; };

// A scripted decoder whose words grow with the loud audio it was given, so its partials and finals depend on every frame in order.
function scripted(lines: string[]): StreamAsr {
  let k = 0;
  return {
    model: "local:scripted",
    transcribe: async (_w, _k, sid): Promise<FinalTranscript> => ({ final: true, text: "", audio_ms: 0, session_id: sid, cost_usd: 0 }),
    open() {
      let loud = 0;
      const line = lines[k++ % lines.length]!;
      return {
        accept: (x) => { let s = 0; for (const v of x) s += v * v; if (Math.sqrt(s / x.length) >= 0.01) loud += x.length; },
        text: () => line.split(" ").slice(0, Math.ceil(loud / 3200)).join(" "),
        finish: () => (loud ? line : "")
      };
    }
  };
}
// The same decoder answering later, each answer after its own random delay, as a busy worker would.
function late(inner: StreamAsr, seed = 7): StreamAsr {
  let r = seed;
  const delay = () => { r = (r * 1103515245 + 12345) % 2 ** 31; return r % 6; };
  const wait = <T>(v: T) => new Promise<T>((ok) => setTimeout(() => ok(v), delay()));
  return { ...inner, open(): StreamDecoder { const d = inner.open(); return { accept: (x) => d.accept(x), text: () => wait(d.text() as string), finish: () => wait(d.finish() as string) }; } };
}

describe("the streaming ear with its decoder in another thread", () => {
  it("hands the listen rules the same stretches and partials when the decoder answers late and out of step", async () => {
    const audio = [join2([quiet(400), tone(900, 220), quiet(900), tone(1300, 330), quiet(1000)]), join2([quiet(200), tone(600, 440), quiet(800), tone(400, 250), quiet(200), tone(500, 260), quiet(900)])];
    const lines = ["chart his pulse one sixteen", "temperature thirty eight point three", "blood pressure one oh four over sixty two"];
    const now = await hear(scripted(lines), audio, { interleave: true });
    const later = await hear(late(scripted(lines)), audio, { interleave: true });
    expect(Object.values(now.segments).flat().length).toBe(4);
    expect(Object.values(now.partials).flat().length).toBeGreaterThan(4);
    expect(later).toEqual(now);
  });

  it("reads the worker count from HEY_PISGAH_EAR_WORKERS, 0 keeping every model in this thread", () => {
    expect(earWorkers("online", undefined, "0")).toBe(0);
    expect(earWorkers("speaker", undefined, "0")).toBe(0);
    expect(earWorkers("online", undefined, "6")).toBe(6);
    expect(earWorkers("offline", undefined, "6")).toBe(1);
    expect(earWorkers("online", 0, "6")).toBe(0);
    expect(earWorkers("online", undefined, undefined)).toBeGreaterThan(0);
  });
});

// Runs only with LOCAL_EARS=1, the models under HEY_PISGAH_ASR_DIR and the speaker model at HEY_PISGAH_SPEAKER_MODEL; synthetic speech, no network.
const MODELS = process.env["HEY_PISGAH_ASR_DIR"] ?? join(process.cwd(), ".hey-pisgah", "asr");
const SPEAKER = process.env["HEY_PISGAH_SPEAKER_MODEL"] ?? "";
describe.skipIf(process.env["LOCAL_EARS"] !== "1")("the real local models in worker threads", () => {
  const dir = mkdtempSync(join(tmpdir(), "hp-b4-"));
  const say = (text: string, voice: string, rate = 24_000) => {
    const f = join(dir, `${createHash("sha1").update(voice + text).digest("hex").slice(0, 8)}.wav`);
    execFileSync("say", ["-v", voice, "-o", f, "--file-format=WAVE", `--data-format=LEI16@${rate}`, `${text} [[slnc 900]]`], { stdio: "ignore" });
    return new Uint8Array(readFileSync(f));
  };
  const LINES: [string, string][] = [["Chart his pulse 116.", "Samantha"], ["Chart his temperature 38.3.", "Daniel"], ["Blood pressure 104 over 62.", "Karen"], ["Start paracetamol one gram by mouth.", "Samantha"]];

  it("hears the same words, stretches and partials, with the same Parakeet text and voiceprints, with and without workers", async () => {
    const dirs = localDirs(MODELS);
    expect(existsSync(dirs.streamDir) && existsSync(dirs.parakeetDir) && existsSync(SPEAKER)).toBe(true);
    const wavs = LINES.map(([t, v]) => say(t, v));
    const at16 = LINES.map(([t, v]) => say(t, v, RATE)).map((w) => decodeWav(w).samples);
    const streams = [join2([quiet(300), at16[0]!, quiet(1200), at16[1]!, quiet(1500)]), join2([quiet(500), at16[2]!, quiet(900), at16[3]!, quiet(1500)])];

    const one = sherpaStreamAsr({ modelDir: dirs.streamDir, workers: 0 })!;
    const many = sherpaStreamAsr({ modelDir: dirs.streamDir, workers: 2 })!;
    const base = await hear(one, streams);
    expect(Object.values(base.segments).flat().length).toBeGreaterThanOrEqual(4);
    expect(Object.values(base.segments).flat().map((s) => s.raw).join(" ").toLowerCase()).toContain("thirty eight point three");
    expect(await hear(many, streams)).toEqual(base);
    expect(await hear(many, streams, { interleave: true })).toEqual(await hear(one, streams, { interleave: true }));
    for (const w of wavs) expect((await many.transcribe(w, [], "s")).text).toBe((await one.transcribe(w, [], "s")).text);

    const meta = { run_id: "r", task_id: "t", line_id: "l" };
    const p1 = parakeetEar({ modelDir: dirs.parakeetDir, workers: 0 })!, pN = parakeetEar({ modelDir: dirs.parakeetDir, workers: 1 })!;
    const texts1 = await Promise.all(wavs.map((w) => p1(w, meta).then((r) => r.text)));
    expect(await Promise.all(wavs.map((w) => pN(w, meta).then((r) => r.text)))).toEqual(texts1);
    expect(texts1[0]).toContain("116");

    const e1 = sherpaEmbedder({ modelPath: SPEAKER, workers: 0 })!, eN = sherpaEmbedder({ modelPath: SPEAKER, workers: 2 })!;
    const v1 = await Promise.all(wavs.map((w) => e1(w).then((p) => p?.vector)));
    expect(v1.every((v) => v?.length === 192)).toBe(true);
    expect(await Promise.all(wavs.map((w) => eN(w).then((p) => p?.vector)))).toEqual(v1);
  }, 180_000);

  it("fails the decoders of a worker that stops, and starts a new worker that hears the same words", async () => {
    const d = localDirs(MODELS).streamDir;
    const files = { encoder: join(d, "encoder.onnx"), decoder: join(d, "decoder.onnx"), joiner: join(d, "joiner.onnx"), tokens: join(d, "tokens.txt") };
    const config = { featConfig: { sampleRate: 16_000, featureDim: 80 }, modelConfig: { transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner }, tokens: files.tokens, numThreads: 2, provider: "cpu", debug: 0 }, enableEndpoint: false };
    const pool = new ModelPool("online", { from: import.meta.url, config, flushSamples: 16_000 }, 1);
    const x = decodeWav(say("Chart his pulse 116.", "Samantha", RATE)).samples;
    const hearOnce = async () => { const { slot, s } = pool.stream(); pool.send(slot, { op: "open", s }); pool.send(slot, { op: "accept", s, x }); const t = await pool.ask<string>(slot, { op: "finish", s }); pool.release(slot); return t; };
    const before = await hearOnce();
    const { slot, s } = pool.stream();
    pool.send(slot, { op: "open", s });
    await pool.ask<string>(slot, { op: "text", s });
    // A worker that stops between two messages, as one ended by its memory limit would.
    await slot.w.terminate();
    await expect(pool.ask(slot, { op: "finish", s })).rejects.toThrow(/stopped/);
    expect(await hearOnce()).toBe(before);
    expect(before.toLowerCase()).toContain("sixteen");
    // Closing while a decode is under way lets it finish with its words instead of stopping the worker inside the model.
    const { slot: busy, s: s2 } = pool.stream();
    pool.send(busy, { op: "open", s: s2 });
    pool.send(busy, { op: "accept", s: s2, x });
    const last = pool.ask<string>(busy, { op: "finish", s: s2 });
    pool.close();
    expect(await last).toBe(before);
    await new Promise<void>((r) => busy.w.once("exit", () => r()));
    expect(pool.size()).toBe(0);
  }, 60_000);

  it("is null, as before, when a model folder or the speaker model is missing", () => {
    expect(sherpaStreamAsr({ modelDir: join(dir, "none"), workers: 2 })).toBeNull();
    expect(parakeetEar({ modelDir: join(dir, "none"), workers: 1 })).toBeNull();
    expect(sherpaEmbedder({ modelPath: join(dir, "none.onnx"), workers: 2 })).toBeNull();
    expect(sherpaStreamAsr({ modelDir: localDirs(MODELS).streamDir, sherpaDir: join(dir, "no-library"), workers: 2 })).toBeNull();
  });
});

// Runs only with EAR_LOAD=1 and the models as above: simulated owners speak synthetic lines at once, each in real time, through one serve's local ears.
describe.skipIf(process.env["EAR_LOAD"] !== "1")("many owners on one serve's local ears", () => {
  it("keeps the main loop responsive with the ears in workers, against the same load in one thread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hp-b4l-"));
    const voices = ["Samantha", "Daniel", "Karen", "Moira"];
    const texts = ["Chart his pulse 116.", "Temperature 38.3.", "Blood pressure 104 over 62.", "Respiratory rate 22.", "Start paracetamol one gram by mouth."];
    const clips = voices.flatMap((v, i) => texts.map((t, j) => {
      const f = join(dir, `c${i}-${j}.wav`);
      execFileSync("say", ["-v", v, "-o", f, "--file-format=WAVE", `--data-format=LEI16@${RATE}`, t], { stdio: "ignore" });
      return decodeWav(new Uint8Array(readFileSync(f))).samples;
    }));
    const owners = (process.env["EAR_LOAD_OWNERS"] ?? "10,30").split(",").map(Number);
    const seconds = Number(process.env["EAR_LOAD_SECONDS"] ?? "20");
    const configs = (process.env["EAR_LOAD_WORKERS"] ?? "0,3").split(",").map(Number);
    process.stdout.write(`load before ${loadavg().map((x) => x.toFixed(1)).join(" ")}\n`);
    const dirs = localDirs(MODELS);
    const rows: unknown[] = [];
    for (const workers of configs) {
      const asr = sherpaStreamAsr({ modelDir: dirs.streamDir, workers })!;
      const embed = sherpaEmbedder({ modelPath: SPEAKER, workers: workers ? 2 : 0 })!;
      const ear = parakeetEar({ modelDir: dirs.parakeetDir, workers: workers ? 1 : 0 })!;
      for (const n of owners) {
        // Each owner says a line, pauses 1.2 to 2.4 s, and says the next, from its own start.
        const audio = Array.from({ length: n }, (_, i) => {
          const xs: Float32Array[] = [quiet(80 * (i % 13))];
          let len = xs[0]!.length, k = i;
          while (len < seconds * RATE) { const c = clips[(k * 7 + i) % clips.length]!; xs.push(c, quiet(1200 + 100 * (k % 13))); len += c.length + ((1200 + 100 * (k % 13)) * RATE) / 1000; k++; }
          return join2(xs);
        });
        const words: number[] = [], embedMs: number[] = [], earMs: number[] = [], late: number[] = [];
        let segs = 0;
        const side: Promise<unknown>[] = [];
        const listen = {
          admit: () => ({ refused: null, presence: { live: null } }),
          // The work the listen rules start per line: the voiceprint on the main path and Parakeet as the second reading.
          segment: async (s: StreamSegment) => {
            segs++; words.push(s.trailing_ms);
            const t0 = performance.now();
            const wav = encodeWavOf(s.samples);
            side.push(printLine(embed, matchWindows([s.samples], RATE), RATE).then(() => embedMs.push(performance.now() - t0)));
            side.push(ear(wav, { run_id: "r", task_id: "t", line_id: "l" }).then(() => earMs.push(performance.now() - t0)));
            return [];
          },
          nextWords: () => undefined, flush: async () => undefined, unreportedOf: () => ({ utterances: [], errors: [] })
        } as unknown as ListenSessions;
        const sl = new StreamListener(listen, asr);
        audio.forEach((_, i) => sl.open({ owner: `o${i}`, target: { admission_id: `a${i}` }, session_id: `s${i}`, rate: RATE }));
        const h = monitorEventLoopDelay({ resolution: 10 });
        h.enable();
        const t0 = Date.now();
        const sent = audio.map(() => 0);
        // One 80 ms part per owner when its time comes, as the strips post them; a part sent late counts how far the loop fell behind.
        await new Promise<void>((done) => {
          const tick = setInterval(() => {
            const now = Date.now();
            let left = false;
            for (const [i, x] of audio.entries()) {
              while (sent[i]! < x.length && t0 + ((sent[i]! / RATE) * 1000) + 80 <= now) {
                late.push(now - (t0 + (sent[i]! / RATE) * 1000 + 80));
                sl.feed(`s${i}`, x.subarray(sent[i]!, sent[i]! + PART), t0 + (sent[i]! / RATE) * 1000);
                sent[i]! += PART;
              }
              if (sent[i]! < x.length) left = true;
            }
            if (!left) { clearInterval(tick); done(); }
          }, 10);
        });
        const errors: string[] = [];
        for (const i of audio.keys()) errors.push(...(await sl.end(`s${i}`)).errors);
        await Promise.all(side);
        h.disable();
        const ms = (v: number) => Math.round(v / 1e5) / 10;
        const st = (xs: number[]) => ({ p50: Math.round(percentile(xs, 50) ?? 0), p90: Math.round(percentile(xs, 90) ?? 0), max: Math.round(Math.max(0, ...xs)) });
        const row = { workers, owners: n, audio_s: seconds, wall_s: Math.round((Date.now() - t0) / 100) / 10, stretches: segs, errors: errors.length, loop_delay_ms: { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max) }, part_late_ms: st(late), words_after_speech_ms: st(words), voiceprint_ms: st(embedMs), parakeet_ms: st(earMs), load: loadavg()[0] };
        rows.push(row);
        process.stdout.write(`${JSON.stringify(row)}\n`);
        expect(errors).toEqual([]);
      }
    }
    const file = process.env["EAR_LOAD_OUT"];
    if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), cpus: availableParallelism(), rows }, null, 1)}\n`); }
  }, 30 * 60_000);
});
