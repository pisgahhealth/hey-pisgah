import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_YES, PRESENCE_RULE, ReplayGuard, gateUtterance, sherpaEmbedder, type EmrContext, type LivenessMarker, type SayableNames } from "@hey-pisgah/agent";
import { ModelClient, ModelError, loadKeys } from "@hey-pisgah/model";
import { ASR_MODEL, VITALS_KEYWORDS, buildKeywords, cleanTranscript, decodeWav, encodeWav, transcribeWav, vitalsVocabulary } from "../src/index.js";
import { LINES, SPEAKER_OF, type Line } from "./lines.js";
import { REAL, type RealClip } from "./real.lines.js";
import { SYNTH_RATE, far, rng, sha256Hex, speak } from "./synth.js";
import type { ClipReading } from "./score.js";
import { V2_LINES, bindingHolds, shortKind, type V2Context } from "./v2.lines.js";
import type { V2Row } from "./v2.score.js";

// Builds the attribution v2 set now, from the synthetic voices and the owner's real recordings, and keeps cosines, presence verdicts and readings only.
const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const work = arg("work", ".hey-pisgah/g4");
const synthDir = arg("synth"), realDir = arg("real"), runId = arg("run", "run-g4attr01");
const live = process.argv.includes("--live");
const out = arg("out", "packages/voice/research/fixtures/v2.readings.json");
const embed = sherpaEmbedder({ modelPath: arg("model"), sherpaDir: arg("sherpa") || undefined });
if (!embed) throw new Error("speaker model did not load");
mkdirSync(join(work, "audio"), { recursive: true });

const unit = (v: number[]) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const vec = async (wav: Uint8Array) => (await embed(wav))?.vector ?? null;
const template = async (wavs: Uint8Array[]) => { const vs = (await Promise.all(wavs.map(vec))).filter((v): v is number[] => !!v).map(unit); return unit(vs[0]!.map((_, i) => vs.reduce((s, v) => s + v[i]!, 0))); };
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

// A voice by macOS name at a distance, laid on room tone; Aman is the colleague with the owner's accent and sex.
const VOICE = { S: "Rishi", B: "Daniel", N: "Tessa", C: "Aman", P: "Samantha", R: "Karen" } as const;
type Part = { voice: keyof typeof VOICE; at_ms: number; gain: number; far: boolean; rate: number; words: string };
function mix(parts: Part[], seed: string): Uint8Array {
  const r = rng(seed);
  const xs = parts.map((p) => { const s = speak(VOICE[p.voice], p.words, p.rate); return { at: Math.round((p.at_ms / 1000) * SYNTH_RATE), x: p.far ? far(s, p.gain) : s.map((v) => v * p.gain) }; });
  const lead = Math.round(0.4 * SYNTH_RATE);
  const t = new Float32Array(lead * 2 + Math.max(...xs.map((v) => v.at + v.x.length)));
  for (const v of xs) for (let i = 0; i < v.x.length; i++) t[lead + v.at + i]! += v.x[i]!;
  for (let i = 0; i < t.length; i++) t[i] = t[i]! + (r() * 2 - 1) * 0.002;
  return encodeWav(t, SYNTH_RATE);
}
// Mixes two recordings at an offset: real talk-over, not one after the other.
function overlay(a: Uint8Array, b: Uint8Array, offsetMs: number, gainB: number, seed: string): Uint8Array {
  const x = decodeWav(a), y = decodeWav(b), r = rng(seed);
  if (x.sampleRate !== y.sampleRate) throw new Error("rates differ");
  const off = Math.round((offsetMs / 1000) * x.sampleRate);
  const t = new Float32Array(Math.max(x.samples.length, off + y.samples.length));
  t.set(x.samples);
  for (let i = 0; i < y.samples.length; i++) t[off + i]! += y.samples[i]! * gainB;
  // A room never gives the same samples twice, so each mix carries its own faint noise floor.
  for (let i = 0; i < t.length; i++) t[i] = t[i]! + (r() * 2 - 1) * 0.001;
  let peak = 0; for (const v of t) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.95) for (let i = 0; i < t.length; i++) t[i] = (t[i]! / peak) * 0.95;
  return encodeWav(t, x.sampleRate);
}
// A recording played from a phone speaker into the laptop: band-limited, slightly clipped, with short room echoes.
function loudspeaker(a: Uint8Array, seed: string): Uint8Array {
  const { samples: x, sampleRate: sr } = decodeWav(a);
  const r = rng(seed);
  const hp = Math.exp((-2 * Math.PI * 250) / sr), lp = 1 - Math.exp((-2 * Math.PI * 4500) / sr);
  const y = new Float32Array(x.length + Math.round(0.08 * sr));
  let h = 0, prev = 0, l1 = 0, l2 = 0;
  for (let i = 0; i < x.length; i++) { h = hp * (h + x[i]! - prev); prev = x[i]!; l1 += lp * (h - l1); l2 += lp * (l1 - l2); y[i] = Math.tanh(2 * l2) / Math.tanh(2); }
  for (let i = y.length - 1; i >= 0; i--) y[i] = y[i]! + 0.3 * (y[i - Math.round(0.023 * sr)] ?? 0) + 0.18 * (y[i - Math.round(0.041 * sr)] ?? 0) + 0.1 * (y[i - Math.round(0.067 * sr)] ?? 0) + (r() * 2 - 1) * 0.003;
  return encodeWav(y, sr);
}

// The strip's chunks of one clip: pieces of at most six seconds, the way the recorder cuts them.
const chunks = (wav: Uint8Array): { wav: Uint8Array; ms: number }[] => {
  const { samples, sampleRate } = decodeWav(wav);
  const n = 6 * sampleRate, outs: { wav: Uint8Array; ms: number }[] = [];
  for (let i = 0; i < samples.length; i += n) { const s = samples.slice(i, i + n); outs.push({ wav: encodeWav(s, sampleRate), ms: Math.round((s.length / sampleRate) * 1000) }); }
  return outs;
};
const AT_SCREEN: LivenessMarker = { visible: true, mic_live: true, input_age_ms: 4000 };
const AWAY: LivenessMarker = { visible: true, mic_live: true, input_age_ms: 20 * 60_000 };
const guard = new ReplayGuard("required", { ...PRESENCE_RULE }, true);
let clock = 1_000_000_000;
// Sends a clip through the replay defence as a session of its own, at live pace or as a burst, and returns its verdict.
function present(session: string, wav: Uint8Array, marker: LivenessMarker | null): string {
  clock += 120_000;
  const cs = chunks(wav);
  for (const [i, c] of cs.entries()) {
    clock += c.ms;
    const v = guard.check({ owner: "owner", session_id: session, seq: i, wav: c.wav, audio_ms: c.ms, speech: true, arrived_at: clock, captured_at: clock - c.ms, marker });
    if (v.refused) return `refused:${v.refused}`;
  }
  const p = guard.lineOf(session, cs.map((_, i) => i));
  return p.live ? "live" : p.live === false ? `not_present:${p.reason}` : "unknown";
}

// Voice Transcribe then the shipped gate, with the ward context R1 used; cached by audio hash so a rerun calls nothing.
const cacheFile = join(work, "readings.json");
const cache: Record<string, Pick<ClipReading, "transcript" | "gate">> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
const DOCTOR_KINDS = ["record_observation", "draft_consult_note", "request_admission", "record_note", "page_staff", "schedule_follow_up"];
const CONTEXT: EmrContext = { admission_id: "a0000000-0000-4000-8000-000000000003", patient_id: "a0000000-0000-4000-8000-000000000001", label: "Ada Okon, female, 54", facts: { ward: "Female medical", bed: "Bed 4" }, keywords: [] };
const NAMES: SayableNames = { page_targets: { nurse_in_charge: ["nurse in charge"], surgical_registrar: ["surgical registrar"], anaesthetist: ["anaesthetist"] }, clinics: { surgical: ["surgical clinic"] } };
const keys = live ? loadKeys() : null;
const client = live ? new ModelClient({ storeRoot: join(work, "store"), mode: "live", record: false, timeoutMs: 90_000 }) : null;
const keywords = buildKeywords({ vitals: VITALS_KEYWORDS, wards: [], documents: [], staff: [], beds: [] });
// The gate runs only with --gate, and only on its own route: a reading from the fallback model is void and never counted.
const gateOn = process.argv.includes("--gate");
const WAITS = "waits_for_spark_open";
for (const v of Object.values(cache)) if (v.gate.fallback_reason) v.gate = { provider: null, model: null, clauses: [], latency_ms: 0, cost_usd: 0, fallback_reason: null, error: WAITS };
async function read(id: string, wav: Uint8Array, gateWanted: boolean): Promise<Pick<ClipReading, "transcript" | "gate">> {
  const sha = sha256Hex(wav);
  const gate = gateWanted && gateOn;
  const hit = cache[sha];
  if (hit && !hit.transcript.error && (!gate || (hit.gate.error !== "skipped" && hit.gate.error !== WAITS))) return { ...hit, gate: gateWanted && !gateOn && hit.gate.error === "skipped" ? { ...hit.gate, error: WAITS } : hit.gate };
  if (!client) throw new Error(`${id} has no kept reading; run with --live`);
  const t0 = performance.now();
  let transcript: ClipReading["transcript"];
  if (hit && !hit.transcript.error) transcript = hit.transcript;
  else try {
    const r = await transcribeWav({ wav, keywords, key: keys!.MODEL_API_KEY ?? "", sessionId: `g4-${id}-${Date.now().toString(36)}`.slice(0, 64), timeoutMs: 40_000 });
    transcript = { model: ASR_MODEL, text: vitalsVocabulary(cleanTranscript(r.text)).text, latency_ms: Math.round(performance.now() - t0), cost_usd: r.cost_usd, error: null };
  } catch (e) { transcript = { model: ASR_MODEL, text: "", latency_ms: Math.round(performance.now() - t0), cost_usd: 0, error: e instanceof Error ? e.message : String(e) }; }
  let g: ClipReading["gate"] = { provider: null, model: null, clauses: [], latency_ms: 0, cost_usd: 0, fallback_reason: null, error: gate ? "no_transcript" : gateWanted ? WAITS : "skipped" };
  if (gate && transcript.text) {
    const t1 = performance.now();
    try {
      const r = await gateUtterance(client, { kinds: DOCTOR_KINDS, context: CONTEXT, actions: [], openQuestion: null, recent: [], said: transcript.text, today: "2026-10-30", names: NAMES }, { run_id: runId, task_id: "t-g4gate00" });
      g = { provider: r.provider, model: r.model, clauses: r.value.clauses.map((x) => ({ class: x.class, kind: x.kind ?? null, confidence: x.confidence ?? null, words: x.words })), latency_ms: Math.round(performance.now() - t1), cost_usd: r.cost_usd, fallback_reason: r.fallback_reason, error: null };
      if (r.fallback_reason) g = { provider: null, model: null, clauses: [], latency_ms: 0, cost_usd: 0, fallback_reason: null, error: WAITS };
    } catch (e) { g = { ...g, latency_ms: Math.round(performance.now() - t1), error: e instanceof ModelError ? e.code : String(e) }; }
  }
  cache[sha] = { transcript, gate: g };
  writeFileSync(cacheFile, `${JSON.stringify(cache, null, 1)}\n`);
  process.stderr.write(`${id} read: ${transcript.text.slice(0, 60)} | ${g.clauses.map((c) => c.class).join(",")}\n`);
  return cache[sha]!;
}

const rows: V2Row[] = [];
type Pending = Omit<V2Row, "cos" | "presence" | "reading" | "sha256" | "audio_ms"> & { wav: Uint8Array; reading: Pick<ClipReading, "transcript" | "gate"> | "gate" | "words"; presence?: string };
const pending: Pending[] = [];
const OKON: V2Context = { patient: "okon", read_back: null, batch_now: null };
const YES: V2Context = { patient: "okon", read_back: { patient: "okon", batch: "b1" }, batch_now: "b1" };
const synthClip = (id: string) => new Uint8Array(readFileSync(join(synthDir, `${id}.wav`)));
const category = (l: Pick<Line, "who" | "addressee" | "overlap">) => (l.overlap ? "overlap" : l.who === "S" && l.addressee === "staff" ? "owner_to_colleague" : "plain");

// Synthetic: R1's kept clips and readings, re-embedded with the serve's own model path against four templates.
const kept = [...JSON.parse(readFileSync("packages/voice/research/fixtures/tuning.readings.json", "utf8")).clips, ...JSON.parse(readFileSync("packages/voice/research/fixtures/final.readings.json", "utf8")).clips] as ClipReading[];
const enrol = (who: string) => [1, 2, 3].map((i) => synthClip(`E${i}-${who}`));
const ENROLMENT_WORDS = ["Good morning. I am on the medical ward today, and I will be seeing the patients in bays one to four before lunch.", "The weather has been hot this week, so please keep the windows open and make sure the water jugs are full.", "Number one, two, three, four, five, six, seven, eight, nine, ten. Twenty, thirty, forty, fifty. One hundred."];
const synthT = { S: await template(enrol("S")), B: await template(enrol("B")), N: await template(enrol("N")), C: await template(ENROLMENT_WORDS.map((w, i) => mix([{ voice: "C", at_ms: 0, gain: 0.85, far: false, rate: 180 + i * 8, words: w }], `E${i}-C`))) };
for (const c of kept) {
  const l = LINES.find((x) => x.id === c.line)!;
  pending.push({ id: `syn-${c.id}`, source: "synthetic", set: l.set === "final" ? "held_out" : "tuning", person: l.who, role: SPEAKER_OF[l.who] === "other_clinician" ? "colleague" : SPEAKER_OF[l.who] === "owner" ? "owner" : "unenrolled", addressee: l.addressee, kind: l.kind, category: category(l), overlap_with: l.overlap?.who ?? null, context: OKON, replay: null, wav: synthClip(c.id), reading: { transcript: c.transcript, gate: c.gate } });
}
// The colleague whose voice is closest to the owner's says every colleague line the owner's agent might act on.
for (const l of LINES.filter((x) => (x.who === "B" || x.who === "N") && !x.overlap)) {
  const r = rng(`C-${l.id}`);
  pending.push({ id: `syn-C-${l.id}`, source: "synthetic", set: l.set === "final" ? "held_out" : "tuning", person: "C", role: "colleague", addressee: l.addressee, kind: l.kind, category: "similar_colleague", overlap_with: null, context: OKON, replay: null, wav: mix([{ voice: "C", at_ms: 0, gain: 0.5 + r() * 0.2, far: true, rate: Math.round(170 + r() * 30), words: l.words }], `C-${l.id}`), reading: "gate" });
}
// Talk-over mixed at offsets: a colleague's order with the owner's "yes, go on" over it, and the owner's order with someone else talking over.
const ORDERS = V2_LINES.filter((l) => l.block === "O" && l.kind === "instruction").map((l) => l.words);
for (let i = 0; i < 24; i++) {
  const r = rng(`ov-${i}`);
  const w = ORDERS[i % ORDERS.length]!;
  const colleagueFirst = i < 12;
  const first: Part = colleagueFirst ? { voice: i % 2 ? "C" : "B", at_ms: 0, gain: 0.55, far: true, rate: 180, words: w } : { voice: "S", at_ms: 0, gain: 0.85, far: false, rate: 185, words: w };
  const second: Part = colleagueFirst ? { voice: "S", at_ms: 600 + Math.round(r() * 600), gain: 0.8, far: false, rate: 185, words: i % 3 ? "Yeah, go on." : "Mm." } : { voice: i % 2 ? "C" : "P", at_ms: 700 + Math.round(r() * 500), gain: 0.5, far: true, rate: 180, words: i % 2 ? "I will see the next patient." : "It has been hurting since morning." };
  pending.push({ id: `syn-OV${String(i + 1).padStart(2, "0")}`, source: "synthetic", set: i % 4 === 0 ? "tuning" : "held_out", person: colleagueFirst ? first.voice : "S", role: colleagueFirst ? "colleague" : "owner", addressee: "agent", kind: "instruction", category: "overlap", overlap_with: second.voice, context: OKON, replay: null, wav: mix([first, second], `ov-${i}`), reading: "gate" });
}
// Short answers by the owner, a similar colleague, another clinician and an unenrolled voice; and the owner's yes after the patient or the batch changed.
const SHORT = ["Yes.", "Go on.", "Yeah, go on.", "Mm.", "No, no.", "Okay, sign them."];
for (const v of ["S", "C", "B", "P"] as const) SHORT.forEach((w, i) => {
  const wav = mix([{ voice: v, at_ms: 0, gain: v === "S" ? 0.85 : 0.55, far: v !== "S", rate: 185, words: w }], `y-${v}-${i}`);
  pending.push({ id: `syn-Y-${v}${i}`, source: "synthetic", set: i === 0 ? "tuning" : "held_out", person: v, role: v === "S" ? "owner" : v === "P" ? "unenrolled" : "colleague", addressee: "agent", kind: shortKind(w), category: "short", overlap_with: null, context: YES, replay: null, wav, reading: "words" });
});
const K = V2_LINES.filter((l) => l.block === "K" && l.who === "S" && l.kind === "confirm");
K.forEach((l, i) => {
  const w = Math.max(0, SHORT.indexOf(l.words));
  const cat = l.context.read_back && l.context.read_back.patient !== l.context.patient ? "changed_patient" : l.context.batch_now !== l.context.read_back?.batch ? "changed_batch" : "bound_yes";
  const wav = mix([{ voice: "S", at_ms: 0, gain: 0.85, far: false, rate: 185, words: SHORT[w]! }], `k-${i}`);
  pending.push({ id: `syn-K${i + 1}`, source: "synthetic", set: "held_out", person: "S", role: "owner", addressee: "agent", kind: shortKind(SHORT[w]!), category: cat, overlap_with: null, context: l.context, replay: null, wav, reading: "words" });
});

// Real: the owner's recordings, cut as R1.b cut them, with N's six clips as the first real other person.
const real = REAL as readonly RealClip[];
const manifest = JSON.parse(readFileSync("packages/voice/research/real-set.json", "utf8")) as { clips: (RealClip & { source: string; start_s: number | null; end_s: number | null; sha256: string })[] };
const realReadings = JSON.parse(readFileSync("packages/voice/research/fixtures/real.readings.json", "utf8")).clips as ClipReading[];
const voices = JSON.parse(readFileSync("packages/voice/research/fixtures/real.voices.json", "utf8")).clips as Record<string, { cluster: string }>;
// afconvert writes an extensible header with extra chunks, so the samples are read from the fmt and data chunks directly.
function pcm16(b: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12, rate = 0;
  while (at + 8 <= b.length) {
    const id = String.fromCharCode(...b.subarray(at, at + 4)), size = v.getUint32(at + 4, true);
    if (id === "fmt ") rate = v.getUint32(at + 12, true);
    if (id === "data") { const n = Math.floor(size / 2), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = v.getInt16(at + 8 + i * 2, true) / 32768; return { samples: x, sampleRate: rate }; }
    at += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}
const conv = join(work, "real-src");
mkdirSync(conv, { recursive: true });
const realWav: Record<string, Uint8Array> = {};
let hashOk = 0;
for (const c of manifest.clips) {
  const src = join(conv, c.source.replace(/\.m4a$/, ".wav"));
  if (!existsSync(src)) execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", join(realDir, c.source), src]);
  const { samples, sampleRate } = pcm16(new Uint8Array(readFileSync(src)));
  const a = Math.floor((c.start_s ?? 0) * sampleRate), b = c.end_s === null ? samples.length : Math.min(samples.length, Math.floor(c.end_s * sampleRate));
  realWav[c.id] = encodeWav(samples.slice(a, b), sampleRate);
  if (sha256Hex(realWav[c.id]!) === c.sha256) hashOk += 1;
}
const ownerT = await template(["E1", "E2", "E3"].map((id) => realWav[id]!));
for (const c of manifest.clips.filter((x) => x.set === "tuning" || x.set === "final")) {
  const second = voices[c.id]?.cluster === "second";
  const rd = realReadings.find((x) => x.id === c.id)!;
  pending.push({ id: `real-${c.id}`, source: "real", set: c.set === "final" ? "held_out" : "tuning", person: second ? "N" : "S", role: second ? "unenrolled" : "owner", addressee: c.addressee!, kind: c.kind!, category: second ? "second_voice" : c.who === "S" ? (c.addressee === "staff" ? "owner_to_colleague" : "plain") : "owner_reading_other_part", overlap_with: null, context: OKON, replay: null, wav: realWav[c.id]!, reading: { transcript: rd.transcript, gate: rd.gate } });
}
// Real talk-over: the owner's held-out instruction with N's real voice coming in over it.
const ownerInstr = manifest.clips.filter((c) => c.set === "final" && c.who === "S" && c.kind === "instruction" && c.addressee === "agent" && voices[c.id]?.cluster !== "second").map((c) => c.id);
const nClips = manifest.clips.filter((c) => voices[c.id]?.cluster === "second").map((c) => c.id);
for (let i = 0; i < 12; i++) {
  const o = ownerInstr[i % ownerInstr.length]!, n = nClips[i % nClips.length]!;
  pending.push({ id: `real-OV${String(i + 1).padStart(2, "0")}`, source: "real", set: "held_out", person: "S", role: "owner", addressee: "agent", kind: "instruction", category: "overlap", overlap_with: "N", context: OKON, replay: null, wav: overlay(realWav[o]!, realWav[n]!, 600 + (i % 4) * 200, 0.8, `real-ov-${i}`), reading: "gate" });
}

// Readings first, three at a time; each is kept by audio hash.
const todo = pending.filter((p) => typeof p.reading === "string");
let next = 0;
await Promise.all([0, 1, 2].map(async () => { while (next < todo.length) { const p = todo[next++]!; await read(p.id, p.wav, p.reading === "gate"); } }));
// Every live clip is sent once through the replay defence from a person at the screen.
for (const p of pending) {
  const rd = typeof p.reading === "string" ? await read(p.id, p.wav, p.reading === "gate") : p.reading;
  const v = await vec(p.wav);
  const ts: Record<string, number[]> = p.source === "real" ? { S: ownerT } : synthT;
  const { wav: _wav, ...kept } = p;
  rows.push({ ...kept, sha256: sha256Hex(p.wav), audio_ms: decodeWav(p.wav).samples.length / decodeWav(p.wav).sampleRate * 1000 | 0, cos: v ? Object.fromEntries(Object.entries(ts).map(([k, t]) => [k, r4(cosine(unit(v), t))])) : null, presence: present(p.id, p.wav, AT_SCREEN), reading: rd } as V2Row);
}
// Replays of the owner's held-out instructions: the captured chunks posted again, and the recording played from a phone with the owner away or at the screen.
const replayOf = rows.filter((r) => r.role === "owner" && r.set === "held_out" && r.kind === "instruction" && r.addressee === "agent" && (r.category === "plain") && !r.overlap_with).slice(0, 30);
for (const o of replayOf) {
  const src = pending.find((p) => p.id === o.id)!.wav;
  const copy = loudspeaker(src, `rp-${o.id}`);
  const v = await vec(copy);
  const ts: Record<string, number[]> = o.source === "real" ? { S: ownerT } : synthT;
  const cos = v ? Object.fromEntries(Object.entries(ts).map(([k, t]) => [k, r4(cosine(unit(v), t))])) : null;
  const base = { ...o, category: "replay", sha256: sha256Hex(copy), cos, reading: o.reading };
  rows.push({ ...base, id: `${o.id}-copy`, replay: "digital_copy", presence: present(`${o.id}-copy`, src, AT_SCREEN), cos: o.cos, sha256: o.sha256 } as V2Row);
  rows.push({ ...base, id: `${o.id}-away`, replay: "played_owner_away", presence: present(`${o.id}-away`, copy, AWAY) } as V2Row);
  rows.push({ ...base, id: `${o.id}-here`, replay: "played_owner_present", presence: present(`${o.id}-here`, loudspeaker(src, `rp2-${o.id}`), AT_SCREEN) } as V2Row);
}
client?.close();
const at = new Date().toISOString();
writeFileSync(out, `${JSON.stringify({
  built_at: at, run_id: runId, model: "nemo_en_titanet_small (sherpa-onnx-node, 16 kHz)", templates: { synthetic: "S Rishi, B Daniel, N Tessa, C Aman (same sex and accent as the owner), mean of three enrolment clips", real: "S the owner's three R1.b enrolment clips; no other real voice is enrolled" },
  real_cut_hashes_matching_r1b: `${hashOk} of ${manifest.clips.length}`, presence_rule: PRESENCE_RULE, owner_yes: OWNER_YES.source,
  rows: rows.map((r) => ({ ...r, binding_holds: r.kind === "confirm" ? bindingHolds(r.context) : null }))
}, null, 1)}\n`);
process.stderr.write(`${rows.length} rows; real cuts matching R1.b hashes ${hashOk}/${manifest.clips.length}\n`);
