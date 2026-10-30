import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACK_KIND, COMPLETE_KIND, DELEGATE_KIND, ESCALATE_KIND, NUDGE_KIND, REGISTER_KIND, WARD_REVIEW_KIND, startEmrServe, type EmrRuntime, type EmrTaskView } from "@hey-pisgah/agent";
import { ModelClient } from "@hey-pisgah/model";
import { loadProfile } from "../src/profile.js";
import { PisgahPort, type DoorLog } from "../src/port.js";
import { personCaller } from "../src/journey.sandbox.js";
import { SandboxBlock, mintAgentBearer, sandboxQuery } from "../src/sandbox.js";

// Runs only with SANDBOX=1 and a private checks file in SANDBOX_E4_CHECKS, against the loopback sandbox in the private door profile; record checks use read-only SQL.
const RUN = process.env["SANDBOX"] === "1" && !!process.env["SANDBOX_E4_CHECKS"];
// The two routes the negative controls probe with an agent bearer, and the hospital site, kept in the private checks file.
type Checks = { review_note_path: string; clock_on_path: string; facility_id: string };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SAY_DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

describe.skipIf(!RUN)("E4 delegation between three agents on the sandbox EMR", () => {
  it("hands the surgical review and the registration on, takes a spoken acceptance, closes each from the record, reports back, and refuses what no role holds", async () => {
    const profile = loadProfile();
    const checks = JSON.parse(readFileSync(process.env["SANDBOX_E4_CHECKS"]!, "utf8")) as Checks;
    const sb = SandboxBlock.parse(profile.sandbox);
    const clinic = process.env["HEY_PISGAH_EMERGENCY_CLINIC"];
    expect(clinic, "the A&E clinic id").toMatch(/^[0-9a-f-]{36}$/);
    const who = (login: string) => sb.owners.find((o) => o.login === login)!;
    const doc = mintAgentBearer(sb);
    const surg = mintAgentBearer(sb, who("dr.ime"));
    const desk = mintAgentBearer(sb, who("reception.b3"));
    const requests: DoorLog[] = [];
    const port = new PisgahPort(profile, { bearers: { [doc.owner]: doc.bearer, [surg.owner]: surg.bearer, [desk.owner]: desk.bearer }, onRequest: (l) => requests.push(l) });
    const root = mkdtempSync(join(tmpdir(), "hp-e4-"));
    let rt: EmrRuntime | null = null;
    const client = new ModelClient({ storeRoot: root, mode: "live", recordingsDir: join(root, "recordings"), taskStateOf: (id) => rt?.stateOf(id) ?? null });
    const s = await startEmrServe({ storeRoot: root, port, client, listenPort: Number(process.env["HEY_PISGAH_EMR_PORT"] ?? 4109), emergencyClinicId: clinic!, ears: "off", runtime: { holdMs: 1500, proofRetryMs: 1500, watchMs: 5000, obligationTickMs: 1000 }, log: (x) => process.stderr.write(`serve: ${x}\n`) });
    rt = s.runtime;
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const until = async <T>(what: string, read: () => T | null | undefined | false, ms = 120_000): Promise<T> => {
      const end = Date.now() + ms;
      for (;;) { const v = read(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await wait(500); }
    };
    const viewOf = (owner: string) => s.runtime.views(owner);
    const say = async (taskId: string, text: string) => {
      process.stderr.write(`say ${taskId}: ${text}\n`);
      const r = await post(`/tasks/${taskId}/say`, { text, spokenAt: new Date().toISOString() });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      await s.runtime.settled(8 * 60_000);
      return r.body as { line_id: string };
    };
    const person = personCaller(profile, sb, new Map(), requests);
    const done = (v: EmrTaskView, kind: string) => v.actions.filter((a) => a.kind === kind && a.state === "completed");
    const phone = `0803${String(Date.now()).slice(-7)}`;
    const result: Record<string, unknown> = {};
    let taskId = "";
    try {
      // The doctor's agent opens the unnamed arrival by rule, and the spoken name is held for the front desk and handed to it.
      const er = await post("/tasks/emergency", { owner: doc.owner, spokenAt: new Date().toISOString() });
      expect(er.status).toBe(202);
      taskId = String(er.body["task_id"]);
      await until("the arrival", () => s.runtime.view(taskId)!.patient_id);
      await s.runtime.settled();
      const patient = s.runtime.view(taskId)!.patient_id!;
      const named = await say(taskId, "Her name is Grace Okafor.");
      await say(taskId, "Admit her as an emergency to the A and E ward for acute abdominal pain.");
      const review = await say(taskId, "Surgical review in one hour.");
      await say(taskId, "Put her on a bed in A and E.");
      const doctor = await until("the ward review request", () => { const v = s.runtime.view(taskId)!; return done(v, WARD_REVIEW_KIND).length ? v : null; }, 180_000);
      expect(done(doctor, DELEGATE_KIND)).toHaveLength(2);
      const reviewTask = doctor.delegations.find((d) => d.task_kind === "review")!;
      const regTask = doctor.delegations.find((d) => d.task_kind === "registration")!;
      expect(reviewTask).toMatchObject({ line_id: review.line_id, team: "surgery" });
      expect(regTask).toMatchObject({ line_id: named.line_id, team: "front_desk" });
      const admission = doctor.admission_id;
      result["admission"] = admission;

      // The surgeon's agent finds the task and rings the surgeon's bell; the preview names no one.
      const surgView = await until("the surgeon's nudge", () => viewOf(surg.owner).find((v) => v.admission_id === s.runtime.view(taskId)!.admission_id && done(v, NUDGE_KIND).length));
      expect(surgView.notes.at(-1)!.text).toMatch(/^New task for you: Surgical review, due/);
      // A completion the record does not show is refused by the EMR, so acknowledgement alone can never pass as done.
      const early = await port.commit(COMPLETE_KIND, { delegation_id: reviewTask.delegation_id, title: "Surgical review", found_record_id: patient, evidence: `transcript:${review.line_id}` }, `e4-early-${reviewTask.delegation_id}`, { owner: doc.owner, evidence: `transcript:${review.line_id}`, spoken_at: new Date().toISOString() });
      expect(early).toMatchObject({ ok: false });
      result["false_completion"] = early.ok ? "accepted" : early.reason;

      // The surgeon opens the patient from the bell and says "accepted surgical review"; it acknowledges that one task and nothing else.
      const accept = await post("/tasks/say", { owner: surg.owner, admissionId: s.runtime.view(taskId)!.admission_id, text: "Accepted surgical review.", spokenAt: new Date().toISOString() });
      expect(accept.status, JSON.stringify(accept.body)).toBe(202);
      await s.runtime.settled();
      await until("the acknowledgement", () => viewOf(surg.owner).find((v) => done(v, ACK_KIND).length));
      await until("the doctor's agent seeing the acknowledgement", () => s.runtime.view(taskId)!.delegations.find((d) => d.task_kind === "review" && d.acknowledged_at));
      expect(done(s.runtime.view(taskId)!, COMPLETE_KIND).filter((a) => a.args["delegation_id"] === reviewTask.delegation_id)).toHaveLength(0);

      // The surgeon writes the review note as a person; the agent of either side cannot.
      const requestId = done(doctor, WARD_REVIEW_KIND)[0]!.proof!.record_id;
      const agentNote = await fetch(`${profile.base_url}/${checks.review_note_path}`, { method: "POST", headers: { authorization: `Bearer ${surg.bearer}`, "content-type": "application/json", [profile.headers.on_behalf_of]: surg.owner, [profile.headers.origin]: "voice", [profile.headers.evidence]: "transcript:e4-agent-note", [profile.headers.spoken_at]: new Date().toISOString() }, body: JSON.stringify({ requestId, content: "Not the agent's to write." }) });
      result["agent_review_note"] = agentNote.status;
      expect(agentNote.status).toBeGreaterThanOrEqual(400);
      const note = await person("complete_review", { request_id: requestId, content: "Surgical review: tender right iliac fossa, guarding. Keep nil by mouth, ultrasound, review with result." });
      expect(note.ok, JSON.stringify(note)).toBe(true);
      const closed = await until("the doctor's agent closing the review from the record", () => { const v = s.runtime.view(taskId)!; return v.delegations.find((d) => d.task_kind === "review" && d.completed_at) ? v : null; });
      expect(closed.notes.some((n) => n.text.startsWith("Done: Surgical review. The record shows it"))).toBe(true);

      // The front desk's agent was nudged with what the registration needs; the overdue deadline rang the bell once.
      const deskView = await until("the desk's nudge", () => viewOf(desk.owner).find((v) => v.patient_id === patient && done(v, NUDGE_KIND).length));
      expect(done(deskView, NUDGE_KIND)[0]!.args).toMatchObject({ needs: ["phone", "consent"] });
      await until("the overdue escalation", () => done(s.runtime.view(taskId)!, ESCALATE_KIND).length);
      const spoken = phone.split("").map((d) => SAY_DIGITS[Number(d)]).join(" ");
      const consent = await post("/tasks/say", { owner: desk.owner, patientId: patient, text: `Her phone is ${spoken} and she consents to registration.`, spokenAt: new Date().toISOString() });
      expect(consent.status, JSON.stringify(consent.body)).toBe(202);
      await s.runtime.settled();
      await until("the registration", () => viewOf(desk.owner).find((v) => v.patient_id === patient && done(v, REGISTER_KIND).length), 120_000);
      const named2 = await until("the identity closing on the doctor's side", () => { const v = s.runtime.view(taskId)!; return v.identities[0]?.state === "done" ? v : null; });
      expect(named2.delegations.find((d) => d.task_kind === "registration")!.completed_at).not.toBeNull();

      // Negative controls: a task for a role without the permission, and an agent going on duty.
      const wrong = await port.commit(DELEGATE_KIND, { task_kind: "dispense", team: "wrong_team", patient_id: patient, title: "Dispense the order", instruction: "ZZ-TEST control", evidence: `transcript:${review.line_id}` }, `e4-wrong-${patient}`, { owner: doc.owner, evidence: `transcript:${review.line_id}`, spoken_at: new Date().toISOString() });
      expect(wrong).toMatchObject({ ok: false });
      result["wrong_role"] = wrong.ok ? "accepted" : wrong.reason;
      const clockOn = await fetch(`${profile.base_url}/${checks.clock_on_path}`, { method: "POST", headers: { authorization: `Bearer ${doc.bearer}`, "content-type": "application/json", [profile.headers.on_behalf_of]: doc.owner, [profile.headers.origin]: "voice", [profile.headers.evidence]: "transcript:e4-clock-on", [profile.headers.spoken_at]: new Date().toISOString() }, body: JSON.stringify({ facilityId: checks.facility_id }) });
      result["agent_clock_on"] = { status: clockOn.status, body: (await clockOn.text()).slice(0, 160) };
      expect(clockOn.status).toBe(409);
      expect(sandboxQuery(sb, "duty_rows", { agent: doc.agent! })[0]!["n"]).toBe(0);

      // The record: three agents, each state separate, each write on behalf of its own clinician with its own words.
      const rows = sandboxQuery(sb, "delegations_for", { patient });
      result["delegations"] = rows;
      const rev = rows.find((r) => r["kind"] === "review")!;
      expect(rev).toMatchObject({ delegated_by: doc.agent, on_behalf_of: doc.owner, assignee: surg.owner, rule: "on_duty", acknowledged_by: surg.owner, acknowledged_via: surg.agent, completed_by: doc.agent });
      const reg = rows.find((r) => r["kind"] === "registration")!;
      expect(reg).toMatchObject({ assignee: desk.owner, rule: "only_member", completion_record_id: patient });
      expect(reg["escalated_at"]).not.toBeNull();
      expect(sandboxQuery(sb, "patient_identity", { patient })[0]).toMatchObject({ is_unidentified: false });
      const bells = [...sandboxQuery(sb, "bell_for", { delegation: String(rev["id"]) }), ...sandboxQuery(sb, "bell_for", { delegation: String(reg["id"]) })];
      result["bells"] = bells;
      expect(bells.length).toBeGreaterThanOrEqual(3);
      for (const b of bells) for (const word of ["Grace", "Okafor", "Unknown arrival", phone]) expect(`${b["title"]} ${b["body"]}`).not.toContain(word);
      const audit = sandboxQuery(sb, "audit_for_patient", { patient });
      result["audit"] = audit.filter((a) => String(a["action_type"]).startsWith("delegation.") || ["admission.ward_review_requested", "patient.identity_completed"].includes(String(a["action_type"])));
      expect(audit.find((a) => a["action_type"] === "admission.ward_review_requested")).toMatchObject({ actor: doc.agent, agent: doc.agent, on_behalf_of: doc.owner, origin: "voice" });
      expect(audit.find((a) => a["action_type"] === "delegation.acknowledged")).toMatchObject({ actor: surg.agent, on_behalf_of: surg.owner, evidence: `transcript:${String((accept.body as { line_id: string }).line_id)}` });
      expect(audit.find((a) => a["action_type"] === "patient.identity_completed")).toMatchObject({ actor: desk.agent, on_behalf_of: desk.owner, evidence: `transcript:${String((consent.body as { line_id: string }).line_id)}` });
      const speed = [...viewOf(doc.owner), ...viewOf(surg.owner), ...viewOf(desk.owner)].flatMap((v) => v.speed.rows.map((r) => ({ owner: v.owner === doc.owner ? "doctor" : v.owner === surg.owner ? "surgeon" : "desk", kind: r.kind, ms: r.ms })));
      result["speed"] = speed;
      result["calls"] = [...viewOf(doc.owner), ...viewOf(surg.owner), ...viewOf(desk.owner)].reduce((n, v) => ({ calls: n.calls + v.calls, usd: n.usd + v.usd }), { calls: 0, usd: 0 });
      result["strips"] = { doctor: s.runtime.view(taskId)!.notes.map((n) => n.text), surgeon: viewOf(surg.owner).flatMap((v) => v.notes.map((n) => n.text)), desk: viewOf(desk.owner).flatMap((v) => v.notes.map((n) => n.text)) };
    } finally {
      if (taskId) result["doctor_view"] = s.runtime.view(taskId);
      if (process.env["SANDBOX_E4_OUT"]) writeFileSync(process.env["SANDBOX_E4_OUT"], JSON.stringify({ result, requests: requests.map((r) => ({ at: r.at, method: r.method, path: r.path, status: r.status, ms: r.ms, reason: r.reason })) }, null, 1));
      await s.close();
      client.close();
    }
  }, 30 * 60_000);
});
