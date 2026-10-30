import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { loadKeys, ModelClient, type Mode } from "@hey-pisgah/model";
import { VITALS_KEYWORDS, VoiceError, buildKeywords, cleanTranscript, transcribeWav, vitalsVocabulary, type FinalTranscript } from "@hey-pisgah/voice";
import { sparkEar, type SecondEar } from "./ears.js";
import { EmrRuntime, type EmrRuntimeOptions } from "./runtime.js";
import { ListenError, ListenSessions, type ListenOptions, type Transcriber } from "./listen.js";
import { parseWav } from "@hey-pisgah/voice";
import type { Embedder } from "./speaker.js";
import { EmrId, EmrPortError, type EmrPort, type EmrTarget } from "./port.js";
import { EMERGENCY_LINE, emergencyHeardLoosely, emergencyReason, spokenPatient, unidentifiedRef } from "./entry.js";
import { shortHash } from "../ids.js";
import { PreferenceError, PreferenceMemory, SCOPE_KINDS, describePref, describeScope, describeSource } from "./preferences.js";

export const EMR_SERVE_PORT = 4100;

// The default ear: Voice Transcribe REST with the key from the keys file, read only when audio arrives.
export const voiceTranscriber: Transcriber = (wav, keywords, sessionId) =>
  transcribeWav({ wav, keywords, key: loadKeys()["MODEL_API_KEY"] ?? "", sessionId });

export type EmrServeOptions = {
  storeRoot: string; port: EmrPort;
  client?: ModelClient; mode?: Mode; recordingsDir?: string;
  // False keeps model requests and replies out of the recordings folder, so no heard words are written there.
  recordModel?: boolean;
  // The second ear for vitals from audio: Spark audio input by default, off, or one given by a test.
  ears?: "spark" | "off" | SecondEar;
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
const ListenMeta = z.strictObject({
  owner: Owner, admissionId: EmrId.optional(), patientId: EmrId.optional(),
  session_id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/), seq: z.coerce.number().int().min(0).max(1_000_000),
  // Set when the device spotted "emergency" with no wake before it, so this audio is checked by transcript for the phrase.
  hint: z.enum(["emergency", "after_wake"]).optional(),
  // When the strip's recorder began this chunk, and its liveness marker for the replay defence.
  captured_at: z.coerce.number().int().positive().optional(),
  presence: z.strictObject({ visible: z.boolean(), mic_live: z.boolean(), input_age_ms: z.number().min(0).nullable() }).optional()
});
const Emergency = z.strictObject({ owner: Owner, text: z.string().min(1).max(300).default("hey Pisgah, emergency"), spokenAt: z.iso.datetime({ offset: true }), wake: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional() });
// One wake measured in the browser: phrase end to the visible armed state, on the page's clock.
const Wake = z.strictObject({ owner: Owner, keyword: z.enum(["wake", "emergency"]), phrase_end_ms: z.number(), armed_ms: z.number(), latency_ms: z.number().min(0).max(60_000), spotter: z.string().max(80), page: z.string().max(200).optional(), audio_ms: z.number().optional() });
const KWS_FILE = /^[A-Za-z0-9_.-]{1,120}$/;
const KWS_TYPES: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".txt": "text/plain", ".json": "application/json" };
const Interrupt = z.strictObject({ owner: Owner.optional(), task_id: z.string().optional() });
const Scope = z.strictObject({ owner: Owner, scope: z.enum([...SCOPE_KINDS, "no"]) });
// A hospital rule given as text by a person, under the scope they name; a patient scope comes only from a correction or a spoken rule.
const External = z.strictObject({ owner: Owner, text: z.string().min(3).max(600), scope: z.enum(["me", "ward", "everyone"]), ward: z.string().min(1).max(120).optional() });
const JSON_LIMIT = 64 * 1024;
const AUDIO_LIMIT = 8 * 1024 * 1024;

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
  const secondEar = o.ears === "off" ? undefined : typeof o.ears === "function" ? o.ears : o.ears === "spark" ? sparkEar(client) : o.runtime?.secondEar;
  // The patient each owner's agent is with: the page's patient when it changes, a spoken name, or an arrival it opened, the latest winning.
  const tracked = new Map<string, { target: EmrTarget | null; page: string }>();
  const onSubject = (owner: string, target: EmrTarget) => { tracked.set(owner, { target, page: tracked.get(owner)?.page ?? "" }); };
  const prefs = o.preferences === false ? null : o.runtime?.preferences ?? new PreferenceMemory(o.storeRoot);
  const rt = new EmrRuntime({ ...(o.runtime ?? {}), storeRoot: o.storeRoot, client, port: o.port, ...(secondEar ? { secondEar } : {}), ...(o.log ? { log: o.log } : {}), onSubject, ...(o.emergencyClinicId ? { emergencyClinicId: o.emergencyClinicId } : {}), ...(prefs ? { preferences: prefs } : {}) });
  runtime = rt;
  rt.start();
  const transcribe = o.transcribe ?? voiceTranscriber;
  const origin = o.allowOrigin ?? "http://localhost:3311";
  const listening = new ListenSessions(rt, { ...(o.listen ?? {}), transcribe, ...(o.embed ? { embed: o.embed } : {}) });
  const wakeLog = join(o.storeRoot, "..", "wake.jsonl");
  // The patient each listening session started with keeps the session's own id, so a session that never moves reads as before.
  const firstSubject = new Map<string, string>();
  const seenSessions = new Set<string>();
  const subjectFor = (owner: string, page: EmrTarget, session?: string): EmrTarget | null => {
    const key = JSON.stringify(page);
    // A new listening session starts from the page in front of the clinician, not a patient from an earlier session.
    const fresh = session !== undefined && !firstSubject.has(session) && !seenSessions.has(session);
    if (session !== undefined) seenSessions.add(session);
    const t = fresh ? { target: null, page: "" } : tracked.get(owner) ?? { target: null, page: "" };
    // Opening another patient's page moves the agent to that patient; leaving a page keeps the patient it was with.
    if (key !== t.page) { t.page = key; if (page.admission_id || page.patient_id) t.target = page; }
    tracked.set(owner, t);
    return t.target;
  };
  // A chunk with no patient anywhere is heard only for the emergency phrase and a known patient's name; its words are kept nowhere.
  const listenUntracked = async (owner: string, sessionId: string, seq: number, wav: Uint8Array, arrived: number, hint?: "emergency" | "after_wake"): Promise<unknown> => {
    let text = "";
    try { text = (await transcribe(wav, [], `${sessionId}-${seq}`.slice(0, 64))).text; } catch (e) { if (!(e instanceof VoiceError)) throw e; o.log?.(`listen with no patient: the ear refused the audio (${e.code})`); }
    const spokenAt = new Date(arrived).toISOString();
    // Just after the device heard the wake phrase, "emergency" alone at the start of the next words completes "hey Pisgah, emergency".
    const said = EMERGENCY_LINE.test(text) || (hint === "emergency" && emergencyHeardLoosely(text)) || (hint === "after_wake" && /^\W*emergency\b/i.test(text));
    o.log?.(`listen with no patient: ${hint ? `${hint === "emergency" ? "device heard emergency" : "just after the wake phrase"}, ` : ""}${text ? `${text.split(/\s+/).length} words` : "silence"}, phrase ${said ? "said" : "not said"}`);
    if (said && rt.kinds(owner).includes("open_unnamed_encounter")) {
      const r = await rt.emergency(owner, { text, spoken_at: spokenAt, args: { unidentified_ref: unidentifiedRef(new Date(arrived)), reason: emergencyReason(text), ...(o.emergencyClinicId ? { clinic_id: o.emergencyClinicId } : {}) } });
      return { session_id: sessionId, seq, accepted: true, utterances: [{ id: r.line_id, line_id: r.line_id, task_id: r.task_id, text, class: "instruction", classes: ["instruction"] }], partial: null, entry: "emergency" };
    }
    // "Accepted <task>" heard with no patient open reaches the one task handed to this owner that it names.
    const handed = text ? rt.delegationLine(owner, text, spokenAt, "audio") : null;
    if (handed) return { session_id: sessionId, seq, accepted: true, utterances: [{ id: handed.line_id, line_id: handed.line_id, task_id: handed.task_id, text, class: "instruction", classes: ["instruction"] }], partial: null, entry: "delegation" };
    const known = rt.openSubjects(owner).map((x) => ({ label: rt.task(x.task_id)?.label ?? "", target: x.target })).filter((k) => k.label);
    const moved = spokenPatient(text, known);
    if (moved) onSubject(owner, moved.target);
    return { session_id: sessionId, seq, accepted: true, utterances: [], partial: null, no_patient: !moved, ...(moved ? { moved_to: moved.target } : {}) };
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
    if (!audio || typeof audio === "string") throw new HttpError(400, "audio: a WAV file part is required");
    const b = parse(ListenMeta, {
      owner: field(form, "owner"), session_id: field(form, "session_id"), seq: field(form, "seq"), ...(field(form, "hint") ? { hint: field(form, "hint") } : {}),
      ...(field(form, "captured_at") ? { captured_at: field(form, "captured_at") } : {}), ...(field(form, "presence") ? { presence: jsonField(field(form, "presence")!) } : {}),
      ...(field(form, "admissionId") ? { admissionId: field(form, "admissionId") } : {}), ...(field(form, "patientId") ? { patientId: field(form, "patientId") } : {})
    });
    const page = { ...(b.admissionId ? { admission_id: b.admissionId } : {}), ...(b.patientId ? { patient_id: b.patientId } : {}) };
    const target = subjectFor(b.owner, page, b.session_id);
    const wav = new Uint8Array(await audio.arrayBuffer());
    if (!target || b.hint === "emergency") return [202, await listenUntracked(b.owner, b.session_id, b.seq, wav, arrived, b.hint)];
    // Each patient gets its own listening session, so a line about one patient never joins audio heard about another.
    const subjectKey = JSON.stringify(target);
    const first = firstSubject.get(b.session_id) ?? subjectKey;
    firstSubject.set(b.session_id, first);
    const sessionId = first === subjectKey ? b.session_id : `${b.session_id.slice(0, 60)}.${shortHash(subjectKey)}`;
    try {
      const wait = new URL(req.url ?? "/", "http://serve").searchParams.get("wait") === "1";
      const reply = await listening.chunk({ owner: b.owner, target, session_id: sessionId, seq: b.seq, wav, arrived_at: arrived, ...(b.captured_at ? { captured_at: b.captured_at } : {}), ...(b.presence ? { presence: b.presence } : {}) }, wait);
      return [202, { ...reply, session_id: b.session_id, tracking: target }];
    } catch (e) {
      if (e instanceof ListenError) throw new HttpError(e.status, e.message);
      throw e;
    }
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
    const keywords = buildKeywords({ vitals: VITALS_KEYWORDS, wards: [], documents: ctx.keywords, staff: [], beds: [] });
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
    const voiceprint = o.embed ? await o.embed(wav).catch(() => null) : undefined;
    const r = await rt.say({ owner: b.owner, target: { admission_id: ctx.admission_id }, text: v.text, source: "audio", spoken_at: spoken, audio: { audio_ms: heard.audio_ms, cost_usd: heard.cost_usd, session_id: heard.session_id }, clip: wav, rewrites: v.rewrites, ...(voiceprint !== undefined ? { voiceprint } : {}) });
    return [202, { ...r, transcript: v.text, audio_ms: heard.audio_ms, cost_usd: heard.cost_usd, keywords_dropped: keywordsDropped }];
  };

  const route = async (req: IncomingMessage): Promise<[number, unknown]> => {
    const url = new URL(req.url ?? "/", "http://serve");
    const parts = url.pathname.split("/").filter(Boolean);
    const m = req.method ?? "GET";
    if (m === "GET" && url.pathname === "/health") return [200, { ok: true, mode: client.mode, tasks: rt.taskIds().length, refused: rt.port.refusedCount(), kws: !!o.kwsDir, speaker_model: !!o.embed }];
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
      const target = hasTarget(b) ? page : subjectFor(b.owner, page);
      // A spoken acceptance of a task handed to this owner needs no patient open: the task names its own.
      const handed = target ? null : rt.delegationLine(b.owner, b.text, b.spokenAt ?? new Date().toISOString(), "text");
      if (handed) return [202, handed];
      if (!target) {
        if (!EMERGENCY_LINE.test(b.text)) throw new HttpError(400, "No patient is open yet; say hey Pisgah, emergency, or open a patient");
        const at = b.spokenAt ?? new Date().toISOString();
        return [202, await rt.emergency(b.owner, { text: b.text, spoken_at: at, source: "text", args: { unidentified_ref: unidentifiedRef(new Date(at)), reason: emergencyReason(b.text), ...(o.emergencyClinicId ? { clinic_id: o.emergencyClinicId } : {}) } })];
      }
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
      const r = await rt.emergency(b.owner, { text: b.text, spoken_at: b.spokenAt, source: "audio", ...(b.wake ? { wake: b.wake } : {}), args: { unidentified_ref: unidentifiedRef(new Date(b.spokenAt)), reason: emergencyReason(b.text), ...(o.emergencyClinicId ? { clinic_id: o.emergencyClinicId } : {}) } });
      return [202, r];
    }
    if (parts.length === 2 && parts[1] === "tracking" && m === "GET") {
      const owner = parse(Owner, url.searchParams.get("owner") ?? "");
      return [200, { owner, target: tracked.get(owner)?.target ?? null }];
    }
    if (parts.length === 2 && parts[1] === "listen" && m === "POST") return listen(req);
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
      listening.close();
      await rt.stop();
      if (prefs && !o.runtime?.preferences) prefs.close();
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
