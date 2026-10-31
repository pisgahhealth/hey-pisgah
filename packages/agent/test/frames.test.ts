import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import { decodeWav, encodeWav, resample, type FinalTranscript } from "@hey-pisgah/voice";
import { Timeline as TimelineSchema, talkChunks } from "@hey-pisgah/evaluator";
import type { StreamAsr } from "../src/emr/local-ears.js";
import { replayTranscriber } from "../src/emr/listen.js";
import type { EmrRuntime } from "../src/emr/runtime.js";
import { startEmrServe } from "../src/emr/serve.js";
import { ADM, FakeEmr, OWNER, emrRoot, gater, until } from "./emr-helpers.js";
import { obs } from "./mic-helpers.js";

const RATE = 16_000;
const ADM2 = "22222222-3333-4444-8555-666666666666";
const pcm = (parts: [kind: "tone" | "quiet", ms: number][]): Buffer => {
  const n = parts.reduce((s, [, ms]) => s + (ms * RATE) / 1000, 0);
  const b = Buffer.alloc(n * 2);
  let i = 0;
  for (const [kind, ms] of parts) for (let k = 0; k < (ms * RATE) / 1000; k++, i++) b.writeInt16LE(kind === "tone" ? Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 220 * k) / RATE)) : 0, i * 2);
  return b;
};
const toPcm = (x: Float32Array): Buffer => { const b = Buffer.alloc(x.length * 2); for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32767))), i * 2); return b; };

// A streaming recogniser as a script: each stretch of speech is the next line.
function scriptedStream(lines: string[]): StreamAsr {
  let k = 0;
  return {
    model: "local:scripted-stream",
    transcribe: async (_w, _k, sid): Promise<FinalTranscript> => ({ final: true, text: "", audio_ms: 0, session_id: sid, cost_usd: 0 }),
    open() {
      let loud = 0;
      return {
        accept: (x) => { let s = 0; for (const v of x) s += v * v; if (Math.sqrt(s / x.length) >= 0.01) loud += x.length; },
        text: () => (loud ? lines[k]!.split(" ").slice(0, Math.ceil(loud / 3200)).join(" ") : ""),
        finish: () => (loud ? lines[k++] ?? "" : "")
      };
    }
  };
}

// The vitals a line names, as the gate would read them; anything else is an aside.
const vitalsGate = (said: string) => {
  const v: Record<string, unknown> = {};
  const t = /temperature (\d+\.\d)/i.exec(said); if (t) v["temp_c"] = t[1];
  const p = /pulse (\d+)/i.exec(said); if (p) v["pulse"] = Number(p[1]);
  const r = /respiratory rate (\d+)/i.exec(said); if (r) v["resp_rate"] = Number(r[1]);
  return Object.keys(v).length ? obs(said, v) : [{ class: "aside" as const }];
};

async function boot(o: { asr: "stream" | "rest"; lines?: string[]; transcribe?: Parameters<typeof startEmrServe>[0]["transcribe"]; idleMs?: number }) {
  const root = emrRoot();
  const port = new FakeEmr();
  let rt: EmrRuntime | null = null;
  const seen: string[] = [];
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater(vitalsGate, seen), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  const s = await startEmrServe({
    storeRoot: root, port, client, listenPort: 0, runtime: { holdMs: 0, proofRetryMs: 1 }, preferences: false, ears: "off",
    ...(o.asr === "stream" ? { asr: "stream" as const, streamAsr: scriptedStream(o.lines ?? []) } : {}),
    transcribe: o.transcribe ?? (async () => { throw new Error("the chunk ear is not used on the frames route"); }),
    listen: { numberJoinWaitMs: 300, strongJoinWaitMs: 300 }, ...(o.idleMs ? { framesIdleMs: o.idleMs } : {})
  });
  rt = s.runtime;
  // One numbered part of a frames stream, as the strip posts it.
  const part = async (q: { stream?: number; part: number; last?: boolean; session?: string; admissionId?: string | null; rate?: number; t?: number }, body: Buffer) => {
    const page = q.admissionId === null ? "" : `&admissionId=${q.admissionId ?? ADM}`;
    const r = await fetch(`${s.url}/tasks/listen/stream?owner=${OWNER}&session_id=${q.session ?? "strip-1"}&rate=${q.rate ?? RATE}&stream=${q.stream ?? 0}&part=${q.part}${q.last ? "&last=1" : ""}${q.t ? `&t=${q.t}` : ""}${page}`, { method: "POST", headers: { "content-type": "audio/pcm" }, body: new Uint8Array(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  // A whole recording as parts of 80 ms frames, the last part closing the stream.
  const frames = async (body: Buffer, o2: { stream?: number; session?: string; perPart?: number; admissionId?: string | null; rate?: number } = {}) => {
    const rate = o2.rate ?? RATE;
    const size = ((rate * 80) / 1000) * 2 * (o2.perPart ?? 1);
    const answers: Record<string, any>[] = [];
    let n = 0;
    for (let at = 0; at < body.length; at += size, n++) answers.push((await part({ ...o2, part: n, last: at + size >= body.length }, body.subarray(at, at + size))).body);
    return answers;
  };
  return { s, port, root, seen, part, frames };
}

describe("the strip's frames route", () => {
  it("is named in /health only when a streaming ear is on, so a chunk-only serve keeps the strip on chunks", async () => {
    const on = await boot({ asr: "stream" });
    expect(((await (await fetch(`${on.s.url}/health`)).json()) as Record<string, any>)["ears"]["frames"]).toEqual({ route: "/tasks/listen/stream", parts: true, frame_ms: 80, rate: 16000, idle_ms: 15000 });
    await on.s.close();
    const off = await boot({ asr: "rest" });
    expect(((await (await fetch(`${off.s.url}/health`)).json()) as Record<string, any>)["ears"]["frames"]).toBeNull();
    expect((await off.part({ part: 0 }, pcm([["quiet", 80]]))).status).toBe(404);
    await off.s.close();
  });

  it("closes within seconds on a restart while a request is still open, so the next serve can start (pass 10's R1 waited 60 s)", async () => {
    const { s } = await boot({ asr: "stream" });
    const { request } = await import("node:http");
    const u = new URL(`${s.url}/tasks/listen/stream?owner=${OWNER}&session_id=open-1&rate=${RATE}&stream=0&part=0`);
    const req = request({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: "POST", headers: { "content-type": "application/octet-stream", "transfer-encoding": "chunked" } });
    req.on("error", () => undefined);
    req.write(pcm([["quiet", 80]]));
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    const closed = await Promise.race([s.close().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 8000))]);
    expect(closed).toBe(true);
    expect(Date.now() - t0).toBeLessThan(8000);
    req.destroy();
  }, 15_000);

  it("feeds numbered parts in order, answers a repeat as a duplicate, restarts on a missing part, and reports lines and statuses under the strip's session", async () => {
    const { s, port, part, frames } = await boot({ asr: "stream", lines: ["Chart his pulse 116", "Chart his temperature 37.6"] });
    const audio = pcm([["quiet", 400], ["tone", 1200], ["quiet", 1000], ["tone", 1200], ["quiet", 1000]]);
    const answers = await frames(audio, { perPart: 2 });
    expect(answers.every((a) => a["accepted"] === true)).toBe(true);
    await s.runtime.settled();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 116 }, { admission_id: ADM, temp_c: "37.6" }]);
    // The first line came back on a later part's answer, before the stream ended.
    const firstAt = answers.findIndex((a) => (a["utterances"] ?? []).some((u: any) => u.text === "Chart his pulse 116"));
    expect(firstAt).toBeGreaterThan(0);
    expect(firstAt).toBeLessThan(answers.length - 1);
    const st = (await (await fetch(`${s.url}/tasks/listen?owner=${OWNER}&session_id=strip-1`)).json()) as { utterances: { seq: number; status: string }[] };
    expect(st.utterances.map((u) => u.status)).toEqual(["completed", "completed"]);
    expect(st.utterances.every((u) => u.seq >= 1_000_000)).toBe(true);
    // A repeated part is not heard twice, and a gap ends the stream so the strip opens a new one.
    expect((await part({ stream: 1, part: 0 }, pcm([["quiet", 80]]))).body).toMatchObject({ accepted: true });
    expect((await part({ stream: 1, part: 0 }, pcm([["quiet", 80]]))).body).toMatchObject({ duplicate: true });
    expect((await part({ stream: 1, part: 3 }, pcm([["quiet", 80]])))).toMatchObject({ status: 409, body: { restart: true, reason: "part_missing" } });
    expect((await part({ stream: 1, part: 4 }, pcm([["quiet", 80]])))).toMatchObject({ status: 409, body: { restart: true, reason: "unknown_stream" } });
    await s.close();
  });

  it("sends the strip back to chunks when no patient is open, and a stream ended while the strip was away reopens with the patient it was with", async () => {
    const { s, port, part } = await boot({ asr: "stream", lines: ["Chart his pulse 116", "Chart his pulse 120"], idleMs: 300 });
    expect(await part({ session: "fresh", part: 0, admissionId: null }, pcm([["quiet", 80]]))).toMatchObject({ status: 409, body: { fallback: "chunks", reason: "no_patient" } });
    const one = pcm([["quiet", 200], ["tone", 1000], ["quiet", 1000]]);
    expect((await part({ part: 0 }, one)).status).toBe(202);
    // The strip went quiet past the idle limit: the stream ended, its line was handed on, and the next part is told to restart.
    await until(() => port.writes.length === 1, 3000);
    await new Promise((r) => setTimeout(r, 600));
    expect(await part({ part: 1 }, pcm([["quiet", 80]]))).toMatchObject({ status: 409, body: { restart: true, reason: "unknown_stream" } });
    // The new stream comes from a page with no patient on it, and the agent is still with the patient it was with.
    const two = await part({ stream: 1, part: 0, admissionId: null, last: true }, pcm([["quiet", 200], ["tone", 1000], ["quiet", 1000]]));
    expect(two).toMatchObject({ status: 202, body: { tracking: { admission_id: ADM } } });
    await s.runtime.settled();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 116 }, { admission_id: ADM, pulse: 120 }]);
    await s.close();
  });

  it("drops the line still being said when it ends a stream for the strip, and tells the strip's next part where the kept audio ended", async () => {
    const { s, port, part } = await boot({ asr: "stream", lines: ["Chart his pulse 116", "Chart his pulse 120"], idleMs: 300 });
    const t0 = Date.now() - 3000;
    // The first line ends at a pause; the second is still being said when the strip goes quiet.
    expect((await part({ part: 0, t: t0 }, pcm([["quiet", 200], ["tone", 1000], ["quiet", 1000], ["tone", 600]]))).status).toBe(202);
    await new Promise((r) => setTimeout(r, 700));
    const again = await part({ part: 1, t: t0 + 2800 }, pcm([["quiet", 80]]));
    expect(again).toMatchObject({ status: 409, body: { restart: true, reason: "unknown_stream" } });
    // Kept to the start of the dropped line, captured about 2.2 s in, so the strip sends that line as a chunk.
    expect(again.body["kept_until"]).toBeGreaterThan(t0 + 1800);
    expect(again.body["kept_until"]).toBeLessThan(t0 + 2300);
    await s.runtime.settled();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 116 }]);
    await s.close();
  });

  it("never hears a chunk again when the frames already carried its audio, so a line is not written twice", async () => {
    const { s, port, part } = await boot({ asr: "stream", lines: ["Chart his pulse 116"], transcribe: async (_w, _k, sid) => ({ final: true, text: "Chart his pulse 116", audio_ms: 1000, session_id: sid, cost_usd: 0 }) });
    const t0 = Date.now() - 3000;
    const audio = pcm([["quiet", 200], ["tone", 1000], ["quiet", 1000]]);
    expect((await part({ part: 0, t: t0, last: true }, audio)).status).toBe(202);
    await s.runtime.settled();
    expect(port.writes).toHaveLength(1);
    // The strip's chunk of the same words, captured at the same moment, arrives too.
    const form = new FormData();
    form.append("audio", new Blob([Buffer.from(encodeWav(new Float32Array(audio.length / 2).map((_, i) => audio.readInt16LE(i * 2) / 32768), RATE))], { type: "audio/wav" }), "c0.wav");
    form.append("owner", OWNER); form.append("admissionId", ADM); form.append("session_id", "strip-1"); form.append("seq", "0"); form.append("captured_at", String(t0));
    const r = await fetch(`${s.url}/tasks/listen?wait=1`, { method: "POST", body: form });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ heard_by_frames: true });
    await s.runtime.settled();
    expect(port.writes).toHaveLength(1);
    await s.close();
  });

  it("moves to the new patient when the page changes mid-stream, and the line being said keeps the patient it began on", async () => {
    const { s, port, part } = await boot({ asr: "stream", lines: ["Chart his pulse 116", "Chart her pulse 98"] });
    expect((await part({ part: 0 }, pcm([["quiet", 200], ["tone", 600]]))).status).toBe(202);
    // The page changed while the first line was still being said.
    expect((await part({ part: 1, admissionId: ADM2 }, pcm([["tone", 400], ["quiet", 1000]]))).body).toMatchObject({ tracking: { admission_id: ADM2 } });
    expect((await part({ part: 2, admissionId: ADM2, last: true }, pcm([["tone", 1000], ["quiet", 1000]]))).status).toBe(202);
    await s.runtime.settled();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 116 }, { admission_id: ADM2, pulse: 98 }]);
    await s.close();
  });

  // The kept C-17 run's own talk and Voice Transcribe readings; point AMBIENT_RUN at it.
  it.skipIf(!process.env["AMBIENT_RUN"] || !existsSync(join(process.env["AMBIENT_RUN"] ?? "", "talk.wav")))("a frame-fed listener writes the same three vitals as the chunk path on the kept clips", async () => {
    const dir = process.env["AMBIENT_RUN"]!;
    const wav = new Uint8Array(readFileSync(join(dir, "talk.wav")));
    const timeline = TimelineSchema.parse(JSON.parse(readFileSync(join(dir, "talk.timeline.json"), "utf8")));
    const { samples, sampleRate } = decodeWav(wav);
    // The first four lines: a greeting, the three vitals, an aside, the blood pressure.
    const endMs = timeline.utterances[4]!.start_ms;
    const clip = samples.subarray(0, Math.round((endMs * sampleRate) / 1000));
    const chunked = await boot({ asr: "rest", transcribe: replayTranscriber(join(dir, "rec", "transcripts.json")) });
    let seq = 0;
    // The kept readings are keyed by the exact audio, so the chunks are cut from the kept file itself.
    for (const c of talkChunks(wav, timeline).filter((x) => x.end_ms <= endMs)) {
      const form = new FormData();
      form.append("audio", new Blob([Buffer.from(c.wav)], { type: "audio/wav" }), `c${seq}.wav`);
      form.append("owner", OWNER); form.append("admissionId", ADM); form.append("session_id", "kept-chunks"); form.append("seq", String(seq++));
      const res = await fetch(`${chunked.s.url}/tasks/listen?wait=1`, { method: "POST", body: form });
      expect(res.status).toBe(202);
    }
    await chunked.s.listening.flush("kept-chunks");
    await chunked.s.runtime.settled();
    const heard = chunked.s.runtime.views(OWNER)[0]!.transcript.map((l) => l.text);
    const viaChunks = chunked.port.writes.map((w) => w.args);
    await chunked.s.close();
    expect(viaChunks).toContainEqual({ admission_id: ADM, temp_c: "37.9", pulse: 96, resp_rate: 20 });
    // The stream ear hears each line as Voice Transcribe did, so only the transport differs: 80 ms frames in numbered parts.
    const streamed = await boot({ asr: "stream", lines: heard });
    const rate = sampleRate === 24_000 ? 24_000 : 16_000;
    const answers = await streamed.frames(toPcm(sampleRate === rate ? clip : resample(clip, sampleRate, rate)), { session: "kept-frames", perPart: 1, rate });
    expect(answers.every((a) => a["accepted"] === true)).toBe(true);
    await streamed.s.runtime.settled();
    expect(streamed.port.writes.map((w) => w.args)).toEqual(viaChunks);
    await streamed.s.close();
  }, 60_000);
});
