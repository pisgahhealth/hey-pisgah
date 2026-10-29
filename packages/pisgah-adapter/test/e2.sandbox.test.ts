import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startEmrServe, type EmrRuntime, type EmrTaskView, type Provenance } from "@hey-pisgah/agent";
import { ModelClient } from "@hey-pisgah/model";
import type { DoorLog } from "../src/port.js";
import { PisgahPort } from "../src/port.js";
import { loadProfile } from "../src/profile.js";
import { personCaller } from "../src/journey.sandbox.js";
import { SandboxBlock, mintAgentBearer, sandboxQuery } from "../src/sandbox.js";

// Runs only with SANDBOX=1 against the loopback sandbox named in the private profile; record checks use read-only SQL.
const RUN = process.env["SANDBOX"] === "1";
const now = () => new Date().toISOString();

// A fresh synthetic arrival, registered and paid by the desk person, so no other run's patient is touched.
export async function freshArrival(profile = loadProfile()): Promise<{ patient: string; visit: string; sb: SandboxBlock; person: ReturnType<typeof personCaller>; log: DoorLog[] }> {
  const sb = SandboxBlock.parse(profile.sandbox);
  const log: DoorLog[] = [];
  const call = personCaller(profile, sb, new Map(), log);
  // A keep-alive socket the app already closed resets once; the person step is tried again on a fresh one.
  const person: typeof call = async (op, vars) => { try { return await call(op, vars); } catch { return call(op, vars); } };
  const tag = Date.now().toString(36);
  const reg = await person("register", { name: `${sb.scrub[0] ?? ""}E2 Child ${tag}`, phone: `0803${String(Date.now()).slice(-7)}` });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${reg.note ?? ""}`);
  const patient = String((reg.json as { id: string }).id);
  const visit = String(sandboxQuery(sb, "visit_for_patient", { patient })[0]?.["id"] ?? "");
  if (!visit) throw new Error("the arrival has no visit");
  const paid = await person("mark_paid", { visit_id: visit });
  if (!paid.ok) throw new Error(`mark paid failed: ${paid.status} ${paid.note ?? ""}`);
  return { patient, visit, sb, person, log };
}

describe.skipIf(!RUN)("E2 owner-aware consult holder on the sandbox EMR", () => {
  it("lets the doctor's agent open and draft on the owner's consultation, keeps it the person's, names the agent, and refuses another doctor's agent", async () => {
    const profile = loadProfile();
    const { patient, visit, sb, person } = await freshArrival(profile);
    const mine = mintAgentBearer(sb);
    // The private profile lists another doctor last among the owners.
    const other = mintAgentBearer(sb, sb.owners.at(-1)!);
    expect(other.owner).not.toBe(mine.owner);
    // The other doctor's agent holds the same kinds, so its refusal comes from the EMR and not from this port.
    const both = { ...profile, owners: [...profile.owners, { ...profile.owners[0]!, id: other.owner, label: "Another doctor" }] };
    const port = new PisgahPort(both, { bearers: { [mine.owner]: mine.bearer, [other.owner]: other.bearer } });
    const prov = (owner: string, line: string): Provenance => ({ owner, evidence: `transcript:${line}`, spoken_at: now() });

    // The agent opens first: the visit pins to its owner, not to the agent row.
    const open = await port.commit("open_consult", { visit_id: visit, patient_id: patient }, `e2-open-${visit}`, prov(mine.owner, "e2-open"));
    expect(open, JSON.stringify(open)).toMatchObject({ ok: true });
    const pinned = sandboxQuery(sb, "visit_for_patient", { patient })[0]!;
    expect(pinned).toMatchObject({ consultation_state: "in_consultation", assigned_doctor_id: mine.owner });
    expect(await port.prove("open_consult", { visit_id: visit, patient_id: patient }, { record_id: visit, record_version: 1, event_ids: [] }, prov(mine.owner, "e2-open"))).not.toBeNull();

    // The agent drafts the note on the owner's consultation, and the fresh read shows it.
    const args = { visit_id: visit, patient_id: patient, section: "presenting_complaint", text: "Abdominal pain for two days.", note: { presenting_complaint: "Abdominal pain for two days." } };
    const draft = await port.commit("record_clerking", args, `e2-draft-${visit}`, prov(mine.owner, "e2-draft"));
    expect(draft, JSON.stringify(draft)).toMatchObject({ ok: true });
    expect(await port.prove("record_clerking", args, { record_id: visit, record_version: 1, event_ids: [] }, prov(mine.owner, "e2-draft"))).not.toBeNull();
    const drafted = sandboxQuery(sb, "visit_for_patient", { patient })[0]!;
    expect(drafted["assigned_doctor_id"]).toBe(mine.owner);
    expect(drafted["draft_updated_by"]).toBe(mine.agent);

    // The audit trail names the agent beside its owner for the open and the save.
    const audit = sandboxQuery(sb, "audit_for_visit", { visit });
    const opened = audit.find((a) => a["action_type"] === "consultation.opened_by_agent");
    const saved = audit.find((a) => a["action_type"] === "consultation.draft_saved");
    expect(opened).toMatchObject({ actor: mine.agent, agent: mine.agent, on_behalf_of: mine.owner, evidence: "transcript:e2-open" });
    expect(saved).toMatchObject({ actor: mine.agent, agent: mine.agent, on_behalf_of: mine.owner, evidence: "transcript:e2-draft" });

    // Negative control: another doctor's agent can neither open nor draft this consultation.
    const theirOpen = await port.commit("open_consult", { visit_id: visit, patient_id: patient }, `e2-open-other-${visit}`, prov(other.owner, "e2-other-open"));
    expect(theirOpen).toMatchObject({ ok: false });
    expect(theirOpen.ok ? "" : theirOpen.reason).toMatch(/^door_4/);
    const theirDraft = await port.commit("record_clerking", { ...args, text: "Not theirs to write." }, `e2-draft-other-${visit}`, prov(other.owner, "e2-other-draft"));
    expect(theirDraft).toMatchObject({ ok: false });
    expect(theirDraft.ok ? "" : theirDraft.reason).toMatch(/^door_4/);
    expect(sandboxQuery(sb, "visit_for_patient", { patient })[0]).toMatchObject({ assigned_doctor_id: mine.owner, draft_updated_by: mine.agent });

    // The person keeps the consultation: opening it as themselves holds it and sees the agent's draft.
    const self = await person("open_as_doctor", { visit_id: visit, patient_id: patient });
    expect(self.ok, JSON.stringify(self)).toBe(true);
    const body = self.json as { ownedByMe: boolean; draft: { encounterDetailsJson: string | null } | null };
    expect(body.ownedByMe).toBe(true);
    expect(body.draft?.encounterDetailsJson ?? "").toContain("Abdominal pain for two days.");
  }, 15 * 60_000);

  it("clerks by voice: narration into the note, patient speech in its own section, vitals in the note before admission, an allergy, admission on the doctor's authority and a bed in the ward said", async () => {
    const profile = loadProfile();
    const { patient, visit, sb, person } = await freshArrival(profile);
    const mine = mintAgentBearer(sb);
    const port = new PisgahPort(profile, { bearers: { [mine.owner]: mine.bearer } });
    const root = mkdtempSync(join(tmpdir(), "hp-e2-"));
    let rt: EmrRuntime | null = null;
    const client = new ModelClient({ storeRoot: root, mode: "live", recordingsDir: join(root, "recordings"), taskStateOf: (id) => rt?.stateOf(id) ?? null });
    const s = await startEmrServe({ storeRoot: root, port, client, listenPort: Number(process.env["HEY_PISGAH_EMR_PORT"] ?? 4107), runtime: { holdMs: 4000, proofRetryMs: 1500 }, log: (x) => process.stderr.write(`serve: ${x}\n`) });
    rt = s.runtime;
    const say = async (text: string) => {
      process.stderr.write(`say: ${text}\n`);
      const r = await fetch(`${s.url}/tasks/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: mine.owner, patientId: patient, text }) });
      expect(r.status).toBe(202);
      const b = (await r.json()) as { task_id: string; line_id: string };
      await s.runtime.settled(8 * 60_000);
      return b;
    };
    try {
      const first = await say("He has had pain around the belly button moving to the right side since yesterday.");
      await say("Doctor, it really hurts and I have vomited twice this morning.");
      await say("Temperature 38.2, pulse 118.");
      await say("He is allergic to penicillin, it gives him a rash.");
      await say("On examination he is tender in the right iliac fossa with guarding.");
      const adm = await say("Admit him as an emergency to the children's ward for suspected appendicitis.");
      await say("Put him on a bed in the children's ward.");
      const v = s.runtime.view(first.task_id)!;
      const done = (k: string) => v.actions.filter((a) => a.kind === k && a.state === "completed");
      expect(v.actions.filter((a) => a.state !== "completed"), JSON.stringify(v.actions)).toEqual([]);
      expect(done("open_consult")).toHaveLength(1);
      const sections = done("record_clerking").map((a) => a.args["section"]);
      expect(sections).toEqual(expect.arrayContaining(["presenting_complaint", "patient_reported", "vitals", "examination"]));
      expect(v.actions.some((a) => a.kind === "record_clerking" && a.args["section"] === "patient_reported" && /vomited/.test(String(a.args["text"])))).toBe(true);
      expect(v.transcript.find((l) => /vomited/.test(l.text))?.classes).toEqual(["patient_reported"]);

      // The person sees the whole note in their own consultation, with the patient's words in their own section.
      const opened = await person("open_as_doctor", { visit_id: visit, patient_id: patient });
      const details = JSON.parse((opened.json as { draft: { encounterDetailsJson: string } }).draft.encounterDetailsJson) as Record<string, string>;
      const keys = profile.clerking!.sections;
      expect(details[keys["patient_reported"]!]).toMatch(/vomited/);
      expect(details[keys["vitals"]!]).toMatch(/38\.2/);
      expect(details[keys["examination"]!]).toMatch(/iliac fossa/);
      expect(details[keys["presenting_complaint"]!] ?? details[keys["history"]!]).toMatch(/belly button/);

      // The allergy is on the list with the patient as its source, written by the agent for its owner.
      const allergies = sandboxQuery(sb, "allergies_for", { patient });
      expect(allergies).toMatchObject([{ substance: expect.stringMatching(/penicillin/i), source: "patient", recorded_by: mine.agent }]);

      // The admission was requested and accepted in one step on the doctor's authority, and the bed is in the ward said.
      const admission = sandboxQuery(sb, "admission_for_visit", { visit })[0]!;
      expect(admission["accepted_by"]).toBe(mine.agent);
      expect(admission["bed_id"]).not.toBeNull();
      expect(v.admission_id).toBe(admission["id"]);
      const audit = sandboxQuery(sb, "audit_for_visit", { visit });
      expect(audit.find((a) => a["action_type"] === "admission.accepted_on_owner_authority")).toMatchObject({ actor: mine.agent, on_behalf_of: mine.owner, evidence: `transcript:${adm.line_id}` });

      // Every verified action has a speed row from the end of its words, and no model call was made at another effort.
      expect(v.speed.rows.length).toBe(v.actions.length);
      expect(v.speed.errors).toEqual({ failed: 0, refused: 0, unverified: 0 });
    } finally {
      await s.close();
      client.close();
    }
  }, 30 * 60_000);
});
