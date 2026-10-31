import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { DoorProfile } from "../src/profile.js";
import { PisgahPort } from "../src/port.js";

// Lane LABE: a lab write reads the case version from a flat answer first, posts with it, and posts nothing for a sample not waiting.
const ORDER = "f0000001-2222-4333-8444-555555555555", CASE = "c0000001-2222-4333-8444-555555555555", SPEC = "a0000001-2222-4333-8444-555555555555";
const LAB = "lab-owner";
const prov = { owner: LAB, evidence: "transcript:u-1", spoken_at: "2026-10-31T21:00:00.000Z" };

async function door(specimen: string) {
  const st = { specimen, caseState: "active", posts: [] as { path: string; body: unknown }[] };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    const url = new URL(req.url ?? "/", "http://door");
    const path = url.pathname.replace(/^\/d\//, "");
    const send = (s: number, j: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (req.method === "GET" && path === "lab/receive") return send(200, { orderId: url.searchParams.get("orderId"), caseId: CASE, caseVersion: 4, caseState: st.caseState, specimenState: st.specimen });
    if (req.method === "POST" && path === "lab/receive") { st.posts.push({ path, body }); st.specimen = "processed"; return send(200, { ok: true, id: SPEC, status: "processed" }); }
    if (req.method === "POST" && path === "lab/cancel") { st.posts.push({ path, body }); st.caseState = "cancelled"; return send(200, { ok: true, id: CASE, status: "cancelled" }); }
    send(404, { error: { code: "not_found_opaque" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { st, base: `http://127.0.0.1:${(server.address() as { port: number }).port}/d`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const read = { path: "lab/receive", query: { orderId: "$order_id" } };
const profile = (base: string) => DoorProfile.parse({
  base_url: base, timeout_ms: 2000,
  headers: { on_behalf_of: "X-For", origin: "X-Origin", evidence: "X-Evidence", spoken_at: "X-Spoken", idempotency: "X-Key", replayed: "X-Replayed" },
  origin_value: "voice", deny: ["stay/settle"], deny_exact: [],
  ops: {
    read_admission: { method: "GET", path: "stay/{admission_id}", label: "name", facts: {}, proof: {} },
    write_observation: { method: "POST", path: "stay/entry", body: {}, writes_path: "writes", primary_store: "obs" }
  },
  work: {
    receive_specimen: {
      method: "POST", path: "lab/receive", body: { orderId: "$order_id", expectedVersion: "$case_version" },
      before: [{ ...read, where: { specimenState: "collected" }, field: "caseVersion", vars: ["case_version"] }],
      ack: { id_path: "id", store: "lab_specimen" }, proof: { ...read, checks: { specimenState: "processed" } }
    },
    cancel_test: {
      method: "POST", path: "lab/cancel", body: { caseId: "$case_id", expectedVersion: "$case_version", reasonCode: "$reason" },
      before: [{ ...read, where: {}, field: "caseId", vars: ["case_id"] }, { ...read, where: {}, field: "caseVersion", vars: ["case_version"] }],
      ack: { id_path: "id", store: "lab_case" }, proof: { ...read, checks: { caseState: "cancelled" } }
    }
  },
  owners: [{ id: LAB, label: "Lab", kinds: ["receive_specimen", "cancel_test"] }],
  targets: { admission_by_patient: {}, episode_by_admission: {} }
});
const args = { delegation_id: "d0000001-2222-4333-8444-555555555555", order_id: ORDER, title: "Receive the lab order", test: "fbc", evidence: "transcript:u-1" };

describe("lab writes over a flat pre-read", () => {
  it("receives with the version the read gave, and the fresh read proves it processed", async () => {
    const d = await door("collected");
    try {
      const port = new PisgahPort(profile(d.base), { bearers: { [LAB]: "b-lab" } });
      const c = await port.commit("receive_specimen", args, "key-r-0001", prov);
      expect(c).toMatchObject({ ok: true, record_id: SPEC });
      expect(d.st.posts).toEqual([{ path: "lab/receive", body: { orderId: ORDER, expectedVersion: 4 } }]);
      expect(await port.prove("receive_specimen", args, c as never, prov)).not.toBeNull();
    } finally { await d.close(); }
  });

  it("posts nothing for a sample that is not waiting to be received", async () => {
    const d = await door("received");
    try {
      const port = new PisgahPort(profile(d.base), { bearers: { [LAB]: "b-lab" } });
      expect(await port.commit("receive_specimen", args, "key-r-0002", prov)).toMatchObject({ ok: false, reason: "nothing_free", retryable: false });
      expect(d.st.posts).toEqual([]);
    } finally { await d.close(); }
  });

  it("cancels with the case id, version and reason the read and the words gave", async () => {
    const d = await door("pending");
    try {
      const port = new PisgahPort(profile(d.base), { bearers: { [LAB]: "b-lab" } });
      const a = { ...args, reason: "requester_cancelled" };
      const c = await port.commit("cancel_test", a, "key-c-0001", prov);
      expect(c).toMatchObject({ ok: true, record_id: CASE });
      expect(d.st.posts).toEqual([{ path: "lab/cancel", body: { caseId: CASE, expectedVersion: 4, reasonCode: "requester_cancelled" } }]);
      expect(await port.prove("cancel_test", a, c as never, prov)).not.toBeNull();
    } finally { await d.close(); }
  });
});
