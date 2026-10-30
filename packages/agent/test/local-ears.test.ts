import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import type { FinalTranscript } from "@hey-pisgah/voice";
import { compareAll, type EarReading, type SecondEar } from "../src/emr/ears.js";
import { allEars, asrSwitch, earSwitch, localDirs, parakeetEar, sherpaStreamAsr, streamRepair, type StreamAsr } from "../src/emr/local-ears.js";
import type { EmrRuntime } from "../src/emr/runtime.js";
import { startEmrServe } from "../src/emr/serve.js";
import { ADM, FakeEmr, OWNER, emrRoot, gater } from "./emr-helpers.js";
import { obs } from "./mic-helpers.js";

const RATE = 16_000;
const STRIP = "http://localhost:3311";
const reading = (text: string, provider: EarReading["provider"] = "local", model = "local:test"): EarReading => ({ text, provider, model, response_id: null, cost_usd: provider === "local" ? 0 : 0.0001, fallback_reason: null });

// 16-bit PCM of a tone or of quiet, as a microphone would send it.
const pcm = (parts: [kind: "tone" | "quiet", ms: number][]): Buffer => {
  const n = parts.reduce((s, [, ms]) => s + (ms * RATE) / 1000, 0);
  const b = Buffer.alloc(n * 2);
  let i = 0;
  for (const [kind, ms] of parts) for (let k = 0; k < (ms * RATE) / 1000; k++, i++) b.writeInt16LE(kind === "tone" ? Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 220 * k) / RATE)) : 0, i * 2);
  return b;
};

// A streaming recogniser as a script: each stretch of speech is the next line, and its words come out one per 200 ms of speech while it is said.
function scriptedStream(lines: string[]): StreamAsr & { stretches: () => number } {
  let k = 0;
  return {
    model: "local:scripted-stream",
    stretches: () => k,
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

async function bootStream(lines: string[], o: { local: string; meta: string; numberMs?: number; replay?: "refuse" }) {
  const root = emrRoot();
  const port = new FakeEmr();
  let rt: EmrRuntime | null = null;
  const seen: string[] = [];
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater((said) => (said.includes("37.6") ? obs(said, { temp_c: "37.6" }) : said.includes("116") ? obs(said, { pulse: 116 }) : said.includes("rate 22") ? obs(said, { resp_rate: 22 }) : [{ class: "aside" }]), seen), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  const metaHeard: number[] = [];
  const local: SecondEar = async () => reading(o.local);
  const s = await startEmrServe({
    storeRoot: root, port, client, listenPort: 0, runtime: { holdMs: 0, proofRetryMs: 1 }, preferences: false,
    ears: local, asr: "stream", streamAsr: scriptedStream(lines),
    // Voice Transcribe here is only ever the Meta reading of a number line, never the first ear.
    transcribe: async (wav, _k, sid) => { metaHeard.push(wav.length); return { final: true, text: o.meta, audio_ms: 1000, session_id: sid, cost_usd: 0.00005 }; },
    listen: { numberJoinWaitMs: o.numberMs ?? 5000, strongJoinWaitMs: 5000, ...(o.replay ? { replay: o.replay } : {}) }
  });
  rt = s.runtime;
  const stream = async (body: Buffer, session = "st1") => {
    const r = await fetch(`${s.url}/tasks/listen/stream?owner=${OWNER}&admissionId=${ADM}&session_id=${session}&rate=${RATE}`, { method: "POST", headers: { "content-type": "audio/pcm", origin: STRIP }, body: new Uint8Array(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  return { s, port, root, seen, metaHeard, stream };
}

describe("the switches", () => {
  it("are both off unless set, so recorded runs replay with Voice Transcribe and the Spark ear", () => {
    expect(earSwitch(undefined)).toBe("spark");
    expect(earSwitch("")).toBe("spark");
    expect(earSwitch("Parakeet")).toBe("parakeet");
    expect(asrSwitch(undefined)).toBe("rest");
    expect(asrSwitch("stream")).toBe("stream");
  });

  it("stop the service when a switched-on ear cannot load, rather than running without it", async () => {
    const base = { storeRoot: emrRoot(), port: new FakeEmr(), listenPort: 0, preferences: false as const };
    await expect(startEmrServe({ ...base, ears: "parakeet", local: { parakeetDir: "/nonexistent" } })).rejects.toThrow(/Parakeet second ear was switched on/);
    await expect(startEmrServe({ ...base, storeRoot: emrRoot(), asr: "stream", local: { streamDir: "/nonexistent" } })).rejects.toThrow(/streaming ear was switched on/);
  });
});

describe("the streaming model's known mishearing", () => {
  it("reads a tens word then 'to' at the end of a number as two, and leaves a time of day alone", () => {
    expect(streamRepair("chart his respiratory rate twenty to")).toBe("chart his respiratory rate twenty two");
    expect(streamRepair("blood pressure one hundred and four over sixty to.")).toBe("blood pressure one hundred and four over sixty two.");
    expect(streamRepair("pulse ninety too over")).toBe("pulse ninety two over");
    expect(streamRepair("come back at twenty to nine")).toBe("come back at twenty to nine");
    expect(streamRepair("send it to the lab")).toBe("send it to the lab");
  });
});

describe("every reading must agree", () => {
  it("agrees only when each reading carries the value, and shows the first one that did not", () => {
    const both: EarReading = { ...reading("Temperature 37.6, pulse 116."), also: [reading("temperature 37.6 pulse 116", "meta", "muse-voice-transcribe-1.0")] };
    expect(compareAll({ temp_c: "37.6", pulse: 116 }, both)).toMatchObject({ agree: true });
    const off: EarReading = { ...reading("Temperature 37.6, pulse 116."), also: [reading("temperature 37.6 pulse 160", "meta", "muse-voice-transcribe-1.0")] };
    expect(compareAll({ temp_c: "37.6", pulse: 116 }, off)).toEqual({ agree: false, measures: [{ measure: "temp_c", first: "37.6", second: "37.6", agree: true }, { measure: "pulse", first: "116", second: "160", agree: false }] });
  });

  it("reads with every ear at once, sums the cost, and fails when any ear fails", async () => {
    const r = await allEars([async () => reading("pulse 116"), async () => reading("pulse 116", "meta", "muse-voice-transcribe-1.0")])(new Uint8Array(), { run_id: "r", task_id: "t", line_id: "l" });
    expect(r).toMatchObject({ provider: "local", calls: 2, cost_usd: 0.0001, also: [{ provider: "meta", model: "muse-voice-transcribe-1.0" }] });
    await expect(allEars([async () => reading("pulse 116"), async () => { throw new Error("502"); }])(new Uint8Array(), { run_id: "r", task_id: "t", line_id: "l" })).rejects.toThrow("502");
  });
});

describe("the streaming first ear", () => {
  it("ends lines at a pause, joins a number said across one, lets a finished number go on the next words, and Meta reads every number line", async () => {
    const { s, port, root, seen, metaHeard, stream } = await bootStream(
      ["Chart his temperature thirty seven", "point six", "Chart his pulse one hundred and sixteen", "Emeka hand me the gloves please"],
      { local: "temperature 37.6 pulse 116", meta: "temperature 37.6 pulse 116" });
    const r = await stream(pcm([["quiet", 400], ["tone", 1500], ["quiet", 900], ["tone", 600], ["quiet", 1200], ["tone", 1800], ["quiet", 900], ["tone", 1400], ["quiet", 900]]));
    expect(r.status).toBe(202);
    await s.runtime.settled();
    expect(seen).toEqual(["Chart his temperature 37.6", "Chart his pulse 116", "Emeka hand me the gloves please"]);
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, temp_c: "37.6" }, { admission_id: ADM, pulse: 116 }]);
    const v = s.runtime.views(OWNER)[0]!;
    expect(v.transcript.map((l) => l.ambient?.finished_by)).toEqual(["joined_across_cut", "number_alone", "quiet_tail"]);
    // Voice Transcribe read the two number lines as the Meta reading, and nothing else.
    expect(metaHeard).toHaveLength(2);
    expect(v.ears).toMatchObject({ compared: 2, agreed: 2 });
    const compared = readStream(root, `emr/${v.task_id}`).filter((e) => e.record_type === "ears.compared").map((e) => e.payload as Record<string, any>);
    expect(compared[0]!["readings"]).toEqual([{ provider: "local", model: "local:test", cost_usd: 0 }, { provider: "meta", model: "muse-voice-transcribe-1.0", cost_usd: 0.00005 }]);
    // Each reading is on the ledger with its model and purpose.
    const rows = readdirSync(join(root, "ledger")).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readStream(root, `ledger/${f.replace(/\.jsonl$/, "")}`)).filter((e) => e.record_type === "reading.call").map((e) => e.payload as Record<string, unknown>);
    expect(rows.map((x) => [x["provider"], x["model"], x["purpose"]])).toEqual([["meta", "muse-voice-transcribe-1.0", "verify_number"], ["meta", "muse-voice-transcribe-1.0", "verify_number"]]);
    const health = (await (await fetch(`${s.url}/health`)).json()) as Record<string, any>;
    expect(health["ears"]).toEqual({ first_ear: "local:scripted-stream", second_ear: "given", meta_reading_on_numbers: true });
    await s.close();
  });

  it("stops the write when the Meta reading hears a different number, whatever the local ears agree on", async () => {
    const { s, port, stream } = await bootStream(["Chart his pulse one hundred and sixteen"], { local: "pulse 116", meta: "pulse 160" });
    expect((await stream(pcm([["quiet", 400], ["tone", 1800], ["quiet", 900]]))).status).toBe(202);
    await s.runtime.settled();
    expect(port.writes).toEqual([]);
    const v = s.runtime.views(OWNER)[0]!;
    expect(v.actions.map((a) => [a.state, a.reason])).toEqual([["cancelled", "readings_differ"]]);
    expect(v.questions[0]!.text).toBe("Pulse: one reading heard 116, the other 160. Say 116 or 160.");
    await s.close();
  });

  it("hears the model's 'twenty to' as 22 on the stream path, and the other readings still decide", async () => {
    const { s, port, seen, stream } = await bootStream(["Chart his respiratory rate twenty to"], { local: "respiratory rate 22", meta: "respiratory rate 22" });
    expect((await stream(pcm([["quiet", 400], ["tone", 1800], ["quiet", 900]]))).status).toBe(202);
    await s.runtime.settled();
    expect(seen).toEqual(["Chart his respiratory rate 22"]);
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, resp_rate: 22 }]);
    await s.close();
  });

  it("with replay refusal on, refuses a stream sent faster than it could be spoken", async () => {
    const { s, port, stream } = await bootStream(["Chart his pulse one hundred and sixteen"], { local: "pulse 116", meta: "pulse 116", replay: "refuse" });
    const r = await stream(pcm([["quiet", 400], ["tone", 1800], ["quiet", 900], ["quiet", 3000]]));
    expect(r).toMatchObject({ status: 409, body: { error: "replayed audio refused: faster_than_live" } });
    await s.runtime.settled();
    expect(port.writes).toEqual([]);
    await s.close();
  });

  it("refuses a stream with no patient, the wrong body type, or another page's origin", async () => {
    const { s, stream } = await bootStream(["x"], { local: "", meta: "" });
    const url = `${s.url}/tasks/listen/stream?owner=${OWNER}&session_id=n1&rate=${RATE}`;
    expect((await fetch(url, { method: "POST", headers: { "content-type": "audio/pcm", origin: STRIP }, body: new Uint8Array(pcm([["quiet", 100]])) })).status).toBe(400);
    expect((await fetch(`${url}&admissionId=${ADM}`, { method: "POST", headers: { "content-type": "application/octet-stream", origin: STRIP }, body: new Uint8Array(pcm([["quiet", 100]])) })).status).toBe(415);
    expect((await fetch(`${url}&admissionId=${ADM}`, { method: "POST", headers: { "content-type": "audio/pcm", origin: "http://evil.example" }, body: new Uint8Array(pcm([["quiet", 100]])) })).status).toBe(403);
    expect((await stream(pcm([["quiet", 500]]), "n2")).body).toMatchObject({ accepted: true, utterances: [] });
    await s.close();
  });
});

// Runs only with LOCAL_EARS=1 and the models under HEY_PISGAH_ASR_DIR (sherpa-onnx-node installed).
const MODELS = process.env["HEY_PISGAH_ASR_DIR"] ?? join(process.cwd(), ".hey-pisgah", "asr");
describe.skipIf(process.env["LOCAL_EARS"] !== "1")("the real local models", () => {
  it("Parakeet and the streaming model both hear a synthetic vitals line, with its number", async () => {
    const dirs = localDirs(MODELS);
    expect(existsSync(dirs.parakeetDir) && existsSync(dirs.streamDir)).toBe(true);
    const file = join(mkdtempSync(join(tmpdir(), "hp-g6-")), "t.wav");
    execFileSync("say", ["-o", file, "--file-format=WAVE", "--data-format=LEI16@24000", "Chart his temperature 38.3. [[slnc 900]]"], { stdio: "ignore" });
    const wav = new Uint8Array(readFileSync(file));
    const ear = parakeetEar({ modelDir: dirs.parakeetDir })!;
    const r = await ear(wav, { run_id: null as unknown as string, task_id: "t", line_id: "l" });
    expect(r).toMatchObject({ provider: "local", model: "local:nemo-parakeet-tdt-0.6b-v2-int8", cost_usd: 0 });
    expect(r.text).toContain("38.3");
    const asr = sherpaStreamAsr({ modelDir: dirs.streamDir })!;
    const t = await asr.transcribe(wav, [], "s");
    expect(t.text.toLowerCase()).toContain("thirty eight point three");
  }, 60_000);
});
