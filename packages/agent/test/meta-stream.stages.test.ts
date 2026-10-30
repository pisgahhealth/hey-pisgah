import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadKeys } from "@hey-pisgah/model";
import { SILENCE_RMS, cleanTranscript, decodeWav, readVitals, vitalsVocabulary } from "@hey-pisgah/voice";
import { normValue } from "../src/emr/ears.js";
import type { ListenSessions, StreamSegment } from "../src/emr/listen.js";
import { MetaStreamListener } from "../src/emr/meta-stream.js";
import { percentile } from "../src/emr/runtime.js";

// Runs only with STAGES=1 and META_LIVE=1: Meta's realtime ear on the eight vitals lines G6 timed, with no gate, from the end of speech to the completed turn.
const RUN = process.env["STAGES"] === "1" && process.env["META_LIVE"] === "1";
const RATE = 24_000;
const LINES: { text: string; values: Record<string, string> }[] = [
  { text: "Chart his pulse 116.", values: { pulse: "116" } }, { text: "Chart his temperature 38.3.", values: { temp_c: "38.3" } },
  { text: "Chart his respiratory rate 24.", values: { resp_rate: "24" } }, { text: "Chart his blood pressure 104 over 62.", values: { bp: "104/62" } },
  { text: "Chart his pulse 112.", values: { pulse: "112" } }, { text: "Chart his temperature 37.9.", values: { temp_c: "37.9" } },
  { text: "Chart his respiratory rate 22.", values: { resp_rate: "22" } }, { text: "Chart his pulse 108.", values: { pulse: "108" } }
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const valuesRight = (heard: string, values: Record<string, string>) => {
  const r = readVitals(vitalsVocabulary(cleanTranscript(heard)).text) as Record<string, unknown[] | undefined>;
  return Object.entries(values).every(([m, v]) => (r[m] ?? []).map((x) => normValue(m as never, x)).includes(normValue(m as never, v)));
};
// Where speech ends in a clip: the end of its last loud 20 ms frame.
const speechEndMs = (x: Float32Array) => {
  const f = (RATE * 20) / 1000;
  let last = 0;
  for (let i = 0; i + f <= x.length; i += f) { let s = 0; for (let k = i; k < i + f; k++) s += x[k]! * x[k]!; if (Math.sqrt(s / f) >= SILENCE_RMS) last = i + f; }
  return (last / RATE) * 1000;
};

describe.skipIf(!RUN)("Meta's realtime ear on the eight vitals lines", () => {
  it("times each completed turn from the end of speech and counts the values heard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hp-g9s-"));
    const voice = process.env["G6_VOICE"];
    const clips = LINES.map((l, i) => {
      const f = join(dir, `v${i}.wav`);
      execFileSync("say", [...(voice ? ["-v", voice] : []), "-o", f, "--file-format=WAVE", `--data-format=LEI16@${RATE}`, `${l.text} [[slnc 900]]`], { stdio: "ignore" });
      return decodeWav(new Uint8Array(readFileSync(f))).samples;
    });
    const got: { at: number; seg: StreamSegment }[] = [];
    const rows: Record<string, unknown>[] = [];
    const stub = { hintsFor: async () => [], segment: async (s: StreamSegment) => { got.push({ at: Date.now(), seg: s }); return []; }, nextWords: () => undefined, flush: async () => undefined, unreportedOf: () => ({ utterances: [], errors: [] }) } as unknown as ListenSessions;
    const m = new MetaStreamListener(stub, { key: () => loadKeys()["MODEL_API_KEY"] ?? "", ledger: (_r, row) => rows.push(row) });
    await m.open({ owner: "o", target: { admission_id: "a" }, session_id: "stage", rate: RATE });
    const frame = (RATE * 20) / 1000;
    const t0 = Date.now();
    let fed = 0;
    const ends: number[] = [];
    const feed = async (x: Float32Array) => {
      for (let i = 0; i < x.length; i += frame) {
        const due = t0 + (fed / RATE) * 1000;
        if (due > Date.now()) await sleep(due - Date.now());
        m.feed("stage", x.subarray(i, i + frame));
        fed += Math.min(frame, x.length - i);
      }
    };
    const out: Record<string, unknown> = { started_at: new Date().toISOString(), voice: voice ?? "system default", load_start: loadavg(), lines: LINES.length, mode: "ENDPOINTING", rate: RATE };
    await feed(new Float32Array(RATE / 2));
    for (const c of clips) { ends.push(t0 + ((fed + (speechEndMs(c) / 1000) * RATE) / RATE) * 1000); await feed(c); await feed(new Float32Array(Math.round(RATE * 2.5))); }
    await m.end("stage");
    const per = got.map((g, i) => ({ text: g.seg.raw, after_speech_ms: ends[i] !== undefined ? g.at - ends[i]! : null, right: LINES[i] ? valuesRight(g.seg.raw, LINES[i]!.values) : false }));
    const ms = per.map((p) => p.after_speech_ms).filter((x): x is number => typeof x === "number");
    Object.assign(out, { turns: got.length, values_heard: per.filter((p) => p.right).length, after_speech: { n: ms.length, p50_ms: percentile(ms, 50), p90_ms: percentile(ms, 90), max_ms: ms.length ? Math.max(...ms) : null }, per, ledger: rows, cost_usd: rows.reduce((n, r) => n + Number(r["cost_usd"] ?? 0), 0), load_end: loadavg() });
    const file = process.env["HEY_PISGAH_STAGES_OUT"];
    if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`); }
    expect(got.length).toBe(LINES.length);
  }, 120_000);
});
