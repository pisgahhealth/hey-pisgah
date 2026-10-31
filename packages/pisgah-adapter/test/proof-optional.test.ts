import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { DoorProfile } from "../src/profile.js";
import { PisgahPort } from "../src/port.js";

const ADM = "11111111-2222-4333-8444-555555555555";
const DOC = "doc-owner";
const prov = { owner: DOC, evidence: "transcript:u-1", spoken_at: "2026-10-31T10:00:00.000Z" };

// A stand-in stay read whose latest vitals carry a pulse and a blood pressure and no sats, as pass 10f's B03 did.
async function door(vitals: Record<string, string | null>) {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://door").pathname.replace(/^\/d\//, "");
    res.writeHead(path === `stay/${ADM}` ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(path === `stay/${ADM}` ? { vitals } : { error: { code: "not_found_opaque" } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}/d`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
const profile = (base: string) => DoorProfile.parse({
  base_url: base, timeout_ms: 2000,
  headers: { on_behalf_of: "X-For", origin: "X-Origin", evidence: "X-Evidence", spoken_at: "X-Spoken", idempotency: "X-Key", replayed: "X-Replayed" },
  origin_value: "voice", deny: ["stay/settle"],
  ops: {
    read_admission: { method: "GET", path: "stay/{admission_id}", label: "name", facts: {}, proof: {} },
    write_observation: { method: "POST", path: "stay/entry", body: {}, writes_path: "writes", primary_store: "obs" },
    patient_context: { path: "board", list_path: "rows", match: "pid", label: "name", visit: "visit" }
  },
  work: {
    record_observation: { method: "POST", path: "stay/vitals", body: { admissionId: "$admission_id", pulse: "$pulse", spo2: "$spo2" }, ack: { id_path: "id", store: "observation" },
      proof: { path: "stay/{admission_id}", checks: { "vitals.pulse": "$pulse", "vitals.bp": "$bp", "vitals.spo2": "$spo2" } } }
  },
  owners: [{ id: DOC, label: "Doctor", kinds: ["record_observation"] }],
  targets: { admission_by_patient: {}, episode_by_admission: {} }
});
const written = { record_id: "obs-1", record_version: 1, event_ids: ["observation:obs-1"] };

describe("a work proof over values the work did not carry", () => {
  it("skips a check whose variable name holds a digit (spo2) when the line carried no sats, and still compares it when it did", async () => {
    const d = await door({ pulse: "120", bp: "110/70", spo2: null });
    try {
      const port = new PisgahPort(profile(d.base), { bearers: { [DOC]: "b" } });
      // Pass 10f's B03: pulse and blood pressure, no sats; the sats check must not be asserted.
      expect(await port.prove("record_observation" as never, { admission_id: ADM, pulse: 120, bp: "110/70" } as never, written, prov)).not.toBeNull();
      // Negative control: sats said and not on the record is still no proof.
      expect(await port.prove("record_observation" as never, { admission_id: ADM, pulse: 120, bp: "110/70", spo2: 96 } as never, written, prov)).toBeNull();
    } finally { await d.close(); }
  });
});
