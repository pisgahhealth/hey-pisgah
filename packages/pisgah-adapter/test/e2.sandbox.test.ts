import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startEmrServe, type EmrRuntime, type EmrTaskView, type Provenance } from "@hey-pisgah/agent";
import { ModelClient } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import type { DoorLog } from "../src/port.js";
import { PisgahPort } from "../src/port.js";
import { loadProfile } from "../src/profile.js";
import { personCaller } from "../src/journey.sandbox.js";
import { SandboxBlock, mintAgentBearer, sandboxQuery } from "../src/sandbox.js";

// Runs only with SANDBOX=1 against the loopback sandbox named in the private profile; record checks use read-only SQL.
const RUN = process.env["SANDBOX"] === "1";
const now = () => new Date().toISOString();
// Every string in a door answer, so a check can find the saved note without naming the EMR's fields.
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
const noteIn = (v: unknown, has: string): Record<string, string> | null => {
  const hit = strings(v).find((x) => x.startsWith("{") && x.includes(has));
  return hit ? (JSON.parse(hit) as Record<string, string>) : null;
};

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

    // The person keeps the consultation: opening it as themselves succeeds, which the EMR allows only to the holder, and shows the agent's draft.
    const self = await person("open_as_doctor", { visit_id: visit, patient_id: patient });
    expect(self.ok, JSON.stringify(self)).toBe(true);
    expect(noteIn(self.json, "Abdominal pain for two days.")).not.toBeNull();
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
      const details = noteIn(opened.json, "vomited")!;
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

  it("holds work for the admission and a review for a time, anchors the review on the ward board, fires once from its own timer across restarts, and times the vitals path from speech", async () => {
    const profile = loadProfile();
    const { patient, visit, sb } = await freshArrival(profile);
    const mine = mintAgentBearer(sb);
    const port = new PisgahPort(profile, { bearers: { [mine.owner]: mine.bearer } });
    const root = mkdtempSync(join(tmpdir(), "hp-e2-ob-"));
    const listenPort = Number(process.env["HEY_PISGAH_EMR_PORT"] ?? 4107);
    const boot = async () => {
      let rt: EmrRuntime | null = null;
      const client = new ModelClient({ storeRoot: root, mode: "live", recordingsDir: join(root, "recordings"), taskStateOf: (id) => rt?.stateOf(id) ?? null });
      const s = await startEmrServe({ storeRoot: root, port, client, listenPort, ears: "spark", runtime: { holdMs: 4000, proofRetryMs: 1500, obligationTickMs: 1000 } });
      rt = s.runtime;
      return { s, close: async () => { await s.close(); client.close(); } };
    };
    const say = async (s: Awaited<ReturnType<typeof boot>>["s"], text: string) => {
      const r = await fetch(`${s.url}/tasks/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: mine.owner, patientId: patient, text }) });
      expect(r.status).toBe(202);
      const b = (await r.json()) as { task_id: string; line_id: string };
      await s.runtime.settled(8 * 60_000);
      return b;
    };
    const firedCount = (taskId: string) => readStream(root, `emr/${taskId}`).filter((e) => e.record_type === "obligation.fired").length;
    const a = await boot();
    let taskId = "";
    let review: { due_at: string; title: string } | null = null;
    try {
      const held = await say(a.s, "Once he is admitted, start four hourly observations.");
      taskId = held.task_id;
      expect(a.s.runtime.view(taskId)!.obligations).toMatchObject([{ after: "admission", state: "held" }]);
      await say(a.s, "Admit him as an emergency to the children's ward for abdominal pain.");
      for (let i = 0; i < 60 && a.s.runtime.view(taskId)!.obligations[0]!.state !== "done"; i++) await new Promise((r) => setTimeout(r, 1000));
      await a.s.runtime.settled(5 * 60_000);
      const v = a.s.runtime.view(taskId)!;
      expect(v.obligations[0]).toMatchObject({ state: "done", fired_by: "condition" });
      const admission = String(sandboxQuery(sb, "admission_for_visit", { visit })[0]!["id"]);
      expect(v.admission_id).toBe(admission);
      expect(sandboxQuery(sb, "care_items_for", { admission }).map((x) => x["cadence_code"])).toContain("q4h");

      await say(a.s, "Review him again in one minute.");
      const ob = a.s.runtime.view(taskId)!.obligations.find((o) => o.kind === "schedule_review")!;
      expect(ob).toMatchObject({ state: "held" });
      review = { due_at: ob.due_at!, title: ob.title };
      // The review is on the ward board at its due time as a STAT item.
      const items = sandboxQuery(sb, "care_items_for", { admission });
      const stat = items.find((x) => x["cadence_code"] === "STAT")!;
      expect(stat, JSON.stringify(items)).toBeDefined();
      expect(Math.abs(Date.parse(String(stat["start_at"])) - Date.parse(review.due_at))).toBeLessThan(60_000);
      expect(stat["created_by"]).toBe(mine.agent);
    } finally {
      await a.close();
    }

    // Nothing runs while the time passes; a new serve on the same store fires the review from its own timer.
    await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(review!.due_at) - Date.now()) + 2000));
    const b = await boot();
    const speed: Record<string, unknown> = {};
    try {
      for (let i = 0; i < 30 && b.s.runtime.view(taskId)!.obligations.find((o) => o.kind === "schedule_review")!.state !== "done"; i++) await new Promise((r) => setTimeout(r, 500));
      const ob = b.s.runtime.view(taskId)!.obligations.find((o) => o.kind === "schedule_review")!;
      expect(ob).toMatchObject({ state: "done", fired_by: "timer" });
      expect(firedCount(taskId)).toBe(2);

      // The vitals path from speech: rendered lines through the listen endpoint, timed from the end of each line to the verified record.
      const lines = ["Chart his pulse 116.", "Chart his temperature 38.3.", "Chart his respiratory rate 24.", "Chart his blood pressure 104 over 62.", "Chart his pulse 112.", "Chart his temperature 37.9.", "Chart his respiratory rate 22.", "Chart his pulse 108."];
      const before = b.s.runtime.view(taskId)!.speed.rows.length;
      for (const [seq, text] of lines.entries()) {
        const wav = join(root, `v${seq}.wav`);
        execFileSync("say", ["-o", wav, "--file-format=WAVE", "--data-format=LEI16@24000", `${text} [[slnc 900]]`], { stdio: "ignore", timeout: 30_000 });
        const form = new FormData();
        form.append("audio", new Blob([readFileSync(wav)], { type: "audio/wav" }), `v${seq}.wav`);
        form.append("owner", mine.owner); form.append("patientId", patient); form.append("session_id", `e2-vitals-${taskId}`); form.append("seq", String(seq));
        const r = await fetch(`${b.s.url}/tasks/listen?wait=1`, { method: "POST", body: form });
        expect(r.status).toBe(202);
        await new Promise((x) => setTimeout(x, Number(process.env["HEY_PISGAH_E2_SPACING_MS"] ?? 2500)));
      }
      await b.s.runtime.settled(8 * 60_000);
      const v = b.s.runtime.view(taskId)!;
      const obs = v.speed.rows.slice(before).filter((x) => x.kind === "record_observation");
      const acts = v.actions.filter((x) => x.kind === "record_observation");
      speed["rows"] = obs; speed["by_kind"] = v.speed.by_kind; speed["errors"] = v.speed.errors; speed["actions"] = acts.map((x) => ({ state: x.state, args: x.args, reason: x.reason }));
      speed["questions"] = v.asked.slice(-8); speed["ears"] = v.ears; speed["usd"] = v.usd; speed["calls"] = v.calls;
      expect(obs.length).toBeGreaterThanOrEqual(6);
    } finally {
      const out = process.env["HEY_PISGAH_E2_SPEED"];
      if (out) writeFileSync(out, JSON.stringify(speed, null, 1));
      await b.close();
    }

    // Negative control: one more restart later fires nothing again.
    const c = await boot();
    try {
      await new Promise((r) => setTimeout(r, 3000));
      expect(firedCount(taskId)).toBe(2);
    } finally {
      await c.close();
    }
  }, 40 * 60_000);
});
