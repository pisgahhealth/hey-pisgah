import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanTranscript, decodeWav, readVitals, vitalsVocabulary } from "@hey-pisgah/voice";
import { compareReadings, normValue } from "../src/emr/ears.js";
import { localDirs, parakeetEar, sherpaStreamAsr } from "../src/emr/local-ears.js";
import type { ListenSessions, StreamSegment } from "../src/emr/listen.js";
import { percentile } from "../src/emr/runtime.js";
import { voiceTranscriber } from "../src/emr/serve.js";
import { StreamListener } from "../src/emr/stream-listen.js";

// Runs only with STAGES=1: each ear's own time and what it heard on the eight vitals lines, with no gate and no Spark call.
const RUN = process.env["STAGES"] === "1";
const MODELS = process.env["HEY_PISGAH_ASR_DIR"] ?? join(process.cwd(), ".hey-pisgah", "asr");
const RATE = 24_000;
const LINES: { text: string; values: Record<string, string> }[] = [
  { text: "Chart his pulse 116.", values: { pulse: "116" } }, { text: "Chart his temperature 38.3.", values: { temp_c: "38.3" } },
  { text: "Chart his respiratory rate 24.", values: { resp_rate: "24" } }, { text: "Chart his blood pressure 104 over 62.", values: { bp: "104/62" } },
  { text: "Chart his pulse 112.", values: { pulse: "112" } }, { text: "Chart his temperature 37.9.", values: { temp_c: "37.9" } },
  { text: "Chart his respiratory rate 22.", values: { resp_rate: "22" } }, { text: "Chart his pulse 108.", values: { pulse: "108" } }
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The words a first ear heard carry the line's values when the vitals reader finds each one.
const valuesRight = (heard: string, values: Record<string, string>) => {
  const r = readVitals(vitalsVocabulary(cleanTranscript(heard)).text) as Record<string, unknown[] | undefined>;
  return Object.entries(values).every(([m, v]) => (r[m] ?? []).map((x) => normValue(m as never, x)).includes(normValue(m as never, v)));
};
const stats = (xs: number[]) => ({ n: xs.length, p50_ms: percentile(xs, 50), p90_ms: percentile(xs, 90), max_ms: xs.length ? Math.max(...xs) : null });

describe.skipIf(!RUN)("each ear's own stage on the eight vitals lines", () => {
  it("times Voice Transcribe, the streaming ear and Parakeet on the same clips, and counts the values each heard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hp-g6s-"));
    const voice = process.env["G6_VOICE"];
    const clips = LINES.map((l, i) => {
      const f = join(dir, `v${i}.wav`);
      execFileSync("say", [...(voice ? ["-v", voice] : []), "-o", f, "--file-format=WAVE", `--data-format=LEI16@${RATE}`, `${l.text} [[slnc 900]]`], { stdio: "ignore" });
      return new Uint8Array(readFileSync(f));
    });
    const out: Record<string, unknown> = { started_at: new Date().toISOString(), voice: voice ?? "system default", load_start: loadavg(), lines: LINES.length };
    const dirs = localDirs(MODELS);
    const ear = parakeetEar({ modelDir: dirs.parakeetDir })!;
    const asr = sherpaStreamAsr({ modelDir: dirs.streamDir })!;
    expect(asr).not.toBeNull();

    // Voice Transcribe REST, the default first ear and the Meta reading under the stream switch.
    const vt: { ms: number; text: string; right: boolean; agree: boolean }[] = [];
    for (const [i, c] of clips.entries()) {
      const t0 = Date.now();
      const r = await voiceTranscriber(c, [], `g6s-${Date.now().toString(36)}-${i}`);
      vt.push({ ms: Date.now() - t0, text: r.text, right: valuesRight(r.text, LINES[i]!.values), agree: compareReadings(LINES[i]!.values, r.text).agree });
    }
    // Parakeet as the second reading of the same clips.
    const pk: { ms: number; text: string; agree: boolean }[] = [];
    for (const c of clips.values()) {
      const t0 = performance.now();
      const r = await ear(c, { run_id: "run-g6stage", task_id: "t", line_id: "l" });
      pk.push({ ms: Math.round(performance.now() - t0), text: r.text, agree: false });
    }
    pk.forEach((p, i) => { p.agree = compareReadings(LINES[i]!.values, p.text).agree; });

    // The streaming ear, fed 20 ms frames on the clock they were spoken on, each line followed by 2.5 s of quiet as in the speed runs.
    const ends: number[] = [];
    const got: { at: number; seg: StreamSegment }[] = [];
    const stub = { segment: async (s: StreamSegment) => { got.push({ at: Date.now(), seg: s }); return []; }, nextWords: () => undefined, flush: async () => undefined, unreportedOf: () => ({ utterances: [], errors: [] }) } as unknown as ListenSessions;
    const sl = new StreamListener(stub, asr);
    sl.open({ owner: "o", target: { admission_id: "a" }, session_id: "s", rate: RATE });
    const frame = (RATE * 20) / 1000;
    const t0 = Date.now();
    let fed = 0;
    let decodeMs = 0;
    const feed = async (x: Float32Array) => {
      for (let i = 0; i < x.length; i += frame) {
        const due = t0 + (fed / RATE) * 1000;
        if (due > Date.now()) await sleep(due - Date.now());
        const d0 = performance.now();
        sl.feed("s", x.subarray(i, i + frame));
        decodeMs += performance.now() - d0;
        fed += Math.min(frame, x.length - i);
      }
    };
    await feed(new Float32Array(RATE));
    for (const c of clips) {
      const { samples } = decodeWav(c);
      // The end of speech on the wall clock: the clip's last loud sample, fed in real time.
      let last = samples.length - 1;
      while (last > 0 && Math.abs(samples[last]!) < 0.01) last--;
      ends.push(t0 + ((fed + last) / RATE) * 1000);
      await feed(samples);
      await feed(new Float32Array((RATE * 2500) / 1000));
    }
    await sl.end("s");
    const streamRows = got.map((g, i) => {
      const end = ends.reduce((best, e) => (e <= g.at && e > best ? e : best), 0);
      const line = ends.indexOf(end);
      return { line, words_ms: g.at - end, raw: g.seg.raw, trailing_ms: g.seg.trailing_ms, right: line >= 0 ? valuesRight(g.seg.raw, LINES[line]!.values) : false, i };
    });
    Object.assign(out, {
      voice_transcribe: { ...stats(vt.map((x) => x.ms)), values_right: vt.filter((x) => x.right).length, rows: vt },
      stream: { model: asr.model, endpoint_ms: 700, ...stats(streamRows.map((x) => x.words_ms)), stretches: streamRows.length, values_right: streamRows.filter((x) => x.right).length, decode_ms_total: Math.round(decodeMs), audio_ms_total: Math.round((fed / RATE) * 1000), rows: streamRows },
      parakeet: { ...stats(pk.map((x) => x.ms)), agree: pk.filter((x) => x.agree).length, rows: pk },
      // Clip lengths, so a reader can set ear time against audio time.
      clip_ms: clips.map((c) => Math.round((decodeWav(c).samples.length / RATE) * 1000)),
      load_end: loadavg()
    });
    const file = process.env["HEY_PISGAH_G6_STAGES_OUT"];
    if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`); }
    expect(streamRows.length).toBeGreaterThanOrEqual(LINES.length);
  }, 10 * 60_000);
});
