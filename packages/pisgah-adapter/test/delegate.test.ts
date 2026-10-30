import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { DoorProfile } from "../src/profile.js";
import { PisgahPort } from "../src/port.js";

const PAT = "33333333-4444-4555-8666-777777777777";
const ADM = "11111111-2222-4333-8444-555555555555";
const CLINIC = "66666666-4444-4555-8666-777777777777";
const TASK = "88888888-4444-4555-8666-777777777777";
const DOC = "doc-owner", SURG = "surg-owner";
const prov = (owner: string) => ({ owner, evidence: "transcript:u-1", spoken_at: "2026-10-29T09:00:00.000Z" });

// A stand-in door with made-up routes for the delegation record.
async function door() {
  const seen: { path: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    const url = new URL(req.url ?? "/", "http://door");
    const path = url.pathname.replace(/^\/d\//, "");
    seen.push({ path: `${req.method} ${path}${url.search}`, body });
    const send = (s: number, j: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    const row = { id: TASK, kind: "review", title: "Surgical review", patientId: PAT, admissionId: ADM, visitId: null, state: "acknowledged", assignee: { facilityUserId: SURG, rule: "on_duty" }, acknowledgedAt: "2026-10-29T09:05:00.000Z", completedAt: null, dueAt: "2026-10-29T10:00:00.000Z", overdue: false, escalatedAt: null };
    if (path === "tasks" && req.method === "POST") return send(200, { ok: true, id: TASK, status: "assigned" });
    if (path === "desk/register" && req.method === "POST") { seen.at(-1)!.path += ` auth=${req.headers["x-auth"] ?? "none"}`; return send(200, { ok: true, id: PAT }); }
    if (path === "tasks") return send(200, { rows: [row] });
    if (path === `tasks/${TASK}`) return send(200, { ...row, instruction: "surgical review of the abdomen", record: { status: "verified", recordId: CLINIC, detail: "done" }, nudged: ["nudge:new"], nudgedKeys: "nudge:new" });
    send(404, { error: { code: "not_found_opaque" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, base: `http://127.0.0.1:${(server.address() as { port: number }).port}/d`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const profile = (base: string) => DoorProfile.parse({
  base_url: base, timeout_ms: 2000,
  headers: { on_behalf_of: "X-For", origin: "X-Origin", evidence: "X-Evidence", spoken_at: "X-Spoken", idempotency: "X-Key", replayed: "X-Replayed", authorisation: "X-Auth" },
  origin_value: "voice", deny: ["tasks/sign"],
  ops: {
    read_admission: { method: "GET", path: "stay/{admission_id}", label: "name", facts: {}, proof: {} },
    write_observation: { method: "POST", path: "stay/entry", body: {}, writes_path: "writes", primary_store: "obs" }
  },
  work: {
    complete_registration: { method: "POST", path: "desk/register", body: { patientId: "$patient_id", phone: "$phone", consent: { purposes: "$consent_purposes", notice: "n-1", evidence: "$evidence", spokenAt: "$consent_spoken_at" } }, ack: { id_path: "id", store: "patient" }, proof: { path: "tasks/{delegation_id}", checks: { id: "$delegation_id" } } },
    delegate_task: { method: "POST", path: "tasks", body: { kind: "$task_kind", patientId: "$patient_id", admissionId: "$admission_id", subject: "$subject", title: "$title", instruction: "$instruction", evidence: "$evidence", assignee: "$assignee", dueAt: "$due_at" }, ack: { id_path: "id", store: "delegation" }, proof: { path: "tasks/{record_id}", checks: { id: "$record_id" } } }
  },
  owners: [
    { id: DOC, label: "Doctor", kinds: ["delegate_task"], delegation: "delegator" },
    { id: SURG, label: "Surgeon", kinds: ["acknowledge_task", "complete_registration"], delegation: "assignee" }
  ],
  delegations: {
    list: { path: "tasks", query: { as: "$as" }, list_path: "rows" },
    one: { path: "tasks/{delegation_id}" },
    teams: { surgery: { words: ["surgical", "surgery"], task_kind: "review", title: "Surgical review", label: "Surgery", role: "doctor", clinic_id: CLINIC } }
  },
  targets: { admission_by_patient: {}, episode_by_admission: {} },
  value_maps: { consent_purposes: { registration: "enrolment", scribe: "ai_notes" } }
});

describe("delegation through the door", () => {
  it("names the team's place from the profile, never from the words, and reads both sides of the record", async () => {
    const d = await door();
    try {
      const port = new PisgahPort(profile(d.base), { bearers: { [DOC]: "b".repeat(30), [SURG]: "c".repeat(30) } });
      const c = await port.commit("delegate_task", { task_kind: "review", team: "surgery", patient_id: PAT, admission_id: ADM, subject_table: "admissions", subject_id: ADM, title: "Surgical review", instruction: "surgical review", evidence: "transcript:u-1", due_at: "2026-10-29T10:00:00.000Z" }, "k-1", prov(DOC));
      expect(c).toMatchObject({ ok: true, record_id: TASK });
      expect(d.seen.find((x) => x.path === "POST tasks")!.body).toEqual({ kind: "review", patientId: PAT, admissionId: ADM, subject: { table: "admissions", id: ADM }, title: "Surgical review", instruction: "surgical review", evidence: "transcript:u-1", assignee: { role: "doctor", clinicId: CLINIC }, dueAt: "2026-10-29T10:00:00.000Z" });
      expect(await port.prove("delegate_task", { team: "surgery" }, { record_id: TASK, record_version: 1, event_ids: [] }, prov(DOC))).not.toBeNull();
      expect(port.delegationTeams(DOC)).toEqual({ surgery: { words: ["surgical", "surgery"], task_kind: "review", title: "Surgical review", label: "Surgery" } });
      expect(port.delegationTeams(SURG)).toEqual({});
      expect(port.delegationOwners()).toEqual([DOC, SURG]);
      const listed = await port.delegations(SURG, "assignee", prov(SURG));
      expect(listed).toMatchObject([{ id: TASK, kind: "review", patient_id: PAT, admission_id: ADM, acknowledged_at: "2026-10-29T09:05:00.000Z", record: { status: "unsupported_or_incomplete" } }]);
      expect(d.seen.some((x) => x.path === "GET tasks?as=assignee")).toBe(true);
      const one = await port.delegation(DOC, TASK, prov(DOC));
      expect(one).toMatchObject({ record: { status: "verified", record_id: CLINIC }, instruction: "surgical review of the abdomen", nudged: ["nudge:new"] });
      // A delegation id that is not an id is never read.
      expect(await port.delegation(DOC, "../sign", prov(DOC))).toBeNull();
    } finally {
      await d.close();
    }
  });

  it("sends only the consent purposes heard, in the hospital's own names, and the consent line's matched voice when there is one", async () => {
    const d = await door();
    try {
      const port = new PisgahPort(profile(d.base), { bearers: { [DOC]: "b".repeat(30), [SURG]: "c".repeat(30) } });
      const args = { delegation_id: TASK, patient_id: PAT, surname: "Okafor", other_names: "Grace", phone: "08031234567", evidence: "transcript:c-1", consent_purposes: ["registration", "tests", "scribe"], consent_spoken_at: "2026-10-29T09:00:00.000Z" };
      expect(await port.commit("complete_registration", args, "k-2", prov(SURG))).toMatchObject({ ok: true, record_id: PAT });
      const voiced = { ...prov(SURG), voice: { authorisation: `transcript:c-1~v2.1761700000000.${"A".repeat(22)}.${"B".repeat(43)}` } };
      expect(await port.commit("complete_registration", { ...args, consent_purposes: ["tests"] }, "k-3", voiced)).toMatchObject({ ok: true });
      const sent = d.seen.filter((x) => x.path.startsWith("POST desk/register"));
      // A purpose the hospital has no name for is left out, and a list with none left is not sent at all.
      expect(sent[0]!.body).toEqual({ patientId: PAT, phone: "08031234567", consent: { purposes: ["enrolment", "ai_notes"], notice: "n-1", evidence: "transcript:c-1", spokenAt: "2026-10-29T09:00:00.000Z" } });
      expect(sent[0]!.path).toBe("POST desk/register auth=none");
      expect(sent[1]!.body).toEqual({ patientId: PAT, phone: "08031234567", consent: { notice: "n-1", evidence: "transcript:c-1", spokenAt: "2026-10-29T09:00:00.000Z" } });
      expect(sent[1]!.path).toMatch(/^POST desk\/register auth=transcript:c-1~v2\./);
    } finally {
      await d.close();
    }
  });
});
