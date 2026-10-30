import { createServer, type IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import { DoorProfile } from "../src/profile.js";
import { PisgahPort, type DoorLog } from "../src/port.js";

const DOC = "doc-owner";
const prov = { owner: DOC, evidence: "transcript:u-1", spoken_at: "2026-10-30T09:00:00.000Z" };
const TOKEN = `v2.1761700000001.${"N".repeat(22)}.${"a".repeat(43)}`;

// A stand-in door that keeps each match request's headers and raw body and answers the owner.
async function door() {
  const seen: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seen.push({ headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ speaker: "owner", token: TOKEN, model: "nemo_en_titanet_small" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, base: `http://127.0.0.1:${(server.address() as { port: number }).port}/d`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const profile = (base: string) => DoorProfile.parse({
  base_url: base, timeout_ms: 2000,
  headers: { on_behalf_of: "X-For", origin: "X-Origin", evidence: "X-Evidence", spoken_at: "X-Spoken", idempotency: "X-Key", replayed: "X-Replayed" },
  origin_value: "voice", deny: ["stay/settle"],
  ops: {
    read_admission: { method: "GET", path: "stay/{admission_id}", label: "name", facts: {}, proof: {} },
    write_observation: { method: "POST", path: "stay/entry", body: {}, writes_path: "writes", primary_store: "obs" },
    speaker: { path: "voice/speaker" }
  },
  work: {}, owners: [{ id: DOC, label: "Doctor", kinds: ["record_observation"] }], targets: { admission_by_patient: {}, episode_by_admission: {} }
});

describe("the match sent as audio when the hospital computes the voiceprint", () => {
  it("sends the line's PCM as the raw body with no vector, and logs neither", async () => {
    const d = await door();
    const logs: DoorLog[] = [];
    try {
      const port = new PisgahPort(profile(d.base), { bearers: { [DOC]: "b" }, onRequest: (l) => logs.push(l) });
      const pcm = new Uint8Array(32_000).map((_, i) => (i * 37) % 251);
      expect(await port.speaker!(DOC, { pcm16k: [pcm] }, prov)).toEqual({ speaker: "owner", token: TOKEN });
      expect(d.seen[0]!.headers["content-type"]).toBe("application/octet-stream");
      expect(d.seen[0]!.body.equals(Buffer.from(pcm))).toBe(true);
      expect(d.seen[0]!.headers["x-evidence"]).toBe("transcript:u-1");
      expect(logs[0]!.body).toEqual({ audio: "<audio withheld>" });
      expect(JSON.stringify(logs)).not.toContain(Buffer.from(pcm.slice(0, 48)).toString("base64").slice(0, 32));
      // Negative control: a vector still travels as JSON, so the old door is unchanged with the switch off.
      await port.speaker!(DOC, [0.1, 0.2], prov);
      expect(d.seen[1]!.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(d.seen[1]!.body.toString("utf8"))).toEqual({ embedding: [0.1, 0.2], model: "nemo_en_titanet_small" });
      expect(logs[1]!.body).toEqual({ embedding: "<voiceprint withheld>" });
    } finally {
      await d.close();
    }
  });
});
