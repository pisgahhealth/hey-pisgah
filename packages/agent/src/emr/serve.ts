import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { loadKeys, ModelClient, type Mode } from "@hey-pisgah/model";
import { VoiceError, buildKeywords, transcribeWav, type FinalTranscript } from "@hey-pisgah/voice";
import { EmrRuntime, type EmrRuntimeOptions } from "./runtime.js";
import { EmrId, EmrPortError, type EmrPort } from "./port.js";

export const EMR_SERVE_PORT = 4100;
export type Transcriber = (wav: Uint8Array, keywords: readonly string[], sessionId: string) => Promise<FinalTranscript>;

// The default ear: Voice Transcribe REST with the key from the keys file, read only when audio arrives.
export const voiceTranscriber: Transcriber = (wav, keywords, sessionId) =>
  transcribeWav({ wav, keywords, key: loadKeys()["MODEL_API_KEY"] ?? "", sessionId });

export type EmrServeOptions = {
  storeRoot: string; port: EmrPort;
  client?: ModelClient; mode?: Mode; recordingsDir?: string;
  listenPort?: number; hosts?: readonly string[];
  // The one browser origin allowed to call serve, the EMR page that hosts the strip.
  allowOrigin?: string;
  transcribe?: Transcriber;
  runtime?: Omit<EmrRuntimeOptions, "storeRoot" | "client" | "port">;
  log?: (line: string) => void;
};
export type EmrServe = { urls: string[]; url: string; runtime: EmrRuntime; client: ModelClient; close: () => Promise<void> };

const Owner = z.string().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/);
const hasTarget = (b: { admissionId?: string | undefined; patientId?: string | undefined }) => b.admissionId !== undefined || b.patientId !== undefined;
const AudioMeta = z.strictObject({ owner: Owner, admissionId: EmrId.optional(), patientId: EmrId.optional() }).refine(hasTarget, "admissionId or patientId is required");
const Say = z.strictObject({ owner: Owner, admissionId: EmrId.optional(), patientId: EmrId.optional(), text: z.string().min(1).max(1000), spokenAt: z.iso.datetime({ offset: true }).optional() })
  .refine(hasTarget, "admissionId or patientId is required");
const FollowUp = z.strictObject({ text: z.string().min(1).max(1000), task_id: z.string().optional(), owner: Owner.optional(), spokenAt: z.iso.datetime({ offset: true }).optional() });
const Interrupt = z.strictObject({ owner: Owner.optional(), task_id: z.string().optional() });
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
const field = (f: FormData, k: string): string | undefined => { const v = f.get(k); return typeof v === "string" && v.length ? v : undefined; };

// The EMR-facing serve on port 4100: the strip reads tasks and posts words, audio and Stop; serve alone talks to the hospital door.
export async function startEmrServe(o: EmrServeOptions): Promise<EmrServe> {
  let runtime: EmrRuntime | null = null;
  const client = o.client ?? new ModelClient({ storeRoot: o.storeRoot, ...(o.mode ? { mode: o.mode } : {}), ...(o.recordingsDir ? { recordingsDir: o.recordingsDir } : {}), taskStateOf: (id) => runtime?.stateOf(id) ?? null });
  const rt = new EmrRuntime({ ...(o.runtime ?? {}), storeRoot: o.storeRoot, client, port: o.port, ...(o.log ? { log: o.log } : {}) });
  runtime = rt;
  rt.start();
  const transcribe = o.transcribe ?? voiceTranscriber;
  const origin = o.allowOrigin ?? "http://localhost:3311";

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
    const keywords = buildKeywords({ wards: [], documents: ctx.keywords, staff: [], beds: [] });
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
    const r = await rt.say({ owner: b.owner, target: { admission_id: ctx.admission_id }, text: heard.text, source: "audio", spoken_at: spoken, audio: { audio_ms: heard.audio_ms, cost_usd: heard.cost_usd, session_id: heard.session_id } });
    return [202, { ...r, transcript: heard.text, audio_ms: heard.audio_ms, cost_usd: heard.cost_usd, keywords_dropped: keywordsDropped }];
  };

  const route = async (req: IncomingMessage): Promise<[number, unknown]> => {
    const url = new URL(req.url ?? "/", "http://serve");
    const parts = url.pathname.split("/").filter(Boolean);
    const m = req.method ?? "GET";
    if (m === "GET" && url.pathname === "/health") return [200, { ok: true, mode: client.mode, tasks: rt.taskIds().length, refused: rt.port.refusedCount() }];
    if (parts[0] !== "tasks") throw new HttpError(404, "no such route");
    if (parts.length === 1 && m === "GET") {
      const owner = url.searchParams.get("owner");
      if (!owner) throw new HttpError(400, "owner is required");
      return [200, rt.views(parse(Owner, owner))];
    }
    if (parts.length === 2 && parts[1] === "say" && m === "POST") {
      const b = parse(Say, await json(req));
      const target = { ...(b.admissionId ? { admission_id: b.admissionId } : {}), ...(b.patientId ? { patient_id: b.patientId } : {}) };
      return [202, await rt.say({ owner: b.owner, target, text: b.text, ...(b.spokenAt ? { spoken_at: b.spokenAt } : {}) })];
    }
    if (parts.length === 2 && parts[1] === "say-audio" && m === "POST") return sayAudio(req);
    const id = parts[1] ?? "";
    const task = rt.task(id);
    if (parts.length === 2 && m === "GET") { if (!task) throw new HttpError(404, "unknown task"); return [200, rt.view(id)]; }
    if (parts.length === 3 && parts[2] === "say" && m === "POST") {
      const b = parse(FollowUp, await json(req));
      if (!task) throw new HttpError(404, "unknown task");
      if (b.task_id !== undefined && b.task_id !== id) throw new HttpError(400, "task_id does not match the path");
      if (b.owner !== undefined && b.owner !== task.owner) throw new HttpError(403, "the task belongs to another owner");
      return [202, await rt.say({ owner: task.owner, target: { admission_id: task.admission_id }, text: b.text, ...(b.spokenAt ? { spoken_at: b.spokenAt } : {}) }, id)];
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
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
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
    urls, url: urls[0] ?? "", runtime: rt, client,
    close: async () => {
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      await rt.stop();
      if (!o.client) client.close();
    }
  };
}

function send(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string>): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}
