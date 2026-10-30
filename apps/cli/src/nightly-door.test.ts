import { createServer, type IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import { nightly } from "@hey-pisgah/intelligence";
import { DoorProfile, PisgahPort, doorMemoTransport } from "@hey-pisgah/pisgah-adapter";
import { deliveryOutcome } from "./nightly.js";

const E1 = "cccccccc-1111-4222-8333-000000000001", E2 = "cccccccc-1111-4222-8333-000000000002";
const DOC = "dddddddd-1111-4222-8333-000000000001", INTRUDER = "dddddddd-1111-4222-8333-000000000009", NURSE = "dddddddd-1111-4222-8333-000000000003";
const SENDER = "eeeeeeee-1111-4222-8333-000000000001";
const NOW = new Date("2026-10-30T23:00:00.000Z");

let n = 0;
const ev = (case_id: string, kind: string, actor_id: string, at: number, subject: string | null = null): nightly.DayEvent =>
  ({ event_id: `ev-${String(++n).padStart(8, "0")}`, case_id, kind, actor_id, actor_role: "agent", occurred_at: at, recorded_at: at, subject, payload: {} });

// One journey, two open items for the doctor (one overdue), and a planted recipient who claims an encounter the record does not give them.
function sources(): nightly.NightSources {
  n = 0;
  const c1 = [ev("c-1", "record.proved", "nurse_1_agent", 600), ev("c-1", "record.proved", "doctor_1_agent", 590), ev("c-1", "write.refused", "doctor_1_agent", 595), ev("c-1", "step.observed", "doctor_1_agent", 620, "st05"), ev("c-1", "step.observed", "accounts_clerk_1_agent", 670, "st13")];
  return {
    day: "2026-10-30", cases: [{ case_id: "c-1", ward_id: "A", events: c1 }],
    open: [
      { item_id: "oi-1", encounter: E1, owner: DOC, department: "doctor", kind: "question", title: "How often should observations be done?", state: "open", due_at: null, refs: ["emr/t-1#12"] },
      { item_id: "oi-2", encounter: E2, owner: DOC, department: "doctor", kind: "obligation", title: "Review the abdomen", state: "held", due_at: "2026-10-30T10:00:00.000Z", refs: ["emr/t-2#7"] }
    ],
    recipients: [
      { id: DOC, role: "doctor", department: "doctor", incoming: false, authorised: [E1, E2] },
      { id: INTRUDER, role: "doctor", department: "doctor", incoming: true, authorised: [E1] },
      { id: NURSE, role: "nurse", department: "nurse", incoming: true, authorised: [] }
    ],
    labels: ["Ada Obi"]
  };
}
const memoFor = (s: nightly.NightSources, id: string) => nightly.composeMemo(s, s.recipients.find((r) => r.id === id)!, nightly.computeFacts(s), [], NOW);

type Seen = { path: string; headers: IncomingHttpHeaders; body: { recipientId: string; payloadHash: string; memo: unknown } };
// A stand-in memo route: it refuses the planted recipient as the record would, and can be told to fail with a server error.
async function fakeMemoDoor(o: { failWith500?: boolean } = {}) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Seen["body"];
    seen.push({ path: (req.url ?? "").replace(/^\/door\//, ""), headers: req.headers, body });
    const send = (status: number, j: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (o.failWith500) return send(500, { error: { code: "server", retryable: true } });
    // The door marks this refusal retryable, so a transport that retried on that flag would call twice.
    if (body.recipientId === INTRUDER) return send(409, { error: { code: "conflict", retryable: true, message: "The record does not authorise this person for an encounter the memo names." } });
    send(200, { ok: true, id: (body.memo as { memo_id: string }).memo_id, status: "delivered" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { seen, base: `http://127.0.0.1:${port}/door`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const profile = (base: string, deny = ["ward/close"]) => DoorProfile.parse({
  base_url: base, timeout_ms: 2000,
  headers: { on_behalf_of: "X-Door-For", origin: "X-Door-Origin", evidence: "X-Door-Evidence", spoken_at: "X-Door-Spoken", idempotency: "X-Door-Key", replayed: "X-Door-Replayed" },
  origin_value: "voice", deny,
  ops: {
    read_admission: { method: "GET", path: "ward/{admission_id}", label: "name", facts: {}, proof: { pulse: "latest.p" } },
    write_observation: { method: "POST", path: "ward/entry", body: {}, writes_path: "writes", primary_store: "obs" }
  },
  targets: { admission_by_patient: {}, episode_by_admission: {} },
  memos: { path: "night/memo", sender: SENDER, sender_label: "Synthetic department lead (disclosed)" }
});
const publisherOver = (s: nightly.NightSources, base: string, deny?: string[]) => {
  const door = doorMemoTransport(new PisgahPort(profile(base, deny), { bearers: { [SENDER]: "test-bearer" } }), { run_id: "run-test", now: () => new Date("2026-10-30T01:00:00.000Z") });
  return { door, p: nightly.memoPublisher({ sources: s, transport: door, now: () => NOW }) };
};

describe("the nightly memo through the door", () => {
  it("posts a verified memo under the profile's sender with the provenance headers and an idempotency key", async () => {
    const d = await fakeMemoDoor();
    try {
      const s = sources();
      const r = await publisherOver(s, d.base).p.publish(memoFor(s, NURSE));
      expect(r.status).toBe("delivered");
      expect(d.seen).toHaveLength(1);
      const h = d.seen[0]!.headers;
      expect([d.seen[0]!.path, h["authorization"], h["x-door-for"], h["x-door-origin"], h["x-door-spoken"]]).toEqual(["night/memo", "Bearer test-bearer", SENDER, "voice", "2026-10-30T01:00:00.000Z"]);
      expect(h["x-door-evidence"]).toMatch(/^nightly:run-test\/m-[0-9a-f]{8}$/);
      expect(h["x-door-key"]).toMatch(/^memo-m-[0-9a-f]{8}-[0-9a-f]{16}$/);
      expect(d.seen[0]!.body.payloadHash).toBe(nightly.payloadHash(memoFor(s, NURSE)));
    } finally { await d.close(); }
  });

  it("records the door's refusal of an unauthorised recipient and does not retry it", async () => {
    const d = await fakeMemoDoor();
    try {
      const s = sources();
      const { door, p } = publisherOver(s, d.base);
      const r = await p.publish(memoFor(s, INTRUDER));
      // The engine's own checks pass, since the planted roster claims the encounter; only the hospital's record refuses it.
      expect(r.verdict.status).toBe("verified");
      expect(r.status).toBe("refused");
      expect(r.not_sent.find((x) => x.kind === "memo")).toMatchObject({ refused: true, reason: expect.stringContaining("does not authorise") });
      expect(d.seen.filter((x) => x.body.recipientId === INTRUDER)).toHaveLength(1);
      expect(door.log.filter((x) => x.outcome === "refused")).toHaveLength(1);
      expect(deliveryOutcome(r, { expect: "refuse", why: "not on the record" }).correct).toBe(true);
      expect(deliveryOutcome(r, { expect: "deliver", why: "on the record" }).correct).toBe(false);
    } finally { await d.close(); }
  });

  it("holds the urgent task alert, since the door takes a memo only, and still delivers the memo with the urgent items inside", async () => {
    const d = await fakeMemoDoor();
    try {
      const s = sources();
      const r = await publisherOver(s, d.base).p.publish(memoFor(s, DOC));
      expect(r.status).toBe("delivered");
      expect(r.not_sent).toEqual([{ kind: "task", refused: false, reason: "no door route for a task alert" }]);
      expect(d.seen).toHaveLength(1);
      expect((d.seen[0]!.body.memo as nightly.Memo).urgent.map((i) => i.item_id)).toEqual(["oi-2"]);
    } finally { await d.close(); }
  });

  it("never calls the door for a memo that names a patient, and keeps the deny list ahead of the route", async () => {
    const d = await fakeMemoDoor();
    try {
      const s = sources();
      const named = { ...memoFor(s, NURSE), preview: "Night memo for Ada Obi." };
      expect((await publisherOver(s, d.base).p.publish(named)).status).toBe("withheld");
      expect(d.seen).toHaveLength(0);
      // A profile that both denies and names the memo route is refused before any call.
      expect(() => publisherOver(s, d.base, ["night/memo"])).toThrow("the profile allows a denied path");
      expect(d.seen).toHaveLength(0);
    } finally { await d.close(); }
  });

  it("counts a server error as a failed delivery, not as a refusal", async () => {
    const d = await fakeMemoDoor({ failWith500: true });
    try {
      const s = sources();
      const r = await publisherOver(s, d.base).p.publish(memoFor(s, NURSE));
      expect(r.status).toBe("transport_failed");
      expect(deliveryOutcome(r, { expect: "deliver", why: "" }).correct).toBe(null);
    } finally { await d.close(); }
  });
});
