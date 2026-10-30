import { createServer, type IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import { DoorProfile } from "../src/profile.js";
import { PisgahPort } from "../src/port.js";

const PAT = "22222222-2222-4222-8222-222222222222";
const VIS = "11111111-1111-4111-8111-111111111111";
const DOC = "doc-owner";
const V2 = (n: number) => `v2.${String(1_761_700_000_000 + n)}.${"N".repeat(22)}.${"a".repeat(43)}`;
const prov = { owner: DOC, evidence: "transcript:u-1", spoken_at: "2026-10-30T09:00:00.000Z" };

// A stand-in door that records each request's headers and body and answers every order with a new id.
async function door() {
  const seen: { headers: IncomingHttpHeaders; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seen.push({ headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `s-${seen.length}` }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, base: `http://127.0.0.1:${(server.address() as { port: number }).port}/d`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const profile = (base: string) => DoorProfile.parse({
  base_url: base, timeout_ms: 2000,
  headers: { on_behalf_of: "X-For", origin: "X-Origin", evidence: "X-Evidence", spoken_at: "X-Spoken", idempotency: "X-Key", replayed: "X-Replayed", authorisation: "X-Auth", authorisation_batch: "X-Batch" },
  origin_value: "voice", deny: ["stay/settle"],
  ops: {
    read_admission: { method: "GET", path: "stay/{admission_id}", label: "name", facts: {}, proof: {} },
    write_observation: { method: "POST", path: "stay/entry", body: {}, writes_path: "writes", primary_store: "obs" }
  },
  work: { order_test: { method: "POST", path: "orders/voice", body: { visitId: "$visit_id", patientId: "$patient_id", tests: [{ testName: "$test_name" }], priority: "$priority" }, ack: { id_path: "id", store: "voice_order" }, unverifiable: "the stand-in door has no order read" } },
  owners: [{ id: DOC, label: "Doctor", kinds: ["order_test"] }],
  orders: { tests: { fbc: { words: ["full blood count"], name: "ZZ-TEST Full Blood Count" }, malaria: { words: ["malaria"], name: "ZZ-TEST Malaria Parasite" } } },
  targets: { admission_by_patient: {}, episode_by_admission: {} }
});

describe("one spoken line, bound to the items it named", () => {
  it("digests a write's path and body exactly as the hospital does", () => {
    const port = new PisgahPort(profile("http://127.0.0.1:1/d"), { bearers: { [DOC]: "b" } });
    // The same vector is pinned in the hospital's own test of its digest.
    expect(port.voiceItem("order_test", { visit_id: VIS, patient_id: PAT, test: "fbc", priority: "stat" })).toBe("7c45a7b995e96f4f702d75ed8664813164bd51f64cd7d6191d953fefcf271042");
    expect(port.voiceItem("order_test", { visit_id: VIS, patient_id: PAT, test: "malaria" })).not.toBe(port.voiceItem("order_test", { visit_id: VIS, patient_id: PAT, test: "fbc" }));
    expect(port.voiceItem("no_such_kind", {})).toBeNull();
  });

  it("sends the batch sorted beside the authorising line, and refuses a malformed batch before the network", async () => {
    const d = await door();
    try {
      const port = new PisgahPort(profile(d.base), { bearers: { [DOC]: "b" } });
      const a = port.voiceItem("order_test", { visit_id: VIS, patient_id: PAT, test: "fbc" })!, b = port.voiceItem("order_test", { visit_id: VIS, patient_id: PAT, test: "malaria" })!;
      const ok = await port.commit("order_test", { visit_id: VIS, patient_id: PAT, test: "fbc" }, "k-1", { ...prov, voice: { authorisation: `transcript:u-1~${V2(1)}`, batch: [b, a] } });
      expect(ok).toMatchObject({ ok: true });
      expect(d.seen[0]!.headers["x-batch"]).toBe([a, b].sort().join(","));
      expect(d.seen[0]!.headers["x-auth"]).toBe(`transcript:u-1~${V2(1)}`);
      // A batch with no authorising line travels nowhere.
      await port.commit("order_test", { visit_id: VIS, patient_id: PAT, test: "malaria" }, "k-2", { ...prov, voice: { batch: [a, b] } });
      expect(d.seen[1]!.headers["x-batch"]).toBeUndefined();
      expect(await port.commit("order_test", { visit_id: VIS, patient_id: PAT, test: "fbc" }, "k-3", { ...prov, voice: { authorisation: `transcript:u-1~${V2(1)}`, batch: ["not-a-digest"] } })).toMatchObject({ ok: false, reason: "bad_header" });
      expect(d.seen).toHaveLength(2);
    } finally { await d.close(); }
  });
});
