import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EMERGENCY_KIND, startEmrServe, type EmrRuntime, type EmrTaskView } from "@hey-pisgah/agent";
import { ModelClient } from "@hey-pisgah/model";
import { loadProfile } from "../src/profile.js";
import { PisgahPort, type DoorLog } from "../src/port.js";
import { SandboxBlock, mintAgentBearer, sandboxQuery } from "../src/sandbox.js";

// Runs only with SANDBOX=1 and a private checks file in SANDBOX_E1_CHECKS, against the loopback sandbox in the private door profile; assertions read the record with read-only SQL.
const RUN = process.env["SANDBOX"] === "1" && !!process.env["SANDBOX_E1_CHECKS"];
type Checks = { opened_kind: string; consent_path: string; consent_body: Record<string, string> };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)("E1 on the sandbox EMR: the unidentified arrival by voice", () => {
  it("opens an unnamed arrival from the spoken line under the doctor's agent with provenance and the A&E clinic, holds the spoken identity, and refuses agent consent", async () => {
    const profile = loadProfile();
    const checks = JSON.parse(readFileSync(process.env["SANDBOX_E1_CHECKS"]!, "utf8")) as Checks;
    const sb = SandboxBlock.parse(profile.sandbox);
    const clinic = process.env["HEY_PISGAH_EMERGENCY_CLINIC"];
    expect(clinic, "the A&E clinic id").toMatch(/^[0-9a-f-]{36}$/);
    const minted = mintAgentBearer(sb);
    const requests: DoorLog[] = [];
    const port = new PisgahPort(profile, { bearers: { [minted.owner]: minted.bearer }, onRequest: (l) => requests.push(l) });
    const root = mkdtempSync(join(tmpdir(), "hp-e1-"));
    let rt: EmrRuntime | null = null;
    const client = new ModelClient({ storeRoot: root, mode: "live", recordingsDir: join(root, "recordings"), taskStateOf: (id) => rt?.stateOf(id) ?? null });
    const s = await startEmrServe({ storeRoot: root, port, client, listenPort: 0, emergencyClinicId: clinic!, ears: "off", runtime: { holdMs: 0, proofRetryMs: 1500 } });
    rt = s.runtime;
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const view = (id: string): EmrTaskView => s.runtime.view(id)!;
    const until = async (id: string, ok: (v: EmrTaskView) => boolean, ms: number) => {
      const end = Date.now() + ms;
      for (;;) { const v = view(id); if (ok(v)) return v; if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v.actions)}`); await wait(250); }
    };
    try {
      const spokenAt = new Date(Date.now() - 400).toISOString();
      const opened = await post("/tasks/emergency", { owner: minted.owner, spokenAt, text: "hey Pisgah, emergency, young man after a road crash" });
      expect(opened.status).toBe(202);
      const taskId = String(opened.body["task_id"]);
      const lineId = String(opened.body["line_id"]);
      const v = await until(taskId, (x) => x.actions[0]?.state === "completed" || x.actions[0]?.state === "refused" || x.actions[0]?.state === "failed", 60_000);
      expect(v.actions[0]).toMatchObject({ kind: EMERGENCY_KIND, state: "completed" });
      const patient = v.patient_id!;
      expect(v).toMatchObject({ unidentified: true, visit_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      const [arrival] = sandboxQuery(sb, "e1_arrival", { patient });
      expect(arrival).toMatchObject({ visit_id: v.visit_id, clinic, emergency: true, unnamed: true, consent_at: null, reason: "Emergency arrival: young man after a road crash" });
      const audit = sandboxQuery(sb, "e1_audit", { patient });
      expect(audit.find((a) => a["kind"] === checks.opened_kind)).toMatchObject({ agent: minted.agent, on_behalf_of: minted.owner, origin: profile.origin_value, evidence: `transcript:${lineId}` });
      expect(v.speed.rows[0]).toMatchObject({ kind: EMERGENCY_KIND, from: spokenAt });

      // The clinician names the patient: held as an open obligation for the front desk, nothing written to the record.
      const before = requests.filter((r) => r.method === "POST").length;
      const named = await post("/tasks/say", { owner: minted.owner, patientId: patient, text: "Her name is Grace Okafor, phone 0803 123 4567" });
      expect(named.status).toBe(202);
      await s.runtime.settled();
      expect(view(taskId).identities).toEqual([expect.objectContaining({ kind: "identity_pending", state: "open", name: "Grace Okafor", phone: "08031234567", said_by: minted.owner, line_id: named.body["line_id"], encounter: { patient_id: patient, visit_id: v.visit_id } })]);
      expect(requests.filter((r) => r.method === "POST").length).toBe(before);
      expect(sandboxQuery(sb, "e1_arrival", { patient })[0]).toMatchObject({ unnamed: true, consent_at: null });

      // An agent may never stamp the patient's consent.
      const h = profile.headers;
      const body = Object.fromEntries(Object.entries(checks.consent_body).map(([k, x]) => [k, x === "$visit_id" ? v.visit_id : x === "$patient_id" ? patient : x === "$uuid" ? randomUUID() : x]));
      const consent = await fetch(`${profile.base_url.replace(/\/+$/, "")}/${checks.consent_path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${minted.bearer}`, "content-type": "application/json", [h.on_behalf_of]: minted.owner, [h.origin]: profile.origin_value, [h.evidence]: `transcript:${lineId}`, [h.spoken_at]: spokenAt, [h.idempotency]: `e1-${randomUUID()}` },
        body: JSON.stringify(body)
      });
      // The door answers this refusal as an opaque 404, as it does for every agent refusal.
      expect(consent.status).toBe(404);
      expect(sandboxQuery(sb, "e1_arrival", { patient })[0]).toMatchObject({ consent_at: null });
    } finally {
      await s.close();
    }
  }, 180_000);
});
