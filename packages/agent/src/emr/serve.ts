import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { loadKeys, ModelClient, type Mode } from "@hey-pisgah/model";
import { VITALS_KEYWORDS, VoiceError, buildKeywords, cleanTranscript, transcribeWav, vitalsVocabulary, type FinalTranscript, type SocketFactory } from "@hey-pisgah/voice";
import { sparkEar, type SecondEar } from "./ears.js";
import { allEars, parakeetEar, sherpaStreamAsr, transcriberEar, type ReadingLedger, type StreamAsr } from "./local-ears.js";
import { StreamListener, StreamRefused } from "./stream-listen.js";
import { META_STREAM_MODEL, MetaStreamFailed, MetaStreamListener, probeRealtime } from "./meta-stream.js";
import { EmrRuntime, type EmrRuntimeOptions } from "./runtime.js";
import { ListenError, ListenSessions, parallelReadings, type ListenOptions, type ListenUtterance, type Transcriber } from "./listen.js";
import { parseWav } from "@hey-pisgah/voice";
import { printWav, type Embedder, type LivenessMarker } from "./speaker.js";
import { Heartbeats } from "./presence.js";
import { EmrId, EmrPortError, type EmrPort, type EmrTarget } from "./port.js";
import { gateArrival } from "./gate.js";
import { EMERGENCY_KIND, EMERGENCY_LINE, EMERGENCY_PRESS, afterWake, identityFrom, emergencyHeardLoosely, emergencyReason, spokenPatient, unidentifiedRef } from "./entry.js";
import { shortHash } from "../ids.js";
import { openStream } from "@hey-pisgah/store";
import { PreferenceError, PreferenceMemory, SCOPE_KINDS, describePref, describeScope, describeSource } from "./preferences.js";

export const EMR_SERVE_PORT = 4100;

// The default ear: Voice Transcribe REST with the key from the keys file, read only when audio arrives.
export const voiceTranscriber: Transcriber = (wav, keywords, sessionId) =>
  transcribeWav({ wav, keywords, key: loadKeys()["MODEL_API_KEY"] ?? "", sessionId });
// The same ear with a language hint in every request.
export const biasedTranscriber = (languageBias: readonly string[]): Transcriber => (wav, keywords, sessionId) =>
  transcribeWav({ wav, keywords, key: loadKeys()["MODEL_API_KEY"] ?? "", sessionId, languageBias });

export type EmrServeOptions = {
  storeRoot: string; port: EmrPort;
  client?: ModelClient; mode?: Mode; recordingsDir?: string;
  // False keeps model requests and replies out of the recordings folder, so no heard words are written there.
  recordModel?: boolean;
  // The second ear for vitals from audio: Spark audio input, Parakeet on this machine, off, or one given by a test.
  ears?: "spark" | "parakeet" | "off" | SecondEar;
  // The first ear: Voice Transcribe REST by default, the local streaming model (Voice Transcribe kept as a further reading of number lines), or Meta's realtime socket on the frames route.
  asr?: "rest" | "stream" | "meta-stream";
  // The realtime socket for meta-stream, given by a test or wrapped by the recorder; the network socket otherwise.
  realtimeSocket?: SocketFactory;
  // The realtime credential, read from the keys file unless given.
  realtimeKey?: () => string;
  // Languages both Voice Transcribe ears are steered toward; none unless switched on.
  languageBias?: readonly string[];
  // Staff names for the recognition hints.
  staffHints?: readonly string[];
  // How many Voice Transcribe readings of each chunk are taken at once; above one, the second-opinion rule is on too.
  vtReadings?: number;
  // D17: a whole-number vital in range is written without the continuation wait or the hold, and a continuation amends it.
  releaseWhole?: boolean;
  // Where the local models and the sherpa-onnx library live, for the parakeet and stream switches.
  local?: { parakeetDir?: string; streamDir?: string; sherpaDir?: string | undefined; threads?: number };
  // A streaming recogniser given by a test, used in place of loading one.
  streamAsr?: StreamAsr;
  // How long a frames stream waits for its next part before it is ended; FRAME_IDLE_MS unless a test shortens it.
  framesIdleMs?: number;
  listenPort?: number; hosts?: readonly string[];
  // The one browser origin allowed to call serve, the EMR page that hosts the strip.
  allowOrigin?: string;
  transcribe?: Transcriber;
  // Continuous listening settings for POST /tasks/listen.
  listen?: Omit<ListenOptions, "transcribe">;
  runtime?: Omit<EmrRuntimeOptions, "storeRoot" | "client" | "port">;
  // The local speaker model for attribution and for enrolment voiceprints; no audio is kept by either.
  embed?: Embedder;
  log?: (line: string) => void;
  // The on-device keyword spotter's files, served to the strip under /kws/.
  kwsDir?: string;
  // The A&E clinic an emergency opened by voice lands on.
  emergencyClinicId?: string;
  // How long held speech waits for an arrival, for tests; PENDING_MAX_MS by default.
  pendingMaxMs?: number;
  // Preference memory is on unless turned off; it lives in the same store as the tasks.
  preferences?: boolean;
};
export type EmrServe = { urls: string[]; url: string; runtime: EmrRuntime; client: ModelClient; listening: ListenSessions; preferences: PreferenceMemory | null; close: () => Promise<void> };

const Owner = z.string().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/);
const hasTarget = (b: { admissionId?: string | undefined; patientId?: string | undefined }) => b.admissionId !== undefined || b.patientId !== undefined;
const AudioMeta = z.strictObject({ owner: Owner, admissionId: EmrId.optional(), patientId: EmrId.optional() }).refine(hasTarget, "admissionId or patientId is required");
const Via = z.enum(["gate", "intent"]).optional();
const Say = z.strictObject({ owner: Owner, admissionId: EmrId.optional(), patientId: EmrId.optional(), text: z.string().min(1).max(1000), spokenAt: z.iso.datetime({ offset: true }).optional(), via: Via });
const FollowUp = z.strictObject({ text: z.string().min(1).max(1000), task_id: z.string().optional(), owner: Owner.optional(), spokenAt: z.iso.datetime({ offset: true }).optional(), via: Via });
const Open = z.strictObject({ owner: Owner, admissionId: EmrId.optional(), patientId: EmrId.optional() }).refine(hasTarget, "admissionId or patientId is required");
// Listening needs no patient: the agent tracks the patient the clinician is with, or waits for the emergency phrase or a name.
const SessionId = z.string().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/);
const PresenceOpen = z.strictObject({ owner: Owner, session_id: SessionId });
const PresenceBeat = z.strictObject({ owner: Owner, session_id: SessionId, seq: z.number().int().min(0), at: z.number().int().positive(), visible: z.boolean(), mic_live: z.boolean(), mac: z.string().regex(/^[0-9a-f]{64}$/) });
const ListenMeta = z.strictObject({
  owner: Owner, admissionId: EmrId.optional(), patientId: EmrId.optional(),
  session_id: SessionId, seq: z.coerce.number().int().min(0).max(1_000_000),
  // When the strip captured the words (epoch ms), so they are bound to the patient in front of the clinician then.
  captured_at: z.coerce.number().int().positive().optional(),
  // Set when the device spotted "emergency" with no wake before it, so this audio is checked by transcript for the phrase.
  hint: z.enum(["emergency", "after_wake"]).optional(),
  // The strip's liveness marker for the replay defence: page visible, microphone live, and the age of the last trusted input.
  presence: z.strictObject({ visible: z.boolean(), mic_live: z.boolean(), input_age_ms: z.number().min(0).nullable() }).optional()
});
// The strip's Emergency button opens the same arrival as the phrase; its line says it was pressed, never that it was said.
const Emergency = z.strictObject({ owner: Owner, text: z.string().min(1).max(300).default("hey Pisgah, emergency"), spokenAt: z.iso.datetime({ offset: true }), wake: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(), press: z.boolean().optional() });
// One wake measured in the browser: phrase end to the visible armed state, on the page's clock.
const Wake = z.strictObject({ owner: Owner, keyword: z.enum(["wake", "emergency"]), phrase_end_ms: z.number(), armed_ms: z.number(), latency_ms: z.number().min(0).max(60_000), spotter: z.string().max(80), page: z.string().max(200).optional(), audio_ms: z.number().optional() });
const KWS_FILE = /^[A-Za-z0-9_.-]{1,120}$/;
const KWS_TYPES: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".txt": "text/plain", ".json": "application/json" };
const Interrupt = z.strictObject({ owner: Owner.optional(), task_id: z.string().optional() });
const Scope = z.strictObject({ owner: Owner, scope: z.enum([...SCOPE_KINDS, "no"]) });
// A hospital rule given as text by a person, under the scope they name; a patient scope comes only from a correction or a spoken rule.
const External = z.strictObject({ owner: Owner, text: z.string().min(3).max(600), scope: z.enum(["me", "ward", "everyone"]), ward: z.string().min(1).max(120).optional() });
const StreamMeta = z.strictObject({ owner: Owner, admissionId: EmrId.optional(), patientId: EmrId.optional(), session_id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/), rate: z.coerce.number().int().refine((r) => r === 16_000 || r === 24_000, "rate is 16000 or 24000") });
// One hour of 24 kHz audio.
const STREAM_LIMIT = 24_000 * 2 * 3600;
// The strip's frames come as short numbered parts of one stream, since a browser cannot stream a request body to this plain HTTP/1.1 service.
const FramesMeta = StreamMeta.extend({ stream: z.coerce.number().int().min(0).max(9999), part: z.coerce.number().int().min(0), last: z.literal("1").optional(), t: z.coerce.number().int().optional() });
// The frame size the strip is asked to send, 80 ms as Meta's examples use.
export const FRAME_MS = 80;
// Ten seconds of 24 kHz audio is the most one part may carry.
const FRAME_PART_LIMIT = 24_000 * 2 * 10;
// A frames stream that hears no part for this long is ended, its lines handed on, and the strip opens a new one.
export const FRAME_IDLE_MS = 15_000;
// Statuses of lines heard from frames are numbered apart from the strip's chunk numbers.
const FRAME_SEQ_BASE = 1_000_000;
const JSON_LIMIT = 64 * 1024;
const AUDIO_LIMIT = 8 * 1024 * 1024;

// How long speech after an emergency phrase is held for the arrival before it is let go as not kept.
export const PENDING_MAX_MS = 60_000;
// The longest speech is held for an arrival whose write is still uncertain or awaiting verification, so held words wait for its outcome rather than fail.
export const PENDING_UNSETTLED_MAX_MS = 10 * 60_000;
// A new listening session with no patient on its page keeps the patient the agent is with only if that patient was chosen this recently.
export const SUBJECT_KEEP_MS = 30 * 60_000;
// Two hearings of the emergency phrase this close together are one phrase, so one arrival.
export const ARRIVAL_SAME_PHRASE_MS = 10_000;
// How far back, and how many, words heard with no patient are read with the next line for an arrival.
const ARRIVAL_RECENT_MS = 90_000;
const ARRIVAL_RECENT_LINES = 4;
type Track = { page: string; history: { target: EmrTarget | null; since: number }[] };
// The serve's own stream of which patient each owner is with, so a restart keeps it.
export const TRACKING_STREAM = "serve/tracking";
const Z = { recorded_at: 0, occurred_at: 0 };
type Pending = { task_id: string; reply: { task_id: string; line_id: string; action_id: string }; since: number; page: string; held: { bind: (t: EmrTarget) => Promise<void>; drop: (why: string) => void }[]; timer: NodeJS.Timeout };
export type HeardStatus = { seq: number; at: string; status: "accepted" | "processing" | "failed" | "completed"; waiting?: "arrival" | "join"; error?: string; task_id?: string; line_id?: string; note?: string };
const pageKey = (p: EmrTarget) => (p.admission_id || p.patient_id ? JSON.stringify(p) : "");

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function raw(req: IncomingMessage, limit: number): Promise<Buffer> {
  let n = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}
async function json(req: IncomingMessage): Promise<unknown> {
  const b = await raw(req, JSON_LIMIT);
  if (!b.length) return {};
  try { return JSON.parse(b.toString("utf8")); } catch { throw new HttpError(400, "body is not JSON"); }
}
function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; "));
  return r.data;
}
const jsonField = (v: string): unknown => { try { return JSON.parse(v); } catch { throw new HttpError(400, "presence: not JSON"); } };
const field = (f: FormData, k: string): string | undefined => { const v = f.get(k); return typeof v === "string" && v.length ? v : undefined; };

// The EMR-facing serve on port 4100: the strip reads tasks and posts words, audio and Stop; serve alone talks to the hospital door.
export async function startEmrServe(o: EmrServeOptions): Promise<EmrServe> {
  let runtime: EmrRuntime | null = null;
  const client = o.client ?? new ModelClient({ storeRoot: o.storeRoot, ...(o.mode ? { mode: o.mode } : {}), ...(o.recordingsDir ? { recordingsDir: o.recordingsDir } : {}), ...(o.recordModel === false ? { record: false } : {}), taskStateOf: (id) => runtime?.stateOf(id) ?? null });
  // Readings that are not Spark calls go on the run's ledger as their own rows, each naming its model and purpose.
  const ledger: ReadingLedger = (runId, row) => { try { client.appendRecord(runId, "reading.call", row); } catch { /* the ledger is closed */ } };
  const metaAsr = o.transcribe ?? (o.languageBias?.length ? biasedTranscriber(o.languageBias) : voiceTranscriber);
  // A switched-on realtime ear that cannot open a session stops the service, so no run claims an ear it did not use.
  const realtimeKey = o.realtimeKey ?? (() => loadKeys()["MODEL_API_KEY"] ?? "");
  if (o.asr === "meta-stream") {
    try { await probeRealtime({ key: realtimeKey, ...(o.realtimeSocket ? { socket: o.realtimeSocket } : {}), languageBias: o.languageBias ?? [] }); }
    catch (e) { throw new Error(`the Meta realtime ear was switched on but could not connect: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const streamAsr = o.asr === "stream" ? o.streamAsr ?? sherpaStreamAsr({ modelDir: o.local?.streamDir ?? "", sherpaDir: o.local?.sherpaDir, ...(o.local?.threads ? { threads: o.local.threads } : {}) }) : null;
  // A switch that was asked for and cannot load stops the service, so a run never claims a local ear it did not use.
  if (o.asr === "stream" && !streamAsr) throw new Error("the streaming ear was switched on but its model or library did not load");
  let base: SecondEar | undefined;
  if (o.ears === "parakeet") {
    const p = parakeetEar({ modelDir: o.local?.parakeetDir ?? "", sherpaDir: o.local?.sherpaDir, ledger, ...(o.local?.threads ? { threads: o.local.threads } : {}) });
    if (!p) throw new Error("the Parakeet second ear was switched on but its model or library did not load");
    base = p;
  } else base = o.ears === "off" ? undefined : typeof o.ears === "function" ? o.ears : o.ears === "spark" ? sparkEar(client) : o.runtime?.secondEar;
  // With a local first ear, Voice Transcribe reads every line that writes a number as well, so Meta still reads each number before it is written.
  const secondEar = base && streamAsr ? allEars([base, transcriberEar(metaAsr, { ledger })]) : base;
  const streaming = !!streamAsr || o.asr === "meta-stream";
  // The strip reads frames from here: present only when a streaming ear is on, so an older strip or a chunk-only serve keeps posting chunks.
  const footprint = { first_ear: streamAsr ? streamAsr.model : o.asr === "meta-stream" ? META_STREAM_MODEL : "meta:muse-voice-transcribe-1.0", second_ear: typeof o.ears === "string" ? o.ears : base ? "given" : "off", meta_reading_on_numbers: !!(base && streamAsr), frames: streaming ? { route: "/tasks/listen/stream", parts: true, frame_ms: FRAME_MS, rate: 16_000, idle_ms: o.framesIdleMs ?? FRAME_IDLE_MS } : null };
  // The patient each owner's agent is with over time: the page's patient when it changes, a spoken name, or an arrival it opened, ordered by when it was asked for.
  const tracked = new Map<string, Track>();
  const trackOf = (owner: string): Track => { let t = tracked.get(owner); if (!t) { t = { page: "", history: [] }; tracked.set(owner, t); } return t; };
  const place = (owner: string, target: EmrTarget | null, since: number) => {
    const h = trackOf(owner).history;
    const at = h.findIndex((x) => x.since > since);
    h.splice(at < 0 ? h.length : at, 0, { target, since });
    if (h.length > 50) h.shift();
  };
  const trackStream = openStream(o.storeRoot, TRACKING_STREAM, { writer: true });
  for (const e of trackStream.records()) {
    const x = e.payload as { owner?: string; target?: EmrTarget | null; since?: number; page?: string };
    if (!x.owner) continue;
    if (e.record_type === "track.moved" && typeof x.since === "number") place(x.owner, x.target ?? null, x.since);
    if (e.record_type === "track.page" && typeof x.page === "string") trackOf(x.owner).page = x.page;
  }
  const moveTo = (owner: string, target: EmrTarget | null, since: number) => {
    trackStream.append("track.moved", { owner, target, since }, Z);
    place(owner, target, since);
  };
  // The patient in effect when the words were captured, so a late upload never takes a patient chosen after it was said.
  const subjectAt = (owner: string, at: number): EmrTarget | null => [...(tracked.get(owner)?.history ?? [])].reverse().find((x) => x.since <= at)?.target ?? null;
  const current = (owner: string): EmrTarget | null => tracked.get(owner)?.history.at(-1)?.target ?? null;
  // An emergency phrase opens a pending arrival; speech captured after it is held until the record is confirmed, then bound to it.
  const pending = new Map<string, Pending>();
  const arrivals = new Map<string, { reply: Pending["reply"]; at: number }>();
  const statuses = new Map<string, Map<number, HeardStatus>>();
  const setStatus = (owner: string, session: string, seq: number, st: Omit<HeardStatus, "seq" | "at">) => {
    const key = `${owner}\u0000${session}`;
    let m = statuses.get(key);
    if (!m) { m = new Map(); statuses.set(key, m); if (statuses.size > 200) statuses.delete(statuses.keys().next().value!); }
    m.set(seq, { seq, at: new Date().toISOString(), ...st });
    if (m.size > 100) m.delete(m.keys().next().value!);
  };
  const release = async (owner: string, target: EmrTarget | null, reason: string | null) => {
    const p = pending.get(owner);
    if (!p) return;
    clearTimeout(p.timer);
    // Lines that arrive while the held ones are bound join the same queue, so the order spoken is kept.
    while (p.held.length) {
      const h = p.held.shift()!;
      if (target) await h.bind(target).catch((e: unknown) => { o.log?.(`held line not bound: ${e instanceof Error ? e.message : String(e)}`); h.drop("not_bound"); });
      else h.drop(reason ?? "arrival_not_opened");
    }
    pending.delete(owner);
  };
  const onSubject = (owner: string, target: EmrTarget, by: "spoken" | "emergency" | "delegation", at?: string) => {
    // A task handed to this owner is background work: it never changes the patient the clinician is with.
    if (by === "delegation") return;
    const since = at && Number.isFinite(Date.parse(at)) ? Date.parse(at) : Date.now();
    moveTo(owner, target, since);
    if (by === "emergency") void release(owner, target, null);
  };
  const onArrivalFailed = (owner: string, taskId: string, reason: string) => { if (pending.get(owner)?.task_id === taskId) void release(owner, null, reason); };
  const prefs = o.preferences === false ? null : o.runtime?.preferences ?? new PreferenceMemory(o.storeRoot);
  const several = !streamAsr && (o.vtReadings ?? 1) > 1;
  // D30: the strip's signed heartbeats per strip session, and the owner's matched voice in each.
  const heartbeats = new Heartbeats();
  const clientOf = new Map<string, string>();
  const onOwnerVoice = (owner: string, sid: string | null) => { if (sid) heartbeats.ownerVoice(owner, clientOf.get(sid) ?? sid); };
  const rt = new EmrRuntime({ ...(o.runtime ?? {}), onOwnerVoice, storeRoot: o.storeRoot, client, port: o.port, ...(secondEar ? { secondEar } : {}), ...(several ? { secondOpinion: true } : {}), ...(o.releaseWhole ? { releaseWhole: true } : {}), ...(o.log ? { log: o.log } : {}), onSubject, onArrivalFailed, ...(o.emergencyClinicId ? { emergencyClinicId: o.emergencyClinicId } : {}), ...(prefs ? { preferences: prefs } : {}) });
  runtime = rt;
  rt.start();
  const transcribe = streamAsr ? streamAsr.transcribe : several ? parallelReadings(metaAsr, o.vtReadings!) : metaAsr;
  const origin = o.allowOrigin ?? "http://localhost:3311";
  // Each patient's listening session reports its utterances' statuses under the strip's own session id, and is present only while that strip session beats.
  const seqBase = new Map<string, number>();
  const listening = new ListenSessions(rt, { ...(o.listen ?? {}), heartbeat: (owner, sid) => heartbeats.present(owner, clientOf.get(sid) ?? sid), transcribe, ...(o.releaseWhole ? { releaseWhole: true } : {}), ...(o.staffHints?.length ? { staff: o.staffHints } : {}), ...(o.embed ? { embed: o.embed } : {}), onStatus: (owner, sid, seq, st) => setStatus(owner, clientOf.get(sid) ?? sid, seq + (seqBase.get(sid) ?? 0), st) });
  // Lines a frames stream finished, kept for the answer to its next part.
  const frameHeard = new Map<string, ListenUtterance[]>();
  const onHeard = (sid: string, us: ListenUtterance[]) => { const h = frameHeard.get(sid); if (h) h.push(...us); };
  const streamer = streamAsr ? new StreamListener(listening, streamAsr, { refuseFasterThanLive: o.listen?.replay === "refuse", onHeard })
    : o.asr === "meta-stream" ? new MetaStreamListener(listening, { key: realtimeKey, ...(o.realtimeSocket ? { socket: o.realtimeSocket } : {}), languageBias: o.languageBias ?? [], ledger, runOf: (id) => rt.task(id)?.run_id ?? null, refuseFasterThanLive: o.listen?.replay === "refuse", onHeard })
    : null;
  const wakeLog = join(o.storeRoot, "..", "wake.jsonl");
  // The patient each listening session started with keeps the session's own id, so a session that never moves reads as before.
  const firstSubject = new Map<string, string>();
  const sessionsSeen = new Set<string>();
  // The first chunk of a new session on a page with no patient starts with no patient when the one the agent is with was chosen long ago.
  const freshSession = (owner: string, session: string, page: EmrTarget, at: number) => {
    if (sessionsSeen.has(session)) return;
    sessionsSeen.add(session);
    if (sessionsSeen.size > 1000) sessionsSeen.delete(sessionsSeen.values().next().value!);
    const last = tracked.get(owner)?.history.at(-1);
    if (!pageKey(page) && last?.target && at - last.since > SUBJECT_KEEP_MS) moveTo(owner, null, at);
  };
  // A page with a patient moves the agent to it from the moment the words were captured; leaving a page keeps the patient it was with.
  const subjectFor = (owner: string, page: EmrTarget, at: number): EmrTarget | null => {
    const key = pageKey(page);
    const t = trackOf(owner);
    if (key !== t.page) { t.page = key; trackStream.append("track.page", { owner, page: key }, Z); if (key) moveTo(owner, page, at); }
    return subjectAt(owner, at);
  };
  // "hey Pisgah, emergency" opens one arrival; while it is pending a second phrase answers with the same arrival.
  const openArrival = async (owner: string, e: { text: string; spoken_at: string; source: "text" | "audio"; wake?: Record<string, unknown>; press?: boolean }) => {
    const p = pending.get(owner);
    if (p) return p.reply;
    // The device and the transcript can both hear one phrase, so a phrase within the window of the last one is that same arrival; a press is never heard twice.
    const said = Date.parse(e.spoken_at);
    const last = arrivals.get(owner);
    if (!e.press && last && Math.abs(said - last.at) < ARRIVAL_SAME_PHRASE_MS) return last.reply;
    const r = await rt.emergency(owner, { text: e.text, spoken_at: e.spoken_at, source: e.source, ...(e.wake ? { wake: e.wake } : {}), args: { unidentified_ref: unidentifiedRef(new Date(e.spoken_at)), reason: emergencyReason(e.text), ...(o.emergencyClinicId ? { clinic_id: o.emergencyClinicId } : {}) } });
    arrivals.set(owner, { reply: r, at: said });
    const v = rt.view(r.task_id);
    if (!v?.patient_id && !pending.has(owner)) {
      const wait = o.pendingMaxMs ?? PENDING_MAX_MS;
      const opened = Date.now();
      // An arrival whose write is still open has an outcome nobody knows yet, so its held words wait for it up to the longer bound.
      const expire = () => {
        const a = rt.view(r.task_id)?.actions.find((x) => x.action_id === r.action_id);
        const unsettled = !!a && (a.state === "sent" || a.state === "uncertain" || (a.state === "acknowledged" && !!a.awaiting_verification));
        const p = pending.get(owner);
        if (unsettled && p?.task_id === r.task_id && Date.now() - opened < PENDING_UNSETTLED_MAX_MS) { p.timer = setTimeout(expire, wait); p.timer.unref?.(); return; }
        void release(owner, null, "arrival_not_confirmed");
      };
      const timer = setTimeout(expire, wait);
      timer.unref?.();
      pending.set(owner, { task_id: r.task_id, reply: r, since: Date.parse(e.spoken_at), page: trackOf(owner).page, held: [], timer });
    }
    return r;
  };
  // One chunk on its way to the patient it belongs to; each patient gets its own listening session, so a line about one never joins audio heard about another.
  const toSubject = async (owner: string, session: string, seq: number, target: EmrTarget, wav: Uint8Array | null, arrived: number, wait: boolean, live: { captured_at?: number | undefined; presence?: LivenessMarker | undefined } = {}) => {
    const subjectKey = JSON.stringify(target);
    const first = firstSubject.get(session) ?? subjectKey;
    firstSubject.set(session, first);
    const sessionId = first === subjectKey ? session : `${session.slice(0, 60)}.${shortHash(subjectKey)}`;
    clientOf.set(sessionId, session);
    if (clientOf.size > 500) clientOf.delete(clientOf.keys().next().value!);
    try {
      const reply = wav ? await listening.chunk({ owner, target, session_id: sessionId, seq, wav, arrived_at: arrived, ...(live.captured_at ? { captured_at: live.captured_at } : {}), ...(live.presence ? { presence: live.presence } : {}) }, wait) : await listening.end({ owner, target, session_id: sessionId, seq, arrived_at: arrived }, wait);
      return { ...reply, session_id: session, tracking: target };
    } catch (e) {
      if (e instanceof ListenError) throw new HttpError(e.status, e.message);
      throw e;
    }
  };
  // A chunk with no patient anywhere is heard only for the emergency phrase and a known patient's name; its words are kept nowhere.
  const listenUntracked = async (owner: string, sessionId: string, seq: number, wav: Uint8Array, arrived: number, hint?: "emergency" | "after_wake"): Promise<unknown> => {
    let text = "";
    setStatus(owner, sessionId, seq, { status: "processing" });
    // The voiceprint is worked out beside the words, so a spoken acceptance is attributed like any other line.
    const print = o.embed ? printWav(o.embed, wav).catch(() => null) : null;
    try { text = afterWake((await transcribe(wav, [], `${sessionId}-${seq}`.slice(0, 64))).text); } catch (e) {
      if (!(e instanceof VoiceError)) throw e;
      o.log?.(`listen with no patient: the ear refused the audio (${e.code})`);
      const error = `Not heard: ${e.message.slice(0, 200)}`;
      setStatus(owner, sessionId, seq, { status: "failed", error });
      return { session_id: sessionId, seq, accepted: true, utterances: [], partial: null, errors: [error] };
    }
    const spokenAt = new Date(arrived).toISOString();
    // Just after the device heard the wake phrase, "emergency" alone at the start of the next words completes "hey Pisgah, emergency".
    const said = EMERGENCY_LINE.test(text) || (hint === "emergency" && emergencyHeardLoosely(text)) || (hint === "after_wake" && /^\W*emergency\b/i.test(text));
    o.log?.(`listen with no patient: ${hint ? `${hint === "emergency" ? "device heard emergency" : "just after the wake phrase"}, ` : ""}${text ? `${text.split(/\s+/).length} words` : "silence"}, phrase ${said ? "said" : "not said"}`);
    if (said && rt.kinds(owner).includes("open_unnamed_encounter")) {
      const r = await openArrival(owner, { text, spoken_at: spokenAt, source: "audio" });
      setStatus(owner, sessionId, seq, { status: "completed", task_id: r.task_id, line_id: r.line_id });
      return { session_id: sessionId, seq, accepted: true, utterances: [{ id: r.line_id, line_id: r.line_id, task_id: r.task_id, text, class: "instruction", classes: ["instruction"] }], partial: null, entry: "emergency" };
    }
    // "Accepted <task>" heard with no patient open reaches the one task handed to this owner that it names.
    const handed = text ? rt.delegationLine(owner, text, spokenAt, "audio", undefined, print ? await print : undefined) : null;
    if (handed) setStatus(owner, sessionId, seq, { status: "completed", task_id: handed.task_id, line_id: handed.line_id });
    if (handed) return { session_id: sessionId, seq, accepted: true, utterances: [{ id: handed.line_id, line_id: handed.line_id, task_id: handed.task_id, text, class: "instruction", classes: ["instruction"] }], partial: null, entry: "delegation" };
    const known = rt.openSubjects(owner).map((x) => ({ label: rt.task(x.task_id)?.label ?? "", target: x.target })).filter((k) => k.label);
    const moved = spokenPatient(text, known);
    if (moved) onSubject(owner, moved.target, "spoken", spokenAt);
    // Words that receive a new patient open the same pending arrival as the phrase, so the lines after them are bound to it.
    const newcomer = !moved && text ? await arrivalHeard(owner, text, spokenAt, "audio") : null;
    if (newcomer) {
      setStatus(owner, sessionId, seq, { status: "completed", task_id: newcomer.task_id, line_id: newcomer.line_id });
      return { session_id: sessionId, seq, accepted: true, utterances: [{ id: newcomer.line_id, line_id: newcomer.line_id, task_id: newcomer.task_id, text, class: "instruction", classes: ["instruction"] }], partial: null, entry: "arrival" };
    }
    setStatus(owner, sessionId, seq, { status: "completed", note: moved ? "moved to the patient named" : text ? "no patient open: not kept" : "nothing heard" });
    return { session_id: sessionId, seq, accepted: true, utterances: [], partial: null, no_patient: !moved, ...(moved ? { moved_to: moved.target } : {}) };
  };

  // The last few words heard with no patient, kept in memory only and briefly, so a greeting before the description is read with it.
  const before = new Map<string, { text: string; at: number }[]>();
  const arrivalHeard = async (owner: string, text: string, spokenAt: string, source: "text" | "audio") => {
    if (!rt.kinds(owner).includes(EMERGENCY_KIND) || pending.has(owner)) return null;
    const now = Date.now();
    const recent = (before.get(owner) ?? []).filter((x) => now - x.at < ARRIVAL_RECENT_MS);
    let r: Awaited<ReturnType<typeof gateArrival>>;
    try { r = await gateArrival(client, recent.map((x) => x.text), text, { run_id: `run-${shortHash("arrival", owner)}` }); } catch (e) {
      o.log?.(`arrival not decided: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
      return null;
    }
    o.log?.(`listen with no patient: arrival ${r.arrival ? "heard" : "not heard"} (${r.ms} ms, $${r.cost_usd.toFixed(4)})`);
    if (!r.arrival) { before.set(owner, [...recent, { text, at: now }].slice(-ARRIVAL_RECENT_LINES)); return null; }
    before.delete(owner);
    const opened = await openArrival(owner, { text: [...recent.map((x) => x.text), text].join(" ").slice(-300), spoken_at: spokenAt, source });
    // A name said in the same breath is held for the arrival like any naming line after it.
    if (identityFrom(text)) pending.get(owner)?.held.push({ bind: async (t) => { await rt.say({ owner, target: t, text, spoken_at: spokenAt, source }); }, drop: () => undefined });
    return opened;
  };

  // One enrolment passage from the clinician's own settings page: the voiceprint goes back to their browser and the audio is dropped here.
  const embedPassage = async (req: IncomingMessage): Promise<[number, unknown]> => {
    if (!o.embed) throw new HttpError(503, "the speaker model is not loaded on this agent service");
    const type = req.headers["content-type"] ?? "";
    if (!type.startsWith("audio/wav") && !type.startsWith("audio/x-wav")) throw new HttpError(415, "send the passage as audio/wav");
    const wav = new Uint8Array(await raw(req, AUDIO_LIMIT));
    const info = parseWav(wav);
    if (!info.ok) throw new HttpError(400, `audio: ${info.reason}`);
    if (info.durationMs < 3000) throw new HttpError(422, "The passage is too short; read the whole passage.");
    const print = await o.embed(wav);
    if (!print) throw new HttpError(422, "The recording could not be read; please record it again.");
    return [200, { embedding: print.vector, model: print.model, ms: print.ms }];
  };

  // One chunk of continuous listening; the answer says whether it finished an utterance and which line it became.
  const listen = async (req: IncomingMessage): Promise<[number, unknown]> => {
    const type = req.headers["content-type"] ?? "";
    if (!type.startsWith("multipart/form-data")) throw new HttpError(415, "send multipart/form-data with an audio part");
    const arrived = Date.now();
    const form = await new Response(new Uint8Array(await raw(req, AUDIO_LIMIT)), { headers: { "content-type": type } }).formData().catch(() => { throw new HttpError(400, "the multipart body could not be read"); });
    const audio = form.get("audio");
    // The strip's end-of-utterance marker carries no audio: speech stopped, so audio held at the cap is finished now.
    const ended = field(form, "end") === "1";
    if (!ended && (!audio || typeof audio === "string")) throw new HttpError(400, "audio: a WAV file part is required");
    const b = parse(ListenMeta, {
      owner: field(form, "owner"), session_id: field(form, "session_id"), seq: field(form, "seq"), ...(field(form, "hint") ? { hint: field(form, "hint") } : {}), ...(field(form, "captured_at") ? { captured_at: field(form, "captured_at") } : {}),
      ...(field(form, "presence") ? { presence: jsonField(field(form, "presence")!) } : {}),
      ...(field(form, "admissionId") ? { admissionId: field(form, "admissionId") } : {}), ...(field(form, "patientId") ? { patientId: field(form, "patientId") } : {})
    });
    const page = { ...(b.admissionId ? { admission_id: b.admissionId } : {}), ...(b.patientId ? { patient_id: b.patientId } : {}) };
    // The words belong to the moment they were captured, which the strip stamps; a missing or implausible stamp falls back to arrival.
    const at = b.captured_at !== undefined && b.captured_at <= arrived && b.captured_at >= arrived - 10 * 60_000 ? b.captured_at : arrived;
    const wav = audio && typeof audio !== "string" && !ended ? new Uint8Array(await audio.arrayBuffer()) : null;
    const wait = new URL(req.url ?? "/", "http://serve").searchParams.get("wait") === "1";
    // Words this strip session's frames already carried are not heard again from its chunk, whatever the strip decided.
    if (wav && b.captured_at !== undefined && b.hint !== "emergency") {
      const info = parseWav(wav);
      if (info.ok && coveredShare(b.owner, b.session_id, b.captured_at, b.captured_at + info.durationMs) >= 0.8) return [202, { session_id: b.session_id, seq: b.seq, accepted: true, utterances: [], partial: null, heard_by_frames: true }];
    }
    const held = pending.get(b.owner);
    if (held && b.hint !== "emergency" && at >= held.since && pageKey(page) === held.page) {
      setStatus(b.owner, b.session_id, b.seq, { status: "accepted", waiting: "arrival" });
      held.held.push({
        bind: async (target) => { setStatus(b.owner, b.session_id, b.seq, { status: "processing" }); await toSubject(b.owner, b.session_id, b.seq, target, wav, arrived, false, { captured_at: b.captured_at, presence: b.presence }); },
        drop: (why) => setStatus(b.owner, b.session_id, b.seq, { status: "failed", error: `Not kept: the arrival was not opened (${why}).` })
      });
      return [202, { session_id: b.session_id, seq: b.seq, accepted: true, utterances: [], partial: null, pending: true, task_id: held.task_id }];
    }
    freshSession(b.owner, b.session_id, page, at);
    const target = subjectFor(b.owner, page, at);
    if (!wav && !target) return [202, { session_id: b.session_id, seq: b.seq, accepted: true, utterances: [], partial: null }];
    if (wav && (!target || b.hint === "emergency")) { setStatus(b.owner, b.session_id, b.seq, { status: "accepted" }); return [202, await listenUntracked(b.owner, b.session_id, b.seq, wav, at, b.hint)]; }
    if (!target) throw new HttpError(400, "no patient for this marker");
    return [202, await toSubject(b.owner, b.session_id, b.seq, target, wav, arrived, wait, { captured_at: b.captured_at, presence: b.presence })];
  };

  // One frames stream from the strip: its numbered parts, the patient it is hearing about, and the listening session that patient's lines go to.
  type Frames = { owner: string; client: string; key: string; k: number; target: EmrTarget; sid: string; sids: string[]; next: number; rate: number; bytes: number; idle: NodeJS.Timeout | null; busy: Promise<unknown>; opened_at: number };
  const frames = new Map<string, Frames>();
  const frameCount = new Map<string, number>();
  const pcmOf = (bytes: Buffer): Float32Array => { const x = new Float32Array(bytes.length / 2); for (let i = 0; i < x.length; i++) x[i] = bytes.readInt16LE(i * 2) / 32768; return x; };
  // Each patient a frames stream hears about gets its own listening session, reported under the strip's session id with its own numbers.
  const frameSid = (f: Pick<Frames, "client" | "key" | "owner">, k: number): string => {
    const sid = `${f.key}.${k}`;
    const n = (frameCount.get(f.client) ?? 0) + 1;
    frameCount.set(f.client, n);
    if (frameCount.size > 500) frameCount.delete(frameCount.keys().next().value!);
    clientOf.set(sid, f.client);
    seqBase.set(sid, FRAME_SEQ_BASE + n * 10_000);
    if (seqBase.size > 500) seqBase.delete(seqBase.keys().next().value!);
    frameHeard.set(sid, []);
    return sid;
  };
  const heardOf = (f: Frames): { utterances: ListenUtterance[]; errors: string[] } => {
    const utterances: ListenUtterance[] = [], errors: string[] = [];
    for (const sid of f.sids) { utterances.push(...(frameHeard.get(sid)?.splice(0) ?? [])); const r = listening.unreportedOf(sid); utterances.push(...r.utterances); errors.push(...r.errors); }
    return { utterances, errors };
  };
  // Streams ended without the strip's last part, kept briefly so the strip's next part learns where the kept audio ended.
  const endedKept = new Map<string, number | null>();
  // When each strip session's frames were captured and heard, so a chunk of the same words is never heard twice.
  const frameCover = new Map<string, { from: number; to: number }[]>();
  const coverKey = (owner: string, client: string) => `${owner}\u0000${client}`;
  const addCover = (owner: string, client: string, from: number, to: number) => {
    const k = coverKey(owner, client);
    const list = frameCover.get(k) ?? [];
    const last = list.at(-1);
    if (last && from <= last.to + 50 && from >= last.from) last.to = Math.max(last.to, to); else list.push({ from, to });
    if (list.length > 200) list.shift();
    frameCover.set(k, list);
    if (frameCover.size > 500) frameCover.delete(frameCover.keys().next().value!);
  };
  // A line dropped when a stream was ended for the strip was not heard, so its chunk is.
  const trimCover = (owner: string, client: string, keptUntil: number | null, since: number) => {
    const list = frameCover.get(coverKey(owner, client));
    if (!list || keptUntil === null) return;
    for (const c of list) if (c.to > keptUntil && c.to >= since) c.to = Math.max(c.from, keptUntil);
  };
  const coveredShare = (owner: string, client: string, from: number, to: number): number => {
    const list = frameCover.get(coverKey(owner, client)) ?? [];
    const got = list.reduce((n, c) => n + Math.max(0, Math.min(c.to, to) - Math.max(c.from, from)), 0);
    return to > from ? got / (to - from) : 0;
  };
  // A stream the strip ended is finished whole; one ended for it (a fallback, a gap, idle) drops the line still being said, which the strip sends as a chunk.
  const endFrames = async (f: Frames, dropOpen = false): Promise<{ utterances: ListenUtterance[]; errors: string[]; padded_ms?: number; resent_ms?: number; trimmed_ms?: number; failed?: string | null; kept_until: number | null }> => {
    const mapKey = `${f.owner}\u0000${f.key}`;
    if (frames.get(mapKey) === f) frames.delete(mapKey);
    if (f.idle) clearTimeout(f.idle);
    const ended = await streamer!.end(f.key, { dropOpen });
    if (dropOpen) { endedKept.set(mapKey, ended.kept_until); if (endedKept.size > 200) endedKept.delete(endedKept.keys().next().value!); trimCover(f.owner, f.client, ended.kept_until, f.opened_at); }
    const later = heardOf(f);
    for (const sid of f.sids) frameHeard.delete(sid);
    return { ...ended, utterances: [...later.utterances, ...ended.utterances], errors: [...later.errors, ...ended.errors] };
  };
  const listenFrames = async (req: IncomingMessage, q: URLSearchParams): Promise<[number, unknown]> => {
    const b = parse(FramesMeta, { owner: q.get("owner") ?? undefined, session_id: q.get("session_id") ?? undefined, rate: q.get("rate") ?? undefined, stream: q.get("stream") ?? undefined, part: q.get("part") ?? undefined, ...(q.get("last") ? { last: q.get("last") } : {}), ...(q.get("t") ? { t: q.get("t") } : {}), ...(q.get("admissionId") ? { admissionId: q.get("admissionId") } : {}), ...(q.get("patientId") ? { patientId: q.get("patientId") } : {}) });
    const body = await raw(req, FRAME_PART_LIMIT);
    if (body.length % 2) throw new HttpError(400, "audio: a part carries whole 16-bit samples");
    const key = `${b.session_id}.f${b.stream}`;
    const mapKey = `${b.owner}\u0000${key}`;
    const page = { ...(b.admissionId ? { admission_id: b.admissionId } : {}), ...(b.patientId ? { patient_id: b.patientId } : {}) };
    const now = Date.now();
    // The part is bound to when its first frame was captured, as a chunk is bound to when its words began.
    const at = b.t !== undefined && b.t <= now + 5_000 && b.t >= now - 10 * 60_000 ? b.t : now;
    let f = frames.get(mapKey);
    if (!f && b.part > 0) return [409, { restart: true, reason: "unknown_stream", stream: b.stream, part: b.part, kept_until: endedKept.get(mapKey) ?? null }];
    if (f && b.part < f.next) return [200, { duplicate: true, stream: b.stream, part: b.part }];
    if (f && f.rate !== b.rate) throw new HttpError(400, "rate: a stream keeps the rate it opened with");
    // Speech after an emergency phrase on this page is held for the arrival on the chunk path, and a page with no patient is heard there too.
    const held = pending.get(b.owner);
    const fallback = held && at >= held.since && pageKey(page) === held.page ? "arrival_pending" : null;
    if (!f) {
      if (fallback) return [409, { fallback: "chunks", reason: fallback, stream: b.stream, part: b.part }];
      freshSession(b.owner, b.session_id, page, at);
      const target = subjectFor(b.owner, page, at);
      if (!target) return [409, { fallback: "chunks", reason: "no_patient", stream: b.stream, part: b.part }];
      // The stream key answers to the strip's session, so a per-session check made by stream key finds the strip's own record.
      clientOf.set(key, b.session_id);
      const nf: Frames = { owner: b.owner, client: b.session_id, key, k: 0, target, sid: "", sids: [], next: 0, rate: b.rate, bytes: 0, idle: null, busy: Promise.resolve(), opened_at: at };
      nf.sid = frameSid(nf, 0);
      nf.sids.push(nf.sid);
      frames.set(mapKey, nf);
      try { await streamer!.open({ owner: b.owner, target, session_id: key, listen_sid: nf.sid, rate: b.rate }); } catch (e) {
        frames.delete(mapKey);
        throw e instanceof VoiceError ? new HttpError(502, e.message) : new HttpError(409, e instanceof Error ? e.message : "already streaming");
      }
      f = nf;
    }
    const cur = f;
    if (b.part > cur.next) { const ended = await endFrames(cur, true); return [409, { restart: true, reason: "part_missing", stream: b.stream, part: b.part, ...ended }]; }
    const work = cur.busy.then(async (): Promise<[number, unknown]> => {
      if (fallback) { const ended = await endFrames(cur, true); return [409, { fallback: "chunks", reason: fallback, stream: b.stream, part: b.part, ...ended }]; }
      const target = subjectFor(b.owner, page, at);
      if (!target) { const ended = await endFrames(cur, true); return [409, { fallback: "chunks", reason: "no_patient", stream: b.stream, part: b.part, ...ended }]; }
      // A move to another patient opens that patient's listening session; the line being said keeps the patient it began with.
      if (JSON.stringify(target) !== JSON.stringify(cur.target)) {
        cur.k += 1;
        cur.sid = frameSid(cur, cur.k);
        cur.sids.push(cur.sid);
        cur.target = target;
        await streamer!.retarget(cur.key, { target, listen_sid: cur.sid });
      }
      try { if (body.length) streamer!.feed(cur.key, pcmOf(body), at); } catch (e) {
        const ended = await endFrames(cur, true);
        if (e instanceof StreamRefused) return [409, { error: e.message, refused: true, stream: b.stream, part: b.part, ...ended }];
        if (e instanceof MetaStreamFailed) return [502, { error: e.message, stream: b.stream, part: b.part, ...ended }];
        throw e;
      }
      cur.bytes += body.length;
      cur.next = b.part + 1;
      if (body.length) addCover(b.owner, b.session_id, at, at + (body.length / 2 / cur.rate) * 1000);
      if (cur.idle) clearTimeout(cur.idle);
      const audioMs = Math.round((cur.bytes / 2 / cur.rate) * 1000);
      if (b.last) {
        const ended = await endFrames(cur);
        if (typeof ended.failed === "string") return [502, { error: ended.failed, stream: b.stream, part: b.part, ...ended }];
        return [202, { session_id: b.session_id, accepted: true, stream: b.stream, part: b.part, last: true, tracking: target, audio_ms: audioMs, ...ended }];
      }
      cur.idle = setTimeout(() => { void endFrames(cur, true).catch(() => undefined); }, o.framesIdleMs ?? FRAME_IDLE_MS);
      cur.idle.unref?.();
      const h = heardOf(cur);
      return [202, { session_id: b.session_id, accepted: true, stream: b.stream, part: b.part, tracking: target, audio_ms: audioMs, utterances: h.utterances, partial: null, ...(h.errors.length ? { errors: h.errors } : {}) }];
    });
    cur.busy = work.catch(() => undefined);
    return work;
  };

  // Audio frames as they are spoken, 16-bit mono PCM in the request body, read while it arrives; the answer lists the lines once the body ends.
  const listenStream = async (req: IncomingMessage): Promise<[number, unknown]> => {
    if (!streamer) throw new HttpError(404, "the streaming ear is off on this agent service");
    const type = req.headers["content-type"] ?? "";
    if (!type.startsWith("audio/pcm")) throw new HttpError(415, "send audio/pcm, 16-bit little-endian mono");
    const q = new URL(req.url ?? "/", "http://serve").searchParams;
    if (q.has("part")) return listenFrames(req, q);
    const b = parse(StreamMeta, { owner: q.get("owner") ?? undefined, session_id: q.get("session_id") ?? undefined, rate: q.get("rate") ?? undefined, ...(q.get("admissionId") ? { admissionId: q.get("admissionId") } : {}), ...(q.get("patientId") ? { patientId: q.get("patientId") } : {}) });
    const page = { ...(b.admissionId ? { admission_id: b.admissionId } : {}), ...(b.patientId ? { patient_id: b.patientId } : {}) };
    // The stream keeps the patient it opened with; moving to another patient opens another stream.
    const opened = Date.now();
    freshSession(b.owner, b.session_id, page, opened);
    const target = subjectFor(b.owner, page, opened);
    if (!target) throw new HttpError(400, "the streaming ear needs a patient open");
    try { await streamer.open({ owner: b.owner, target, session_id: b.session_id, rate: b.rate }); } catch (e) { throw e instanceof VoiceError ? new HttpError(502, e.message) : new HttpError(409, e instanceof Error ? e.message : "already streaming"); }
    let n = 0;
    let odd: number | null = null;
    let failed: unknown = null;
    // A refused or failed stream is still read to its end and dropped, so the answer reaches a sender that is still uploading.
    for await (const c of req) {
      const buf = c as Buffer;
      n += buf.length;
      // Past the limit the connection is closed rather than read on.
      if (n > STREAM_LIMIT) { failed = new HttpError(413, "the stream ran past its limit"); break; }
      if (failed) continue;
      try {
        const bytes: Buffer = odd === null ? buf : Buffer.concat([Buffer.from([odd]), buf]);
        const whole: number = bytes.length - (bytes.length % 2);
        odd = whole < bytes.length ? bytes[bytes.length - 1]! : null;
        const x = new Float32Array(whole / 2);
        for (let i = 0; i < x.length; i++) x[i] = bytes.readInt16LE(i * 2) / 32768;
        streamer.feed(b.session_id, x);
      } catch (e) { failed = e instanceof StreamRefused ? new HttpError(409, e.message) : e instanceof MetaStreamFailed ? new HttpError(502, e.message) : e; }
    }
    // The stream always closes, so what was heard before a failure is still handed on and the session can open again.
    const ended = await streamer.end(b.session_id);
    if (failed) throw failed;
    // A realtime session the endpoint refused mid-way fails the request, so a stream it stopped hearing is never answered as heard.
    if ("failed" in ended && typeof ended.failed === "string") throw new HttpError(502, ended.failed);
    return [202, { session_id: b.session_id, accepted: true, tracking: target, audio_ms: Math.round((n / 2 / b.rate) * 1000), ...ended }];
  };

  const sayAudio = async (req: IncomingMessage): Promise<[number, unknown]> => {
    const type = req.headers["content-type"] ?? "";
    if (!type.startsWith("multipart/form-data")) throw new HttpError(415, "send multipart/form-data with an audio part");
    const form = await new Response(new Uint8Array(await raw(req, AUDIO_LIMIT)), { headers: { "content-type": type } }).formData().catch(() => { throw new HttpError(400, "the multipart body could not be read"); });
    const audio = form.get("audio");
    if (!audio || typeof audio === "string") throw new HttpError(400, "audio: a WAV file part is required");
    const b = parse(AudioMeta, {
      owner: field(form, "owner"), ...(field(form, "admissionId") ? { admissionId: field(form, "admissionId") } : {}), ...(field(form, "patientId") ? { patientId: field(form, "patientId") } : {})
    });
    const arrived = Date.now();
    const target = { ...(b.admissionId ? { admission_id: b.admissionId } : {}), ...(b.patientId ? { patient_id: b.patientId } : {}) };
    const ctx = await rt.port.resolve(target, { owner: b.owner, evidence: "transcript:audio-context", spoken_at: new Date(arrived).toISOString() });
    const wav = new Uint8Array(await audio.arrayBuffer());
    const keywords = buildKeywords({ vitals: VITALS_KEYWORDS, wards: [], documents: ctx.keywords, staff: o.staffHints ?? [], beds: [] });
    let heard: FinalTranscript;
    let keywordsDropped = false;
    try {
      heard = await transcribe(wav, keywords, `s-${arrived.toString(36)}`);
    } catch (e) {
      if (!(e instanceof VoiceError)) throw e;
      // A hint the service refuses must not lose the clinician's words, so one retry goes without hints.
      if (e.status !== 400 || !keywords.length) throw new HttpError(e.code === "bad_wav" ? 400 : 502, e.message);
      keywordsDropped = true;
      try { heard = await transcribe(wav, [], `s-${arrived.toString(36)}-nk`); } catch (e2) { throw new HttpError(502, e2 instanceof Error ? e2.message : "transcription failed"); }
    }
    if (!heard.text) return [200, { task_id: null, line_id: null, transcript: "", audio_ms: heard.audio_ms, cost_usd: heard.cost_usd }];
    const spoken = new Date(arrived - heard.audio_ms).toISOString();
    const v = vitalsVocabulary(cleanTranscript(heard.text));
    const voiceprint = o.embed ? await printWav(o.embed, wav).catch(() => null) : undefined;
    const r = await rt.say({ owner: b.owner, target: { admission_id: ctx.admission_id }, text: v.text, source: "audio", spoken_at: spoken, audio: { audio_ms: heard.audio_ms, cost_usd: heard.cost_usd, session_id: heard.session_id }, clip: wav, rewrites: v.rewrites, ...(voiceprint !== undefined ? { voiceprint } : {}) });
    return [202, { ...r, transcript: v.text, audio_ms: heard.audio_ms, cost_usd: heard.cost_usd, keywords_dropped: keywordsDropped }];
  };

  const route = async (req: IncomingMessage): Promise<[number, unknown]> => {
    const url = new URL(req.url ?? "/", "http://serve");
    const parts = url.pathname.split("/").filter(Boolean);
    const m = req.method ?? "GET";
    if (m === "GET" && url.pathname === "/health") return [200, { ok: true, mode: client.mode, tasks: rt.taskIds().length, refused: rt.port.refusedCount(), kws: !!o.kwsDir, speaker_model: !!o.embed, ears: footprint, presence: o.listen?.presence ?? "observed" }];
    if (m === "POST" && url.pathname === "/wake") {
      const b = parse(Wake, await json(req));
      mkdirSync(dirname(wakeLog), { recursive: true });
      appendFileSync(wakeLog, `${JSON.stringify({ at: new Date().toISOString(), ...b })}\n`);
      return [200, { logged: true }];
    }
    if (m === "GET" && url.pathname === "/wake") return [200, wakeSummary(wakeLog, url.searchParams.get("owner"))];
    if (m === "POST" && url.pathname === "/voice/embed") return embedPassage(req);
    if (parts[0] === "preferences") {
      if (!prefs) throw new HttpError(404, "preference memory is off");
      // What one clinician may see: their own preferences and shared ward or hospital rules, each with its source and scope.
      if (parts.length === 1 && m === "GET") {
        const owner = parse(Owner, url.searchParams.get("owner") ?? "");
        return [200, prefs.visibleTo(owner).map((p) => ({ pref_id: p.pref_id, state: p.state, text: describePref(p), scope: describeScope(p.scope), source: describeSource(p.source, owner), field: p.field, item_kind: p.item_kind, value: p.value, decided: p.decided }))];
      }
      if (parts.length === 2 && parts[1] === "external" && m === "POST") {
        const b = parse(External, await json(req));
        try {
          const p = prefs.external({ by: b.owner, text: b.text, scope: b.scope, ward: b.ward ?? null });
          return [201, { pref_id: p.pref_id, text: describePref(p), scope: describeScope(p.scope), source: describeSource(p.source, b.owner) }];
        } catch (e) { if (e instanceof PreferenceError) throw new HttpError(422, e.message); throw e; }
      }
      throw new HttpError(404, "no such route");
    }
    if (parts[0] !== "tasks") throw new HttpError(404, "no such route");
    if (parts.length === 1 && m === "GET") {
      const owner = url.searchParams.get("owner");
      if (!owner) throw new HttpError(400, "owner is required");
      return [200, rt.views(parse(Owner, owner))];
    }
    if (parts.length === 2 && parts[1] === "say" && m === "POST") {
      const b = parse(Say, await json(req));
      const page = { ...(b.admissionId ? { admission_id: b.admissionId } : {}), ...(b.patientId ? { patient_id: b.patientId } : {}) };
      // A typed line with no patient open goes to the patient the agent is with, and opens an arrival on the emergency phrase.
      const target = hasTarget(b) ? page : current(b.owner);
      const at = b.spokenAt ?? new Date().toISOString();
      if (!target && EMERGENCY_LINE.test(b.text)) return [202, await openArrival(b.owner, { text: b.text, spoken_at: at, source: "text" })];
      // A typed line while an arrival is pending is held and bound to it once the record is confirmed.
      const held = target ? null : pending.get(b.owner);
      if (held) {
        held.held.push({ bind: async (t) => { await rt.say({ owner: b.owner, target: t, text: b.text, spoken_at: at, ...(b.via ? { via: b.via } : {}) }); }, drop: (why) => o.log?.(`typed line not kept: the arrival was not opened (${why})`) });
        return [202, { pending: true, task_id: held.task_id }];
      }
      // A spoken acceptance of a task handed to this owner needs no patient open: the task names its own.
      const handed = target ? null : rt.delegationLine(b.owner, b.text, at, "text");
      if (handed) return [202, handed];
      const arrived = target ? null : await arrivalHeard(b.owner, b.text, at, "text");
      if (arrived) return [202, { ...arrived, entry: "arrival" }];
      if (!target) throw new HttpError(400, "No patient is open yet; describe the patient arriving, say hey Pisgah, emergency, or open a patient");
      return [202, await rt.say({ owner: b.owner, target, text: b.text, ...(b.spokenAt ? { spoken_at: b.spokenAt } : {}), ...(b.via ? { via: b.via } : {}) })];
    }
    // Opening a patient's page starts the owner's task with no words, so the agent watches that record for them.
    if (parts.length === 2 && parts[1] === "watch" && m === "POST") {
      const b = parse(Open, await json(req));
      return [200, await rt.open(b.owner, { ...(b.admissionId ? { admission_id: b.admissionId } : {}), ...(b.patientId ? { patient_id: b.patientId } : {}) })];
    }
    if (parts.length === 2 && parts[1] === "say-audio" && m === "POST") return sayAudio(req);
    // "hey Pisgah, emergency" spotted on the device: an unnamed arrival with no patient open, its line the evidence.
    if (parts.length === 2 && parts[1] === "emergency" && m === "POST") {
      const b = parse(Emergency, await json(req));
      if (b.press) return [202, await openArrival(b.owner, { text: EMERGENCY_PRESS, spoken_at: b.spokenAt, source: "text", wake: { ...(b.wake ?? {}), press: true }, press: true })];
      return [202, await openArrival(b.owner, { text: b.text, spoken_at: b.spokenAt, source: "audio", ...(b.wake ? { wake: b.wake } : {}) })];
    }
    if (parts.length === 2 && parts[1] === "tracking" && m === "GET") {
      const owner = parse(Owner, url.searchParams.get("owner") ?? "");
      return [200, { owner, target: current(owner), ...(pending.has(owner) ? { pending: pending.get(owner)!.task_id } : {}) }];
    }
    // Each utterance's status in one listening session: accepted, processing, failed or completed, with the error when it failed.
    if (parts.length === 2 && parts[1] === "listen" && m === "GET") {
      const owner = parse(Owner, url.searchParams.get("owner") ?? "");
      const session = parse(SessionId, url.searchParams.get("session_id") ?? "");
      return [200, { session_id: session, utterances: [...(statuses.get(`${owner}\u0000${session}`)?.values() ?? [])].sort((x, y) => x.seq - y.seq) }];
    }
    if (parts.length === 2 && parts[1] === "listen" && m === "POST") return listen(req);
    // D30 presence: a strip session takes a key, then beats with it while its tab is visible and its microphone is live.
    if (parts.length === 3 && parts[1] === "presence" && parts[2] === "open" && m === "POST") {
      const b = parse(PresenceOpen, await json(req));
      return [200, { session_id: b.session_id, ...heartbeats.open(b.owner, b.session_id) }];
    }
    if (parts.length === 3 && parts[1] === "presence" && parts[2] === "beat" && m === "POST") {
      const b = parse(PresenceBeat, await json(req));
      const r = heartbeats.beat(b);
      return r.ok ? [200, { session_id: b.session_id, present: r.present, ...(r.reason ? { reason: r.reason } : {}) }] : [409, { session_id: b.session_id, error: r.reason, reopen: r.reason === "unknown_session" }];
    }
    if (parts.length === 3 && parts[1] === "listen" && parts[2] === "stream" && m === "POST") return listenStream(req);
    const id = parts[1] ?? "";
    const task = rt.task(id);
    if (parts.length === 2 && m === "GET") { if (!task) throw new HttpError(404, "unknown task"); return [200, rt.view(id)]; }
    if (parts.length === 3 && parts[2] === "say" && m === "POST") {
      const b = parse(FollowUp, await json(req));
      if (!task) throw new HttpError(404, "unknown task");
      if (b.task_id !== undefined && b.task_id !== id) throw new HttpError(400, "task_id does not match the path");
      if (b.owner !== undefined && b.owner !== task.owner) throw new HttpError(403, "the task belongs to another owner");
      return [202, await rt.say({ owner: task.owner, target: task.admission_id ? { admission_id: task.admission_id } : { ...(task.patient_id ? { patient_id: task.patient_id } : {}) }, text: b.text, ...(b.spokenAt ? { spoken_at: b.spokenAt } : {}), ...(b.via ? { via: b.via } : {}) }, id)];
    }
    if (parts.length === 3 && parts[2] === "resume" && m === "POST") {
      const b = parse(Interrupt, await json(req));
      if (!task) throw new HttpError(404, "unknown task");
      if (b.owner !== undefined && b.owner !== task.owner) throw new HttpError(403, "the task belongs to another owner");
      return [200, { task_id: id, resumed: rt.resumeTask(id, task.owner), state: rt.stateOf(id) }];
    }
    // The strip's scope buttons for a candidate preference; only the task's owner may choose.
    if (parts.length === 5 && parts[2] === "preferences" && parts[4] === "scope" && m === "POST") {
      const b = parse(Scope, await json(req));
      if (!task) throw new HttpError(404, "unknown task");
      if (b.owner !== task.owner) throw new HttpError(403, "the task belongs to another owner");
      const r = rt.scopePreference(id, b.owner, parts[3]!, b.scope);
      return [r.ok ? 200 : r.reason === "unknown_preference" ? 404 : r.reason === "not_yours" ? 403 : 409, r];
    }
    if (parts.length === 3 && parts[2] === "interrupt" && m === "POST") {
      const b = parse(Interrupt, await json(req));
      if (!task) throw new HttpError(404, "unknown task");
      if (b.owner !== undefined && b.owner !== task.owner) throw new HttpError(403, "the task belongs to another owner");
      return [200, { task_id: id, ...rt.interrupt(id, task.owner)!, state: rt.stateOf(id) }];
    }
    throw new HttpError(404, "no such route");
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    // One fixed origin on every answer, so a browser on any other page is refused by its own CORS check.
    const cors: Record<string, string> = { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Content-Type", "access-control-max-age": "600" };
    // CORS only hides answers, so a request from another page, or a host name that is not this loopback service, is refused before it runs.
    const from = req.headers.origin;
    if (from !== undefined && from !== origin) { send(res, 403, { error: "this origin may not call the agent service" }, cors); return; }
    if (!loopbackHost(req.headers.host)) { send(res, 421, { error: "this host name does not serve the agent" }, cors); return; }
    if (req.method === "POST" && JSON_ROUTES.test(new URL(req.url ?? "/", "http://serve").pathname) && !(req.headers["content-type"] ?? "").startsWith("application/json")) { send(res, 415, { error: "send application/json" }, cors); return; }
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    const kws = /^\/kws\/([^/?]+)/.exec(req.url ?? "");
    if (req.method === "GET" && kws) {
      const name = kws[1]!;
      const file = o.kwsDir && KWS_FILE.test(name) ? join(o.kwsDir, name) : null;
      if (!file || !existsSync(file)) { send(res, 404, { error: "no such file" }, cors); return; }
      res.writeHead(200, { ...cors, "content-type": KWS_TYPES[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream", "cache-control": "max-age=86400" });
      res.end(readFileSync(file));
      return;
    }
    route(req).then(([status, payload]) => send(res, status, payload, cors)).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : e instanceof EmrPortError ? (e.status && e.status < 500 ? 422 : 502) : 500;
      if (status >= 500) o.log?.(`serve error: ${e instanceof Error ? e.message : String(e)}`);
      send(res, status, { error: e instanceof Error ? e.message.slice(0, 300) : "error", ...(e instanceof EmrPortError ? { code: e.code } : {}) }, cors);
    });
  };
  const hosts = o.hosts ?? ["127.0.0.1"];
  const servers: Server[] = [];
  const urls: string[] = [];
  for (const host of hosts) {
    const server = createServer(handler);
    await new Promise<void>((r, j) => { server.once("error", j); server.listen(o.listenPort ?? EMR_SERVE_PORT, host, () => r()); });
    servers.push(server);
    const addr = server.address();
    if (typeof addr === "object" && addr) urls.push(`http://${host.includes(":") ? `[${host}]` : host}:${addr.port}`);
  }
  return {
    urls, url: urls[0] ?? "", runtime: rt, client, listening, preferences: prefs,
    close: async () => {
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      await Promise.all([...frames.values()].map((f) => endFrames(f).catch(() => undefined)));
      listening.close();
      await rt.stop();
      if (prefs && !o.runtime?.preferences) prefs.close();
      trackStream.close();
      if (!o.client) client.close();
    }
  };
}

// The routes that take a JSON body; requiring the JSON type makes a browser preflight them.
const JSON_ROUTES = /^\/tasks\/(?:say|watch|[^/]+\/(?:say|resume|interrupt))$/;
// Only a loopback host name reaches the service, which stops a rebinding page from talking to it under its own name.
export function loopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host);
}

// p50 and p90 of the wake latencies the strip measured, overall and per keyword.
export function wakeSummary(file: string, owner: string | null): Record<string, unknown> {
  const rows = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { owner: string; keyword: string; latency_ms: number }) : [];
  const mine = rows.filter((r) => !owner || r.owner === owner);
  const q = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!; };
  const of = (xs: number[]) => ({ n: xs.length, p50_ms: q(xs, 50), p90_ms: q(xs, 90), max_ms: xs.length ? Math.max(...xs) : null });
  return { all: of(mine.map((r) => r.latency_ms)), wake: of(mine.filter((r) => r.keyword === "wake").map((r) => r.latency_ms)), emergency: of(mine.filter((r) => r.keyword === "emergency").map((r) => r.latency_ms)) };
}

function send(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string>): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}
