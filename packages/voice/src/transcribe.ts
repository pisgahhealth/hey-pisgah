import { parseWav } from "./wav.js";

export const ASR_URL = "https://api.meta.ai/v1/asr/transcribe";
export const ASR_MODEL = "muse-voice-transcribe-1.0";
export const USD_PER_AUDIO_HOUR = 0.18;

// The only shape this package hands on: a finished transcript, never a partial one.
// `alternates` holds other readings of the same audio taken at the same time, when the caller asked for several.
export type FinalTranscript = { final: true; text: string; audio_ms: number; session_id: string; cost_usd: number; alternates?: string[] };
export type VoiceErrorCode = "bad_wav" | "no_key" | "upstream" | "bad_reply" | "timeout";

export class VoiceError extends Error {
  constructor(readonly code: VoiceErrorCode, message: string, readonly status: number | null = null) {
    super(message);
    this.name = "VoiceError";
  }
}

export type TranscribeOptions = {
  wav: Uint8Array; keywords: readonly string[]; key: string; sessionId: string;
  fetch?: typeof fetch; timeoutMs?: number; url?: string;
  // Languages to steer recognition toward; omitted from the request when empty, so the default request is unchanged.
  languageBias?: readonly string[];
};

// The language hint switch: HEY_PISGAH_LANGUAGE_BIAS=1 steers both the REST and the realtime ear toward English, off by default until measured.
export const languageBiasFrom = (v: string | undefined): string[] => (v?.trim() === "1" ? ["English"] : []);

// The `request` part of the multipart body, as the REST reference names it.
export function requestPart(keywords: readonly string[], languageBias: readonly string[] = []): { model: string; audioEncoding: "WAV"; mode: "PUSH_TO_TALK"; keywords: string[]; languageBias?: string[] } {
  return { model: ASR_MODEL, audioEncoding: "WAV", mode: "PUSH_TO_TALK", keywords: [...keywords], ...(languageBias.length ? { languageBias: [...languageBias] } : {}) };
}

// Sends one push-to-talk WAV to Voice Transcribe REST and returns its buffered, finished transcript.
export async function transcribeWav(o: TranscribeOptions): Promise<FinalTranscript> {
  const { turns: _turns, ...r } = await transcribeWithTurns(o);
  return r;
}

// The same call, keeping the reply's turns array for research that compares whole replies.
export async function transcribeWithTurns(o: TranscribeOptions): Promise<FinalTranscript & { turns: unknown[] }> {
  const info = parseWav(o.wav);
  if (!info.ok) throw new VoiceError("bad_wav", info.reason);
  if (!o.key) throw new VoiceError("no_key", "no Voice Transcribe key");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(o.sessionId)) throw new RangeError("session ids are 1 to 64 letters, digits, dots, dashes or underscores");
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify(requestPart(o.keywords, o.languageBias))], { type: "application/json" }));
  form.append("audio", new Blob([new Uint8Array(o.wav)], { type: "audio/wav" }), "goal.wav");
  const url = `${o.url ?? ASR_URL}?sessionId=${encodeURIComponent(o.sessionId)}`;
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, {
      method: "POST", headers: { Authorization: `Bearer ${o.key}`, Accept: "application/json" }, body: form, signal: AbortSignal.timeout(o.timeoutMs ?? 20_000)
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new VoiceError(timedOut ? "timeout" : "upstream", timedOut ? "Voice Transcribe did not answer in time" : "Voice Transcribe could not be reached");
  }
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    const type = errorType(body);
    throw new VoiceError("upstream", `Voice Transcribe answered ${res.status}${type ? ` (${type})` : ""}`, res.status);
  }
  const r = body as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r["transcript"] !== "string" || typeof r["audioDurationMs"] !== "number" || !(r["audioDurationMs"] >= 0) || typeof r["sessionId"] !== "string" || !Array.isArray(r["turns"])) {
    throw new VoiceError("bad_reply", "Voice Transcribe replied with an unexpected shape", res.status);
  }
  const ms = r["audioDurationMs"];
  return { final: true, text: r["transcript"].trim(), audio_ms: ms, session_id: r["sessionId"], cost_usd: Math.round((ms / 3_600_000) * USD_PER_AUDIO_HOUR * 1e6) / 1e6, turns: r["turns"] as unknown[] };
}

function errorType(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const e = (body as Record<string, unknown>)["error"];
  const t = e && typeof e === "object" ? (e as Record<string, unknown>)["type"] : (body as Record<string, unknown>)["type"];
  return typeof t === "string" && /^[a-z0-9_]{1,40}$/i.test(t) ? t : null;
}
