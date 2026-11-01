import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { DoorProfile } from "../src/profile.js";
import { PisgahPort } from "../src/port.js";

// Lane F2 (c): the receiving owner's agent reads a hand-off's subject record for the patient's name, over made-up routes.
const ORDER = "f0000001-2222-4333-8444-555555555555", PAT = "33333333-4444-4555-8666-777777777777", TASK = "88888888-4444-4555-8666-777777777777";
const LAB = "lab-owner", NURSE = "nurse-owner";
const prov = (owner: string) => ({ owner, evidence: "watch:delegations", spoken_at: "2026-11-01T06:00:00.000Z" });

async function door(answer: Record<string, unknown>) {
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const url = new URL(req.url ?? "/", "http://door");
    const path = url.pathname.replace(/^\/d\//, "");
    seen.push(`${req.method} ${path}${url.search} for=${String(req.headers["x-for"] ?? "")}`);
    const send = (s: number, j: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (path === `tasks/${TASK}`) return send(200, { id: TASK, kind: "lab_order", title: "Receive the lab order", patientId: PAT, admissionId: null, visitId: null, state: "assigned", subject: { table: "bench_orders", id: ORDER }, instruction: "Send the test: fbc", record: { status: "unsupported_or_incomplete" } });
    if (path === "bench/order" && url.searchParams.get("orderId") === ORDER) return send(200, answer);
    send(404, { error: { code: "not_found_opaque" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, base: `http://127.0.0.1:${(server.address() as { port: number }).port}/d`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const profile = (base: string, subject: Record<string, unknown>) => DoorProfile.parse({
  base_url: base, timeout_ms: 2000,
  headers: { on_behalf_of: "X-For", origin: "X-Origin", evidence: "X-Evidence", spoken_at: "X-Spoken", idempotency: "X-Key", replayed: "X-Replayed" },
  origin_value: "voice", deny: ["stay/settle"], deny_exact: [],
  ops: {
    read_admission: { method: "GET", path: "stay/{admission_id}", label: "name", facts: {}, proof: {} },
    write_observation: { method: "POST", path: "stay/entry", body: {}, writes_path: "writes", primary_store: "obs" }
  },
  work: {},
  owners: [{ id: LAB, label: "Lab", kinds: ["receive_specimen"], delegation: "assignee" }, { id: NURSE, label: "Nurse", kinds: ["record_observation"], delegation: "none" }],
  delegations: { list: { path: "tasks", list_path: "rows" }, one: { path: "tasks/{delegation_id}" }, subjects: { bench_orders: subject } },
  targets: { admission_by_patient: {}, episode_by_admission: {} }
});
const BY_ORDER = { path: "bench/order", query: { orderId: "$subject_id" }, label: "patientName" };

describe("F2 (c): a hand-off's subject read", () => {
  it("reads the delegation's subject table and the patient's name from its subject record, on the receiving owner's session", async () => {
    const d = await door({ orderId: ORDER, patientName: "Blessing Adeyemi", patientRef: PAT });
    try {
      const port = new PisgahPort(profile(d.base, { ...BY_ORDER, patient: "patientRef" }), { bearers: { [LAB]: "b".repeat(30) } });
      const one = await port.delegation(LAB, TASK, prov(LAB));
      expect(one).toMatchObject({ subject_table: "bench_orders", subject_id: ORDER, patient_id: PAT });
      expect(await port.delegationSubject(LAB, { table: one!.subject_table!, id: one!.subject_id! }, prov(LAB))).toEqual({ patient_id: PAT, label: "Blessing Adeyemi" });
      expect(d.seen.at(-1)).toBe(`GET bench/order?orderId=${ORDER} for=${LAB}`);
    } finally { await d.close(); }
  });

  it("gives no patient id when the profile names none, and no name when the answer has none", async () => {
    const d = await door({ orderId: ORDER });
    try {
      const port = new PisgahPort(profile(d.base, BY_ORDER), { bearers: { [LAB]: "b".repeat(30) } });
      expect(await port.delegationSubject(LAB, { table: "bench_orders", id: ORDER }, prov(LAB))).toEqual({ patient_id: null, label: null });
    } finally { await d.close(); }
  });

  it("reads nothing for a table the profile does not list, a subject that is not an id, or an owner who takes no hand-offs", async () => {
    const d = await door({ orderId: ORDER, patientName: "Blessing Adeyemi" });
    try {
      const port = new PisgahPort(profile(d.base, BY_ORDER), { bearers: { [LAB]: "b".repeat(30), [NURSE]: "c".repeat(30) } });
      expect(await port.delegationSubject(LAB, { table: "prescriptions", id: ORDER }, prov(LAB))).toBeNull();
      expect(await port.delegationSubject(LAB, { table: "bench_orders", id: "../sign" }, prov(LAB))).toBeNull();
      expect(await port.delegationSubject(NURSE, { table: "bench_orders", id: ORDER }, prov(NURSE))).toBeNull();
      expect(d.seen).toEqual([]);
    } finally { await d.close(); }
  });
});
