import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { DoorProfile } from "../src/profile.js";
import { PisgahPort } from "../src/port.js";

const ADM = "11111111-2222-4333-8444-555555555555";
const OWNER = "44444444-5555-4666-8777-888888888888";
const PROV = { owner: OWNER, evidence: "transcript:u-0000bbbb", spoken_at: "2026-10-30T09:00:00.000Z" };

// A stand-in hospital whose discharge paperwork discloses one result still pending at discharge.
async function door(paperwork: Record<string, unknown>) {
  const server = createServer((req, res) => {
    res.writeHead(req.url === `/door/stay/${ADM}/home` ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === `/door/stay/${ADM}/home` ? { paperwork } : { error: "not_found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}/door`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const profile = (base: string, pending: boolean) => DoorProfile.parse({
  base_url: base, timeout_ms: 2000,
  headers: { on_behalf_of: "X-For", origin: "X-Origin", evidence: "X-Evidence", spoken_at: "X-Spoken", idempotency: "X-Key", replayed: "X-Replayed" },
  origin_value: "voice", deny: ["stay/close"],
  ops: {
    read_admission: { method: "GET", path: "stay/{admission_id}", label: "name", facts: {}, proof: {} },
    write_observation: { method: "POST", path: "stay/entry", body: {}, writes_path: "writes", primary_store: "obs" },
    census: { method: "GET", path: "stay/list", list_path: "rows", admission_path: "adm", label_path: "who" },
    paperwork: {
      path: "stay/{admission_id}/home", digest: "paperwork.digest", diagnosis: "paperwork.diagnosis", medicines: "paperwork.medicines", medicine_name: "drugName",
      medicine_dispensed: "dispensedQuantity", exceptions: "paperwork.exceptions", exception_text: "text", tests: "paperwork.tests", test_resulted: "resultReceived",
      ...(pending ? { pending: "paperwork.pending", pending_text: "text" } : {})
    }
  },
  targets: { admission_by_patient: {}, episode_by_admission: {} }, vocabulary: ["pulse"]
});

describe("the discharge read-back carries what the hospital says is still pending", () => {
  const paper = {
    digest: "a".repeat(64), diagnosis: "Malaria", medicines: [], exceptions: [],
    tests: [{ resultReceived: true }, { resultReceived: false }],
    pending: [{ text: "Full blood count: result pending at discharge; when it returns it goes to the ward's doctors as a task" }, { text: "" }]
  };

  it("reads each pending sentence the hospital gave and drops empty ones", async () => {
    const d = await door(paper);
    try {
      const rb = await new PisgahPort(profile(d.base, true), { bearers: { [OWNER]: "b".repeat(40) } }).readPaperwork!(OWNER, ADM, PROV);
      expect(rb.pending).toEqual(["Full blood count: result pending at discharge; when it returns it goes to the ward's doctors as a task"]);
      expect(rb.tests).toEqual({ resulted: 1, total: 2 });
    } finally { await d.close(); }
  });

  it("a profile that names no pending path reads none, so older hospitals are unchanged", async () => {
    const d = await door(paper);
    try {
      const rb = await new PisgahPort(profile(d.base, false), { bearers: { [OWNER]: "b".repeat(40) } }).readPaperwork!(OWNER, ADM, PROV);
      expect(rb.pending).toEqual([]);
    } finally { await d.close(); }
  });
});
