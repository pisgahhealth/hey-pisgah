import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMERGENCY_KIND, EmrRuntime } from "@hey-pisgah/agent";
import { ModelClient } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { DoorProfile } from "../src/profile.js";
import { PisgahPort } from "../src/port.js";

const DOC = "doc-owner";
const CLINIC = "66666666-4444-4555-8666-777777777777";
const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4222-8333-444444444444`;
type Fault = "drop" | "slow" | "fail_after_save" | "fail_before_save" | "refuse";

// A stand-in door with Pisgah's key store: a success is kept and replayed for its key, any other answer frees the key, and a key still running answers 409 retryable.
async function door() {
  const st = { rows: [] as { patientId: string; visitId: string; johnDoeRef: string; arrivedAt: string }[], keys: new Map<string, { hash: string; body: unknown | null }>(), faults: [] as Fault[], posts: 0, replays: 0, dropReplays: 0 };
  const send = (res: ServerResponse, s: number, j: unknown, extra: Record<string, string> = {}) => { res.writeHead(s, { "content-type": "application/json", ...extra }); res.end(JSON.stringify(j)); };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const path = new URL(req.url ?? "/", "http://door").pathname.replace(/^\/d\//, "");
    if (path === "board") return send(res, 200, { rows: st.rows });
    if (path !== "arrival" || req.method !== "POST") return send(res, 404, { error: { code: "not_found_opaque", retryable: false } });
    st.posts += 1;
    const key = String(req.headers["x-key"] ?? "");
    const held = st.keys.get(key);
    if (held && held.hash !== raw) return send(res, 409, { error: { code: "conflict", retryable: false } });
    if (held && held.body !== null) {
      st.replays += 1;
      if (st.dropReplays > 0) { st.dropReplays -= 1; return res.destroy(); }
      return send(res, 200, held.body, { "x-replayed": "true" });
    }
    if (held) return send(res, 409, { error: { code: "conflict", retryable: true, message: "A request with this Idempotency-Key is still running." } });
    const fault = st.faults.shift();
    if (fault === "refuse") return send(res, 422, { error: { code: "validation", retryable: false } });
    if (fault === "fail_before_save") return send(res, 500, { error: { code: "server", retryable: true } });
    st.keys.set(key, { hash: raw, body: null });
    if (fault === "slow") await new Promise((r) => setTimeout(r, 1500));
    const n = st.rows.length + 1;
    const body = JSON.parse(raw) as { unidentifiedRef: string };
    st.rows.push({ patientId: uuid(n), visitId: uuid(100 + n), johnDoeRef: body.unidentifiedRef, arrivedAt: new Date().toISOString() });
    const ack = { ok: true, id: uuid(n), visitId: uuid(100 + n) };
    if (fault === "fail_after_save") { st.keys.delete(key); return send(res, 500, { error: { code: "server", retryable: true } }); }
    st.keys.set(key, { hash: raw, body: ack });
    if (fault === "drop") return res.destroy();
    return send(res, 200, ack);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { st, base: `http://127.0.0.1:${(server.address() as { port: number }).port}/d`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const profile = (base: string, lookup: boolean) => DoorProfile.parse({
  base_url: base, timeout_ms: 1000,
  headers: { on_behalf_of: "X-For", origin: "X-Origin", evidence: "X-Evidence", spoken_at: "X-Spoken", idempotency: "X-Key", replayed: "X-Replayed" },
  origin_value: "voice", deny: ["stay/out/done"],
  ops: {
    read_admission: { method: "GET", path: "stay/{admission_id}", label: "name", facts: {}, proof: {} },
    write_observation: { method: "POST", path: "stay/entry", body: {}, writes_path: "writes", primary_store: "obs" }
  },
  work: {
    [EMERGENCY_KIND]: {
      method: "POST", path: "arrival", body: { unidentifiedRef: "$unidentified_ref", arrivalEmergencyReason: "$reason", clinicId: "$clinic_id" },
      ack: { id_path: "id", store: "patient", also: { visit: "visitId" } },
      proof: { path: "board", find: { list: "rows", where: { patientId: "$record_id" } }, checks: { visitId: "@nonnull" } },
      ...(lookup ? { lookup: { path: "board", find: { list: "rows", where: { johnDoeRef: "$unidentified_ref" } }, id: "patientId", made_at: "arrivedAt", also: { visit: "visitId" } } } : {})
    }
  },
  owners: [{ id: DOC, label: "Doctor", kinds: [EMERGENCY_KIND] }],
  targets: { admission_by_patient: {}, episode_by_admission: {} }
});

function boot(base: string, lookup: boolean, root = mkdtempSync(join(tmpdir(), "hp-f4-"))) {
  let rt: EmrRuntime | null = null;
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: () => { throw new Error("no model call is expected"); }, taskStateOf: (id) => rt?.stateOf(id) ?? null });
  const port = new PisgahPort(profile(base, lookup), { bearers: { [DOC]: "b-doc" } });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1, reconcileMs: [300, 300] });
  rt.start();
  return { rt, root, client };
}
const arrive = (rt: EmrRuntime, ref = "Unknown arrival 10:00") => rt.emergency(DOC, { text: "hey Pisgah, emergency", spoken_at: new Date().toISOString(), args: { unidentified_ref: ref, reason: "Emergency arrival", clinic_id: CLINIC } });
const types = (root: string, id: string) => readStream(root, `emr/${id}`).map((e) => e.record_type);
const settledOn = async (rt: EmrRuntime, id: string, state: string, ms = 8000) => {
  const end = Date.now() + ms;
  while (rt.view(id)!.actions[0]!.state !== state) { if (Date.now() > end) throw new Error(`still ${rt.view(id)!.actions[0]!.state}`); await new Promise((r) => setTimeout(r, 20)); }
};

describe("an arrival whose answer is lost, over a door with a key store", () => {
  it("lost once (the connection drops after the save): replayed under the same key, one arrival", async () => {
    const d = await door();
    d.st.faults.push("drop");
    const { rt, root, client } = boot(d.base, false);
    const r = await arrive(rt);
    await settledOn(rt, r.task_id, "completed");
    expect(d.st.rows).toHaveLength(1);
    expect(d.st.replays).toBe(1);
    expect(types(root, r.task_id)).toContain("action.uncertain");
    expect(rt.view(r.task_id)!.patient_id).toBe(uuid(1));
    await rt.stop(); client.close(); await d.close();
  });

  it("lost twice (the reply times out and the retry finds it still running): uncertain, never failed, then the stored result", async () => {
    const d = await door();
    d.st.faults.push("slow");
    const { rt, root, client } = boot(d.base, false);
    const r = await arrive(rt);
    await settledOn(rt, r.task_id, "uncertain");
    expect(rt.view(r.task_id)!.state).toBe("running");
    await settledOn(rt, r.task_id, "completed");
    expect(d.st.rows).toHaveLength(1);
    const ev = types(root, r.task_id);
    expect(ev.filter((e) => e === "action.uncertain").length).toBeGreaterThanOrEqual(2);
    expect(ev).not.toContain("action.failed");
    await rt.stop(); client.close(); await d.close();
  });

  it("lost, then a restart: the next process reconciles it under the same key and makes no second arrival", async () => {
    const d = await door();
    d.st.faults.push("drop");
    // Every answer the first process could get is lost, so it stops with the arrival saved and its outcome unknown.
    d.st.dropReplays = 3;
    const first = boot(d.base, false);
    const r = await arrive(first.rt);
    await settledOn(first.rt, r.task_id, "uncertain");
    while (d.st.dropReplays > 0) await new Promise((res) => setTimeout(res, 20));
    await first.rt.stop(); first.client.close();
    const again = boot(d.base, false, first.root);
    await settledOn(again.rt, r.task_id, "completed");
    expect(d.st.rows).toHaveLength(1);
    expect(types(first.root, r.task_id)).not.toContain("action.failed");
    await again.rt.stop(); again.client.close(); await d.close();
  });

  it("a door that fails after its save and frees the key: found by the record before any retry, one arrival", async () => {
    const d = await door();
    d.st.faults.push("fail_after_save");
    const { rt, root, client } = boot(d.base, true);
    const r = await arrive(rt, "Unknown arrival 10:01");
    await settledOn(rt, r.task_id, "completed");
    expect(d.st.rows).toHaveLength(1);
    expect(d.st.posts).toBe(1);
    expect(types(root, r.task_id)).toContain("action.reconciled");
    expect(rt.view(r.task_id)).toMatchObject({ patient_id: uuid(1), visit_id: uuid(101) });
    await rt.stop(); client.close(); await d.close();
  });

  it("an older arrival with the same label is never taken for this one", async () => {
    const d = await door();
    d.st.rows.push({ patientId: uuid(90), visitId: uuid(190), johnDoeRef: "Unknown arrival 10:02", arrivedAt: new Date(Date.now() - 3600_000).toISOString() });
    d.st.faults.push("fail_before_save");
    const { rt, root, client } = boot(d.base, true);
    const r = await arrive(rt, "Unknown arrival 10:02");
    await settledOn(rt, r.task_id, "completed");
    expect(d.st.rows).toHaveLength(2);
    expect(rt.view(r.task_id)!.patient_id).toBe(uuid(2));
    expect(types(root, r.task_id)).not.toContain("action.reconciled");
    await rt.stop(); client.close(); await d.close();
  });

  it("a definite 4xx stays refused, never uncertain", async () => {
    const d = await door();
    d.st.faults.push("refuse");
    const { rt, root, client } = boot(d.base, true);
    const r = await arrive(rt);
    await settledOn(rt, r.task_id, "refused");
    expect(types(root, r.task_id)).not.toContain("action.uncertain");
    expect(d.st.rows).toHaveLength(0);
    expect(d.st.posts).toBe(1);
    await rt.stop(); client.close(); await d.close();
  });
});
