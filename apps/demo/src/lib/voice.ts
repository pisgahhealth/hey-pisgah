import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildKeywords, parseWav, transcribeWav, VoiceError } from "@hey-pisgah/voice";
import { DISCOVERY_DIR } from "./discovery.js";
import { humanize } from "./labels.js";
import { readJson } from "./paths.js";

export const MAX_WAV_BYTES = 2_000_000;
export const MAX_AUDIO_MS = 60_000;
const WAV_TYPES = new Set(["audio/wav", "audio/wave", "audio/x-wav", "audio/vnd.wave"]);
const NOT_STAFF = new Set(["agent", "insurer", "sponsor"]);

export type TranscribeDeps = { mode: string | undefined; key: () => string | null; keywords: () => string[]; fetch?: typeof fetch; sessionId?: () => string };

// Reads only MODEL_API_KEY from the keys file; the value stays on the server.
export function metaKey(file: string = join(homedir(), ".hey-pisgah.env")): string | null {
  if (!existsSync(file)) return null;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?MODEL_API_KEY\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    const v = m[1]!.replace(/^(["'])(.*)\1$/, "$2");
    return v || null;
  }
  return null;
}

// The hints the demo can name: its wards, documents, staff roles and approvers, and the beds on its cases.
export function vocabularyKeywords(root: string): string[] {
  const data = join(root, "packages", "hospital", "src", "data");
  const req = readJson(join(data, "ward-requirements.r1.json")) as { wards: { display_name: string; approver: { display_name: string } }[] };
  const v1 = readJson(join(data, "v1.json")) as { documents: { document_id: string }[]; actors: string[] };
  const beds = new Set<string>();
  for (const dir of [join(root, ...DISCOVERY_DIR), join(root, "packages", "cases", "fixtures", "demo")]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      const bed = (readJson(join(dir, f)) as { initial_state?: { bed?: unknown } }).initial_state?.bed;
      if (typeof bed === "string") beds.add(`bed ${bed}`);
    }
  }
  return buildKeywords({
    wards: req.wards.map((w) => w.display_name),
    documents: v1.documents.map((d) => humanize(d.document_id).replace(/^Hmo\b/, "HMO")),
    staff: [...v1.actors.filter((a) => !NOT_STAFF.has(a)).map((a) => humanize(a).toLowerCase()), ...req.wards.map((w) => w.approver.display_name)],
    beds: [...beds].sort()
  });
}

function fail(status: number, error: string, detail: string): Response {
  return Response.json({ error, detail }, { status });
}

// Checks mode, then the WAV, then the key, and forwards only a valid recording in live mode.
export async function handleTranscribe(req: Request, deps: TranscribeDeps): Promise<Response> {
  if (deps.mode !== "live") return fail(501, "not_live", "Voice needs HEY_PISGAH_MODE=live. Type the goal instead.");
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!WAV_TYPES.has(type)) return fail(415, "not_wav", "Send the recording as audio/wav.");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_WAV_BYTES) return fail(413, "too_large", "Recordings are capped at 60 seconds.");
  const wav = new Uint8Array(await req.arrayBuffer());
  if (wav.length > MAX_WAV_BYTES) return fail(413, "too_large", "Recordings are capped at 60 seconds.");
  const info = parseWav(wav);
  if (!info.ok) return fail(415, "not_wav", `Not a mono 16-bit WAV at 16 or 24 kHz: ${info.reason}.`);
  if (info.durationMs > MAX_AUDIO_MS) return fail(413, "too_long", "Recordings are capped at 60 seconds.");
  const key = deps.key();
  if (!key) return fail(503, "no_key", "No Voice Transcribe key is set, so nothing was sent. Type the goal instead.");
  try {
    const t = await transcribeWav({ wav, keywords: deps.keywords(), key, sessionId: deps.sessionId?.() ?? `demo-${Date.now().toString(36)}`, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    return Response.json(t, { status: 200 });
  } catch (e) {
    if (e instanceof VoiceError) return fail(502, e.code, e.message);
    return fail(502, "upstream", "Transcription failed.");
  }
}
