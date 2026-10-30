import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRESENCE_RULE, ReplayGuard, sherpaEmbedder, type LivenessMarker } from "@hey-pisgah/agent";
import { decodeWav, encodeWav } from "../src/wav.js";
import { sha256Hex } from "./synth.js";
import { align, parakeet, pcm, words } from "./v2.cut.lib.js";
import { V2_LINES } from "./v2.lines.js";
import { GATE_WAITS, type V2Row } from "./v2.score.js";

// Scores the owner's re-recorded lines and full-volume phone replays with no model call: cut on the spoken ids, voice against his enrolment, the replay defence, and the denoiser check; the rows they replace stay, marked superseded.
const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const work = arg("work", ".hey-pisgah/g4"), src = join(work, "v2-src"), out = join(work, "v2-redo-clips");
mkdirSync(out, { recursive: true });
const rec = parakeet(arg("sherpa"), arg("parakeet"));
const embed = sherpaEmbedder({ modelPath: arg("model"), sherpaDir: arg("sherpa") })!;
type Den = { run(o: { samples: Float32Array; sampleRate: number }): { samples: Float32Array } };
const den = new (createRequire(join(arg("sherpa"), "package.json"))("sherpa-onnx-node") as { OfflineSpeechDenoiser: new (c: unknown) => Den }).OfflineSpeechDenoiser({ model: { gtcrn: { model: arg("denoiser") }, numThreads: 1, debug: 0, provider: "cpu" } });
const SUPERSEDED_AT = "2026-10-30";

const unit = (v: number[]) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const mean = (vs: number[][]) => unit(vs[0]!.map((_, i) => vs.reduce((s, v) => s + v[i]!, 0)));
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const vec = async (x: Float32Array) => { const e = (await embed(encodeWav(x, 16000)))?.vector; return e ? unit(e) : null; };
const cos = (a: number[] | null, t: number[]) => (a ? r4(a.reduce((s, x, i) => s + x * t[i]!, 0)) : null);
const dbOf = (x: Float32Array) => { let s = 0, n = 0; for (const v of x) if (Math.abs(v) > 0.0005) { s += v * v; n++; } return Math.round(10 * Math.log10((n ? s / n : 1e-12) + 1e-12) * 10) / 10; };
const denoise = (x: Float32Array) => den.run({ samples: x, sampleRate: 16000 }).samples;

// Cuts one file on its spoken ids, one clip per scripted line, without the id.
type Cut = { id: string; file: string; start_s: number; end_s: number; sha256: string; heard: string; id_heard: boolean; matched: number; of: number; status: string; x: Float32Array | null };
function cut(file: string, lines: { id: string; n: number; words: string }[]): Cut[] {
  const x = pcm(join(src, `${file}.wav`)), ws = words(rec, x), spans = align(ws, lines.map((l) => ({ id: l.n, words: l.words })));
  const starts = spans.map((s) => (s.id_word !== null ? s.id_word : s.first));
  return spans.map((s, k) => {
    const l = lines[k]!, from = s.id_word !== null ? s.id_word + s.id_len : s.first, next = starts.slice(k + 1).find((v) => v !== null) ?? null;
    const none = { id: l.id, file, start_s: 0, end_s: 0, sha256: "", heard: "", id_heard: s.id_word !== null, matched: s.matched, of: s.of, status: "missing", x: null };
    if (from === null || (s.matched === 0 && s.id_word === null) || from >= ws.length || (next !== null && from >= next)) return none;
    let to = (next ?? ws.length) - 1;
    for (let i = Math.max(from, s.last ?? from); i < to; i++) if (ws[i + 1]!.t - ws[i]!.end > 1.5) { to = i; break; }
    const a = Math.max(0, ws[from]!.t - 0.15), end = Math.min(next !== null ? Math.max(ws[to]!.end, ws[next]!.t - 0.1) : x.length / 16000, ws[to]!.end + 0.6);
    const clip = x.slice(Math.floor(a * 16000), Math.floor(end * 16000)), wav = encodeWav(clip, 16000);
    writeFileSync(join(out, `${l.id}.wav`), wav);
    return { ...none, start_s: Math.round(a * 100) / 100, end_s: Math.round(end * 100) / 100, sha256: sha256Hex(wav), heard: ws.slice(from, to + 1).map((w) => w.w).join(" "), status: s.matched / s.of < 0.34 ? "words_changed" : "ok", x: clip };
  });
}
const line = (id: string) => V2_LINES.find((l) => l.id === id)!;
const redo = cut("O-S-redo", ["O045", "O083", "O084"].map((id) => ({ id, n: Number(id.slice(1)), words: line(id).words })));
const replay = (file: string, base: number) => cut(file, Array.from({ length: 10 }, (_, i) => { const id = `R${String(base + i + 1).padStart(3, "0")}`; return { id, n: base + i + 1, words: line(line(id).replay_of!).words }; }));
const replays = [...replay("R-S-replay-2", 10), ...replay("R-S-replay-1.5-2", 20)];

// The owner's template from his three enrolment passages, plain and through the denoiser.
const enrol = ["E1", "E2", "E3"].map((id) => pcm(join(work, "real-src", `${id}.wav`)));
const T = mean((await Promise.all(enrol.map(vec))).filter((v): v is number[] => !!v));
const Td = mean((await Promise.all(enrol.map((x) => vec(denoise(x))))).filter((v): v is number[] => !!v));

const fxFile = "packages/voice/research/fixtures/v2.readings.json";
const fx = JSON.parse(readFileSync(fxFile, "utf8")) as { rows: V2Row[] } & Record<string, unknown>;
const oldCuts = (JSON.parse(readFileSync("packages/voice/research/v2-real-set.json", "utf8")) as { cuts: { id: string; part: string; sha256: string }[] }).cuts;
// The live take of each replayed line, checked against its listed hash, so the session check can see it before the replay.
const liveOf = (id: string) => { const c = oldCuts.find((x) => x.id === id && x.part === "line")!; const w = new Uint8Array(readFileSync(join(work, "v2-clips", `${id}.wav`))); if (sha256Hex(w) !== c.sha256) throw new Error(`${id} does not match its listed hash`); return decodeWav(w).samples; };
const AT_SCREEN: LivenessMarker = { visible: true, mic_live: true, input_age_ms: 4000 }, AWAY: LivenessMarker = { visible: true, mic_live: true, input_age_ms: 20 * 60_000 };
let clock = 2_000_000_000;
function present(g: ReplayGuard, session: string, x: Float32Array, marker: LivenessMarker): string {
  clock += 120_000;
  const n = 6 * 16000, seqs: number[] = [];
  for (let i = 0, s = 0; i < x.length; i += n, s++) {
    const c = x.slice(i, i + n), ms = Math.round((c.length / 16000) * 1000);
    clock += ms;
    const v = g.check({ owner: "owner", session_id: session, seq: s, wav: encodeWav(c, 16000), audio_ms: ms, speech: true, arrived_at: clock, captured_at: clock - ms, marker });
    if (v.refused) return `refused:${v.refused}`;
    seqs.push(s);
  }
  const p = g.lineOf(session, seqs);
  return p.live ? "live" : p.live === false ? `not_present:${p.reason}` : "unknown";
}
const fresh = () => new ReplayGuard("required", { ...PRESENCE_RULE }, true);

// The rows these recordings replace stay in the fixture, marked superseded, and leave every count.
const replaced = new Set([...redo.map((c) => `v2-${c.id}`), ...replays.flatMap((c) => [`v2-${c.id}-away`, `v2-${c.id}-here`])]);
const rows = fx.rows.filter((r) => !r.id.endsWith("-redo") && !/-redo-(away|here)$/.test(r.id)).map((r) => replaced.has(r.id) && !r.note?.startsWith("superseded") ? { ...r, usable: false, note: `superseded by the ${SUPERSEDED_AT} re-recording${r.note ? `; was ${r.note}` : ""}` } : r);
const notRead = { transcript: { model: "none", text: "", latency_ms: 0, cost_usd: 0, error: "not read: no model calls in this step" }, gate: { provider: null, model: null, clauses: [], latency_ms: 0, cost_usd: 0, fallback_reason: null, error: GATE_WAITS } };
const denoiseCheck: Record<string, { plain: number | null; denoised: number | null; best: number | null }> = {};
for (const c of redo.filter((c) => c.x)) {
  const l = line(c.id), x = c.x!;
  const plain = cos(await vec(x), T), dn = cos(await vec(denoise(x)), Td);
  denoiseCheck[c.id] = { plain, denoised: dn, best: plain === null && dn === null ? null : Math.max(plain ?? -1, dn ?? -1) };
  rows.push({ id: `v2-${c.id}-redo`, source: "owner_v2", set: l.set, person: "S", role: "owner", addressee: l.addressee, kind: l.kind, category: l.addressee === "staff" ? "owner_to_colleague" : "plain", overlap_with: null, context: l.context, replay: null, sha256: c.sha256, audio_ms: Math.round((x.length / 16000) * 1000), cos: plain === null ? null : { S: plain }, presence: present(fresh(), `${c.id}-redo`, x, AT_SCREEN), reading: notRead } as V2Row);
}
const levels: Record<string, { replay_db: number; live_db: number }> = {};
for (const c of replays.filter((c) => c.x)) {
  const origId = line(c.id).replay_of!, live = liveOf(origId), o = rows.find((r) => r.id === `v2-${origId}`)!;
  levels[c.id] = { replay_db: dbOf(c.x!), live_db: dbOf(live) };
  // A replay's words are the live line's words, so it carries the live line's reading; Part 4's replay rows carried no gate reading, so they could never act.
  const v = cos(await vec(c.x!), T);
  const base = { ...o, set: "held_out" as const, category: "replay", sha256: c.sha256, audio_ms: Math.round((c.x!.length / 16000) * 1000), cos: v === null ? null : { S: v }, reading: o.reading };
  for (const [tag, marker, kind] of [["away", AWAY, "played_owner_away"], ["here", AT_SCREEN, "played_owner_present"]] as const) {
    const g = fresh();
    present(g, `${origId}-live`, live, AT_SCREEN);
    rows.push({ ...base, id: `v2-${c.id}-redo-${tag}`, replay: kind, presence: present(g, `${c.id}-${tag}`, c.x!, marker) } as V2Row);
  }
}
writeFileSync(fxFile, `${JSON.stringify({ ...fx, redo: { at: new Date().toISOString(), superseded: [...replaced].filter((id) => fx.rows.some((r) => r.id === id)).sort(), levels_db: levels }, rows }, null, 1)}\n`);
const strip = (cs: Cut[]) => cs.map(({ x: _x, ...c }) => c);
writeFileSync("packages/voice/research/v2-redo-set.json", `${JSON.stringify({ cut_at: new Date().toISOString(), sources: Object.fromEntries(["O-S-redo", "R-S-replay-2", "R-S-replay-1.5-2"].map((f) => [`${f}.m4a`, sha256Hex(new Uint8Array(readFileSync(join(arg("real-v2"), `${f}.m4a`))))])), cuts: [...strip(redo), ...strip(replays)], denoise_check: denoiseCheck }, null, 1)}\n`);
process.stderr.write(`redo ${redo.map((c) => `${c.id} ${c.status}`).join(", ")}; replays ${replays.filter((c) => c.status !== "missing").length} of ${replays.length} cut\n`);
