import { repoRoot } from "../../../src/lib/paths.js";
import { handleTranscribe, metaKey, vocabularyKeywords } from "../../../src/lib/voice.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let keywords: string[] | null = null;

// Forwards one push-to-talk WAV to Voice Transcribe in live mode and answers with its finished transcript.
export function POST(req: Request): Promise<Response> {
  return handleTranscribe(req, {
    mode: process.env["HEY_PISGAH_MODE"],
    key: () => metaKey(),
    keywords: () => (keywords ??= vocabularyKeywords(repoRoot()))
  });
}

export function GET(): Response {
  return Response.json({ error: "method_not_allowed", detail: "POST a WAV recording." }, { status: 405, headers: { allow: "POST" } });
}
