import { describe, expect, it } from "vitest";
import { buildKeywords } from "../src/keywords.js";
import { transcribeWav, VoiceError } from "../src/transcribe.js";
import { encodeWav } from "../src/wav.js";

type Sent = { url: string; auth: string | null; request: unknown; audioType: string; audioBytes: number };

function fakeMeta(status: number, reply: unknown) {
  const sent: Sent[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const form = init!.body as FormData;
    const req = form.get("request") as Blob;
    const audio = form.get("audio") as Blob;
    sent.push({ url: String(url), auth: new Headers(init!.headers).get("authorization"), request: JSON.parse(await req.text()), audioType: audio.type, audioBytes: audio.size });
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, sent };
}

const wav = encodeWav(new Float32Array(16_000), 16_000);

describe("transcribeWav", () => {
  it("sends the request part with keywords and returns only a finished transcript", async () => {
    const { f, sent } = fakeMeta(200, { sessionId: "s-1", transcript: " Prepare the discharge summary for bed A-23. ", audioDurationMs: 1000, turns: [] });
    const r = await transcribeWav({ wav, keywords: ["Ward A", "bed A-23"], key: "k-test", sessionId: "s-1", fetch: f });
    expect(r).toEqual({ final: true, text: "Prepare the discharge summary for bed A-23.", audio_ms: 1000, session_id: "s-1", cost_usd: 0.18 / 3600 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.meta.ai/v1/asr/transcribe?sessionId=s-1");
    expect(sent[0]!.auth).toBe("Bearer k-test");
    expect(sent[0]!.request).toEqual({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "PUSH_TO_TALK", keywords: ["Ward A", "bed A-23"] });
    expect(sent[0]!.audioType).toBe("audio/wav");
    expect(sent[0]!.audioBytes).toBe(wav.length);
  });

  it("refuses a non-WAV body before any call", async () => {
    const { f, sent } = fakeMeta(200, {});
    await expect(transcribeWav({ wav: new Uint8Array(100), keywords: [], key: "k", sessionId: "s", fetch: f })).rejects.toMatchObject({ code: "bad_wav" });
    expect(sent).toHaveLength(0);
  });

  it("refuses an empty key before any call", async () => {
    const { f, sent } = fakeMeta(200, {});
    await expect(transcribeWav({ wav, keywords: [], key: "", sessionId: "s", fetch: f })).rejects.toMatchObject({ code: "no_key" });
    expect(sent).toHaveLength(0);
  });

  it("reports an upstream status and error type without the body", async () => {
    const { f } = fakeMeta(400, { error: { type: "invalid_request_error", message: "secret detail" } });
    const e = await transcribeWav({ wav, keywords: [], key: "k", sessionId: "s", fetch: f }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(VoiceError);
    expect((e as VoiceError).message).toBe("Voice Transcribe answered 400 (invalid_request_error)");
    expect((e as VoiceError).status).toBe(400);
  });

  it("refuses a reply with no transcript, so nothing unfinished reaches the caller", async () => {
    const { f } = fakeMeta(200, { type: "transcript", transcript: "prepare the", final: false });
    await expect(transcribeWav({ wav, keywords: [], key: "k", sessionId: "s", fetch: f })).rejects.toMatchObject({ code: "bad_reply" });
  });
});

describe("buildKeywords", () => {
  it("orders, trims, deduplicates and caps the hints", () => {
    const k = buildKeywords({ wards: ["Ward A", " ward  a "], documents: ["Discharge summary"], staff: ["nurse", ""], beds: ["bed A-1", "bed A-2", "x".repeat(61), "bad\u0007"] }, 4);
    expect(k).toEqual(["Ward A", "Discharge summary", "nurse", "bed A-1"]);
  });
});
