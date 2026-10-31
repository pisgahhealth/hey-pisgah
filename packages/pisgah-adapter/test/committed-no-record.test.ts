import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EmrRuntime } from "@hey-pisgah/agent";
import { ModelClient, type ChatCompletion } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { DoorProfile } from "../src/profile.js";
import { PisgahPort } from "../src/port.js";

const DOC = "doc-owner";
const PAT = "aaaaaaaa-1111-4222-8333-444444444444";
const VISIT = "bbbbbbbb-1111-4222-8333-444444444444";
const DRUG = "dddddddd-1111-4222-8333-444444444444";
const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4222-8333-444444444444`;
// What the hospital keeps for a key whose write committed but whose answer could not be built (idempotency.ts COMMITTED_ANSWER_LOST).
const COMMITTED_ANSWER_LOST = { ok: true, committed: true, answer: "lost", message: "The write was saved, but its answer could not be built; read the record." };
type Fault = "commit_lost" | "hide";
type Row = { stateId: string; kind: string; label: string; verbal: boolean; sentAt: string; prescriptionId: string | null };

// A stand-in door with the hospital's key store and voice-order list: a committed write whose answer is lost keeps the no-record answer for its key.
async function door() {
  const st = { rows: [] as Row[], keys: new Map<string, unknown>(), faults: [] as Fault[], posts: 0, tokens: 0, hidden: new Set<string>(), refusing: null as null | "plain" | "replayed" };
  const send = (res: ServerResponse, s: number, j: unknown, extra: Record<string, string> = {}) => { res.writeHead(s, { "content-type": "application/json", ...extra }); res.end(JSON.stringify(j)); };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://door");
    const path = url.pathname.replace(/^\/d\//, "");
    if (path === "orders" && req.method === "GET") return send(res, 200, { visitId: url.searchParams.get("visitId"), orders: st.rows.filter((r) => !st.hidden.has(r.stateId)) });
    if (path === "draft" && req.method === "POST") return send(res, 200, { ok: true });
    if (path === "patients") return send(res, 200, { rows: [{ patientId: PAT, visitId: VISIT, name: "Stand-in Patient" }] });
    if (path === "speaker" && req.method === "POST") { st.tokens += 1; return send(res, 200, { speaker: "owner", token: `v2.${String(1_761_700_000_000 + st.tokens)}.${"B".repeat(22)}.${"A".repeat(43)}` }); }
    if ((path !== "rx" && path !== "send") || req.method !== "POST") return send(res, 404, { error: { code: "not_found_opaque", retryable: false } });
    st.posts += 1;
    // A refusal the hospital audited in its transaction: the first answer is lost on the way, every later one is the same 409.
    if (st.refusing) {
      if (st.posts === 1) return res.destroy();
      return send(res, 409, { error: { code: "admission_gate", retryable: false } }, st.refusing === "replayed" ? { "x-replayed": "true" } : {});
    }
    const key = String(req.headers["x-key"] ?? "");
    if (st.keys.has(key)) return send(res, 200, st.keys.get(key), { "x-replayed": "true" });
    const body = JSON.parse(raw) as { tests?: { testName: string }[] };
    const n = st.rows.length + 1;
    const row: Row = path === "rx"
      ? { stateId: uuid(n), kind: "prescription", label: "Paracetamol", verbal: false, sentAt: new Date().toISOString(), prescriptionId: uuid(500 + n) }
      : { stateId: uuid(n), kind: "lab", label: body.tests?.[0]?.testName ?? "", verbal: false, sentAt: new Date().toISOString(), prescriptionId: null };
    st.rows.push(row);
    const fault = st.faults.shift();
    if (fault === "hide") st.hidden.add(row.stateId);
    const ack = fault ? COMMITTED_ANSWER_LOST : path === "rx" ? { id: row.prescriptionId, status: "pending" } : { ok: true, id: row.stateId };
    st.keys.set(key, ack);
    return send(res, 200, ack);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { st, base: `http://127.0.0.1:${(server.address() as { port: number }).port}/d`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const profile = (base: string, lookup = true) => DoorProfile.parse({
  base_url: base, timeout_ms: 1000,
  headers: { on_behalf_of: "X-For", origin: "X-Origin", evidence: "X-Evidence", spoken_at: "X-Spoken", idempotency: "X-Key", replayed: "X-Replayed" },
  origin_value: "voice", deny: ["stay/out/done"],
  ops: {
    read_admission: { method: "GET", path: "stay/{admission_id}", label: "name", facts: {}, proof: {} },
    write_observation: { method: "POST", path: "stay/entry", body: {}, writes_path: "writes", primary_store: "obs" },
    patient_context: { path: "patients", list_path: "rows", match: "patientId", label: "name", visit: "visitId" },
    speaker: { path: "speaker" }
  },
  orders: { tests: { fbc: { words: ["full blood count"], name: "Full Blood Count" } }, drugs: { paracetamol_oral: { words: ["paracetamol"], id: DRUG } } },
  work: {
    prescribe: {
      method: "POST", path: "rx", body: { visitId: "$visit_id", patientId: "$patient_id", items: [{ drugCatalogId: "$drug_catalog_id", quantity: "$quantity" }] },
      ack: { id_path: "id", store: "prescription" },
      proof: { path: "orders", query: { visitId: "$visit_id" }, find: { list: "orders", where: { prescriptionId: "$record_id" } }, checks: { sentAt: "@nonnull" } },
      ...(lookup ? { lookup: { path: "orders", query: { visitId: "$visit_id" }, find: { list: "orders", where: { kind: "prescription", verbal: "false" } }, id: "prescriptionId", made_at: "sentAt" } } : {})
    },
    order_test: {
      method: "POST", path: "send", body: { visitId: "$visit_id", patientId: "$patient_id", tests: [{ testName: "$test_name" }] },
      ack: { id_path: "id", store: "voice_order" },
      proof: { path: "orders", query: { visitId: "$visit_id" }, find: { list: "orders", where: { stateId: "$record_id" } }, checks: { sentAt: "@nonnull", label: "$test_name" } },
      ...(lookup ? { lookup: { path: "orders", query: { visitId: "$visit_id" }, find: { list: "orders", where: { label: "$test_name", verbal: "false" } }, id: "stateId", made_at: "sentAt" } } : {})
    },
    // The draft is the visit's own record, so its answer names no other record.
    record_clerking: { method: "POST", path: "draft", body: { visitId: "$visit_id" }, ack: { store: "draft" }, unverifiable: "the stand-in has no draft read" }
  },
  owners: [{ id: DOC, label: "Doctor", kinds: ["prescribe", "order_test", "record_clerking"] }],
  targets: { admission_by_patient: {}, episode_by_admission: {} }
});

const prov = { owner: DOC, evidence: "transcript:l-1", spoken_at: new Date().toISOString() };
const RX = { visit_id: VISIT, patient_id: PAT, drug: "paracetamol_oral", quantity: 2 };
const FBC = { visit_id: VISIT, patient_id: PAT, test: "fbc" };

describe("the door's answer says the write committed but names no record", () => {
  it("is its own answer from the port, never the visit id in place of a new prescription or order id", async () => {
    const d = await door();
    d.st.faults.push("commit_lost", "commit_lost");
    const port = new PisgahPort(profile(d.base), { bearers: { [DOC]: "b-doc" } });
    const rx = await port.commit("prescribe", RX, "k-rx", prov);
    const lab = await port.commit("order_test", FBC, "k-lab", prov);
    for (const c of [rx, lab]) {
      expect(c).toMatchObject({ ok: false, committed: true, reason: "committed_without_record", status: 200 });
      expect(JSON.stringify(c)).not.toContain(VISIT);
    }
    // Negative control: work whose record is the visit itself still names the visit.
    expect(await port.commit("record_clerking", { visit_id: VISIT, patient_id: PAT }, "k-draft", prov)).toMatchObject({ ok: true, record_id: VISIT });
    await d.close();
  });
});

// The gate as a script: the paracetamol line is a prescription, the blood count line a test.
const gate = (said: string) => (/paracetamol/i.test(said) ? [{ class: "instruction", kind: "prescribe", drug: "paracetamol_oral", confidence: 0.95 }] : /blood count/i.test(said) ? [{ class: "instruction", kind: "order_test", test: "fbc", confidence: 0.95 }] : []);
function mockGate(root: string, rt: () => EmrRuntime | null): ModelClient {
  return new ModelClient({
    storeRoot: root, mode: "mock", taskStateOf: (id) => rt()?.stateOf(id) ?? null,
    mock: ({ body, hash }) => {
      const user = String((body["messages"] as { role: string; content: string }[]).find((m) => m.role === "user")?.content ?? "");
      const said = JSON.parse(/clinician_said: (".*")$/m.exec(user)?.[1] ?? '""') as string;
      const c: ChatCompletion = {
        id: `mock-${hash.slice(0, 12)}`, object: "chat.completion", created: 0, model: String(body["model"]),
        choices: [{ index: 0, finish_reason: "tool_calls", logprobs: null, message: { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "gate", arguments: JSON.stringify({ clauses: gate(said).map((x) => ({ words: said, ...x })) }) } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      };
      return c;
    }
  });
}

function boot(base: string, lookup = true, root = mkdtempSync(join(tmpdir(), "hp-rec-"))) {
  let rt: EmrRuntime | null = null;
  const client = mockGate(root, () => rt);
  const port = new PisgahPort(profile(base, lookup), { bearers: { [DOC]: "b-doc" } });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1, reconcileMs: [150, 150] });
  rt.start();
  return { rt, root, client };
}
// The owner's own matched line asks for the order, so it goes straight to the door.
async function order(rt: EmrRuntime, kind: "prescribe" | "order_test") {
  const r = await rt.say({ owner: DOC, target: { patient_id: PAT }, text: kind === "prescribe" ? "Give paracetamol, two tablets." : "Send a full blood count.", source: "audio", voiceprint: { vector: [5], ms: 20, model: "nemo_en_titanet_small" } });
  await rt.settled();
  return r;
}
const types = (root: string, id: string) => readStream(root, `emr/${id}`).map((e) => e.record_type);
const written = (root: string, id: string) => readStream(root, `emr/${id}`).filter((e) => e.record_type === "action.written").map((e) => (e.payload as { written: { record_id: string } }).written.record_id);
const settledOn = async (rt: EmrRuntime, id: string, state: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (rt.view(id)!.actions[0]!.state !== state) { if (Date.now() > end) throw new Error(`still ${rt.view(id)!.actions[0]!.state}`); await new Promise((r) => setTimeout(r, 20)); }
};

describe("a committed write with no record id, through the runtime", () => {
  for (const [kind, id] of [["prescribe", uuid(501)], ["order_test", uuid(1)]] as const) {
    it(`${kind}: stays uncertain under its key, is found by the record lookup, and completes with its own id, one POST`, async () => {
      const d = await door();
      d.st.faults.push("commit_lost");
      const { rt, root, client } = boot(d.base);
      const r = await order(rt, kind);
      await settledOn(rt, r.task_id, "completed");
      expect(written(root, r.task_id)).toEqual([id]);
      expect(types(root, r.task_id)).toEqual(expect.arrayContaining(["action.uncertain", "action.reconciled"]));
      expect(d.st.posts).toBe(1);
      expect(d.st.rows).toHaveLength(1);
      await rt.stop(); client.close(); await d.close();
    });
  }

  it("with no record found it stays uncertain, never acknowledged, refused or sent again, and the task stays running", async () => {
    const d = await door();
    d.st.faults.push("hide");
    const { rt, root, client } = boot(d.base);
    const r = await order(rt, "prescribe");
    await settledOn(rt, r.task_id, "uncertain");
    await new Promise((res) => setTimeout(res, 600));
    const v = rt.view(r.task_id)!;
    expect(v.actions[0]!.state).toBe("uncertain");
    expect(v.state).toBe("running");
    expect(written(root, r.task_id)).toEqual([]);
    expect(types(root, r.task_id)).not.toEqual(expect.arrayContaining(["action.refused"]));
    expect(types(root, r.task_id)).not.toContain("action.failed");
    expect(types(root, r.task_id)).not.toContain("action.retry");
    expect(d.st.posts).toBe(1);
    await rt.stop(); client.close(); await d.close();
  });

  it("with no lookup in the profile it stays uncertain rather than take the visit id", async () => {
    const d = await door();
    d.st.faults.push("commit_lost");
    const { rt, root, client } = boot(d.base, false);
    const r = await order(rt, "order_test");
    await settledOn(rt, r.task_id, "uncertain");
    await new Promise((res) => setTimeout(res, 600));
    expect(rt.view(r.task_id)!.actions[0]!.state).toBe("uncertain");
    expect(written(root, r.task_id)).toEqual([]);
    expect(d.st.posts).toBe(1);
    await rt.stop(); client.close(); await d.close();
  });

  for (const how of ["plain", "replayed"] as const) {
    it(`a lost answer whose retry is a ${how} 4xx is the definite refusal, never uncertain and never saved`, async () => {
      const d = await door();
      d.st.refusing = how;
      const { rt, root, client } = boot(d.base, false);
      const r = await order(rt, "prescribe");
      await settledOn(rt, r.task_id, "refused");
      const ev = types(root, r.task_id);
      expect(ev.indexOf("action.uncertain")).toBeLessThan(ev.indexOf("action.refused"));
      expect(written(root, r.task_id)).toEqual([]);
      expect(d.st.posts).toBe(2);
      await rt.stop(); client.close(); await d.close();
    });
  }

  it("negative control: an earlier prescription on the visit is never taken for this one", async () => {
    const d = await door();
    d.st.rows.push({ stateId: uuid(90), kind: "prescription", label: "Paracetamol", verbal: false, sentAt: new Date(Date.now() - 3600_000).toISOString(), prescriptionId: uuid(590) });
    d.st.faults.push("commit_lost");
    const { rt, root, client } = boot(d.base);
    const r = await order(rt, "prescribe");
    await settledOn(rt, r.task_id, "completed");
    expect(written(root, r.task_id)).toEqual([uuid(502)]);
    await rt.stop(); client.close(); await d.close();
  });
});
