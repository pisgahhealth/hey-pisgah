import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav } from "@hey-pisgah/voice";
import { describe, expect, it } from "vitest";
import { handleTranscribe, metaKey, vocabularyKeywords, type TranscribeDeps } from "../src/lib/voice.js";
import { root } from "./render";

function spy(reply: unknown = { sessionId: "s", transcript: "Prepare the discharge summary for bed A-23.", audioDurationMs: 1000, turns: [] }) {
  const calls: { request: unknown }[] = [];
  const f = (async (_u: string | URL | Request, init?: RequestInit) => {
    calls.push({ request: JSON.parse(await ((init!.body as FormData).get("request") as Blob).text()) });
    return Response.json(reply);
  }) as typeof fetch;
  return { f, calls };
}

let keyReads = 0;
const deps = (over: Partial<TranscribeDeps> & { f: typeof fetch }): TranscribeDeps => ({
  mode: "live", key: () => { keyReads++; return "k-test"; }, keywords: () => ["Ward A", "bed A-23"], fetch: over.f, sessionId: () => "t-1", ...over
});
const wavReq = (body: BodyInit, type = "audio/wav") => new Request("http://demo/api/transcribe", { method: "POST", headers: { "content-type": type }, body });
const wav = encodeWav(new Float32Array(16_000), 16_000);

describe("/api/transcribe", () => {
  it("returns 501 in replay and mock mode, never reads the key and never forwards", async () => {
    for (const mode of ["replay", "mock", undefined]) {
      const { f, calls } = spy();
      keyReads = 0;
      const r = await handleTranscribe(wavReq(wav), deps({ f, mode }));
      expect(r.status).toBe(501);
      expect(calls).toHaveLength(0);
      expect(keyReads).toBe(0);
    }
  });

  it("never forwards without a key", async () => {
    const { f, calls } = spy();
    const r = await handleTranscribe(wavReq(wav), deps({ f, key: () => null }));
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toBe("no_key");
    expect(calls).toHaveLength(0);
  });

  it("rejects non-WAV bodies before any call", async () => {
    const { f, calls } = spy();
    const stereo = encodeWav(new Float32Array(1000), 16_000);
    new DataView(stereo.buffer).setUint16(22, 2, true);
    const cd44 = encodeWav(new Float32Array(1000), 16_000);
    new DataView(cd44.buffer).setUint32(24, 44_100, true);
    const cases: [BodyInit, string][] = [[wav, "audio/webm"], [new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, ...new Array(60).fill(0)]), "audio/wav"], [stereo, "audio/wav"], [cd44, "audio/wav"], ["hello", "audio/wav"]];
    for (const [body, type] of cases) {
      const r = await handleTranscribe(wavReq(body, type), deps({ f }));
      expect(r.status).toBe(415);
    }
    expect(calls).toHaveLength(0);
  });

  it("caps the recording length", async () => {
    const { f, calls } = spy();
    const r = await handleTranscribe(wavReq(encodeWav(new Float32Array(16_000 * 61), 16_000)), deps({ f }));
    expect(r.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("forwards a valid WAV with the keywords and returns only the finished transcript", async () => {
    const { f, calls } = spy();
    const r = await handleTranscribe(wavReq(wav), deps({ f }));
    expect(r.status).toBe(200);
    const b = (await r.json()) as Record<string, unknown>;
    expect(b["final"]).toBe(true);
    expect(b["text"]).toBe("Prepare the discharge summary for bed A-23.");
    expect(calls).toEqual([{ request: { model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "PUSH_TO_TALK", keywords: ["Ward A", "bed A-23"] } }]);
  });

  it("answers 502 when the reply has no finished transcript", async () => {
    const { f } = spy({ type: "transcript", transcript: "prepare the", final: false });
    expect((await handleTranscribe(wavReq(wav), deps({ f }))).status).toBe(502);
  });
});

describe("voice vocabulary and key file", () => {
  it("names wards, documents, staff and beds from the committed data", () => {
    const k = vocabularyKeywords(root);
    for (const t of ["Ward A", "Discharge summary", "HMO claim cover", "Refund voucher", "nurse", "accounts clerk", "Ward A manager"]) expect(k).toContain(t);
    expect(k.some((t) => /^bed [A-Z]-\d+$/.test(t))).toBe(true);
    expect(k).not.toContain("agent");
    expect(k.length).toBeLessThanOrEqual(100);
  });

  it("reads only MODEL_API_KEY from the keys file", () => {
    const d = mkdtempSync(join(tmpdir(), "voice-key-"));
    const file = join(d, "keys.env");
    writeFileSync(file, "# keys\nOTHER_KEY=nope\nexport MODEL_API_KEY=\"abc123\"\n");
    expect(metaKey(file)).toBe("abc123");
    writeFileSync(file, "OTHER_KEY=nope\nMODEL_API_KEY=\n");
    expect(metaKey(file)).toBeNull();
    expect(metaKey(join(d, "missing.env"))).toBeNull();
    rmSync(d, { recursive: true, force: true });
  });
});
