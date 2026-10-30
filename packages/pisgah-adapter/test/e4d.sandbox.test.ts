import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACK_KIND, COMPLETE_KIND, DELEGATE_KIND, DISPENSE_KIND, NUDGE_KIND, PREPARE_KIND, sherpaEmbedder, startEmrServe, type EmrRuntime, type EmrTaskView, type Provenance, type SpeakerVerdict } from "@hey-pisgah/agent";
import { ModelClient } from "@hey-pisgah/model";
import { loadProfile } from "../src/profile.js";
import { PisgahPort, type DoorLog } from "../src/port.js";
import { mintAgentBearer, sandboxQuery } from "../src/sandbox.js";
import { freshArrival } from "./sandbox-helpers.js";
import { VOICES, speak } from "./e3.sandbox.test.js";

// Runs only with SANDBOX=1 and E4D=1 against the loopback sandbox, with the speaker model named by HEY_PISGAH_SPEAKER_MODEL and HEY_PISGAH_SHERPA_DIR for the doctor's own voice orders.
const RUN = process.env["SANDBOX"] === "1" && process.env["E4D"] === "1";
const now = () => new Date().toISOString();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)("E4 the pharmacy and the lab act on sent voice orders on the sandbox EMR", () => {
  it("the pharmacist's agent takes the sent prescription, waits for the consultation, prepares it on the pharmacist's words and holds the dispense for its payment, the lab's agent receives the lab order, and the doctor's agent reports each step from the record", async () => {
    const profile = loadProfile();
    const embed = sherpaEmbedder({ modelPath: process.env["HEY_PISGAH_SPEAKER_MODEL"] ?? "", sherpaDir: process.env["HEY_PISGAH_SHERPA_DIR"] })!;
    expect(embed).not.toBeNull();
    const { patient, visit, sb, person } = await freshArrival(profile);
    const who = (login: string) => sb.owners.find((o) => o.login === login)!;
    const doc = mintAgentBearer(sb);
    const pharm = mintAgentBearer(sb, who("pharm.uduak"));
    // The lab task goes to whichever scientist the roster has on now, so both shifts' agents are minted and the assignee is read from the record.
    const labs = [mintAgentBearer(sb, who("lab.grace")), mintAgentBearer(sb, who("lab.head"))];
    const requests: DoorLog[] = [];
    const port = new PisgahPort(profile, { bearers: { [doc.owner]: doc.bearer, [pharm.owner]: pharm.bearer, ...Object.fromEntries(labs.map((x) => [x.owner, x.bearer])) }, onRequest: (l) => requests.push(l) });
    const dir = join(process.env["HEY_PISGAH_E3_TMP"] ?? tmpdir(), `e4d-${Date.now().toString(36)}`);
    mkdirSync(dir, { recursive: true });
    const prov = (line: string): Provenance => ({ owner: doc.owner, evidence: `transcript:${line}`, spoken_at: now() });
    // A socket the app closed under a first request after a code reload resets once, so the match is asked again once when no verdict came back.
    const matched = async (text: string, line: string): Promise<SpeakerVerdict> => {
      const vector = (await embed(speak(VOICES.owner, text, join(dir, `${line}.wav`))))!.vector;
      const first = await port.speaker!(doc.owner, vector, prov(line));
      if (first.speaker !== "unverified" || first.reason !== "unreachable") return first;
      await wait(1000);
      return port.speaker!(doc.owner, vector, prov(line));
    };
    const authorised = (line: string, v: SpeakerVerdict) => (v.speaker === "owner" ? `transcript:${line}~${v.token}` : undefined);
    const result: Record<string, unknown> = {};
    const root = mkdtempSync(join(tmpdir(), "hp-e4d-"));
    let rt: EmrRuntime | null = null;
    const client = new ModelClient({ storeRoot: root, mode: "live", recordingsDir: join(root, "recordings"), taskStateOf: (id) => rt?.stateOf(id) ?? null });
    let s: Awaited<ReturnType<typeof startEmrServe>> | null = null;
    const until = async <T>(what: string, read: () => T | null | undefined | false, ms = 120_000): Promise<T> => {
      const end = Date.now() + ms;
      for (;;) { const v = read(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await wait(500); }
    };
    const done = (v: EmrTaskView, kind: string) => v.actions.filter((a) => a.kind === kind && a.state === "completed");
    try {
      // The doctor's own matched voice sends a prescription and a lab test as voice orders, unsigned, the voice-order lane's path.
      expect(await port.commit("open_consult", { visit_id: visit, patient_id: patient }, `e4d-open-${visit}`, prov("e4d-open"))).toMatchObject({ ok: true });
      // The patient is admitted and bedded first, so the medicine is a ward line, charged to the stay as the hospital does.
      const adm = await port.commit("admit_patient", { visit_id: visit, patient_id: patient, ward: "a_and_e", admission_type: "emergency", reason: "ZZ-TEST abdominal pain for observation" }, `e4d-admit-${visit}`, prov("e4d-admit"));
      expect(adm, JSON.stringify(adm)).toMatchObject({ ok: true });
      const admission = (adm as { record_id: string }).record_id;
      const bed = await port.commit("assign_bed", { admission_id: admission, ward: "a_and_e" }, `e4d-bed-${visit}`, prov("e4d-bed"));
      expect(bed, JSON.stringify(bed)).toMatchObject({ ok: true });
      result["admission"] = admission;
      const rxLine = await matched("Give paracetamol tablets 500 milligrams by mouth three times a day, quantity 6.", "e4d-rx");
      const rx = await port.commit("prescribe", { visit_id: visit, patient_id: patient, drug: "paracetamol_oral", dose: "500 mg", route: "oral", frequency: 3, quantity: 6 }, `e4d-rx-${visit}`, { ...prov("e4d-rx"), voice: { authorisation: authorised("e4d-rx", rxLine)! } });
      expect(rx, JSON.stringify(rx)).toMatchObject({ ok: true });
      const labLine = await matched("Send a full blood count.", "e4d-fbc");
      const fbc = await port.commit("order_test", { visit_id: visit, patient_id: patient, test: "fbc" }, `e4d-fbc-${visit}`, { ...prov("e4d-fbc"), voice: { authorisation: authorised("e4d-fbc", labLine)! } });
      expect(fbc, JSON.stringify(fbc)).toMatchObject({ ok: true });
      const rxId = (rx as { record_id: string }).record_id;
      const stateId = (fbc as { record_id: string }).record_id;

      // The doctor's agent hands each verified order on to the team that performs it: the write its hand-off makes after the order's proof.
      const handoff = async (kind: string, team: string, table: string, id: string, title: string, line: string) => {
        const c = await port.commit(DELEGATE_KIND, { task_kind: kind, team, patient_id: patient, visit_id: visit, subject_table: table, subject_id: id, title, instruction: `${title}: the voice order sent on the doctor's line.`, evidence: `transcript:${line}` }, `e4d-hand-${id}`, prov(line));
        expect(c, JSON.stringify(c)).toMatchObject({ ok: true });
        return (c as { record_id: string }).record_id;
      };
      const rxTask = await handoff("dispense", "pharmacy", "prescriptions", rxId, "Dispense the voice order", "e4d-rx");
      const labTask = await handoff("lab_order", "lab", "clinical_order_states", stateId, "Receive the lab order", "e4d-fbc");
      const labAssignee = String(sandboxQuery(sb, "delegations_for", { patient }).find((r) => r["id"] === labTask)!["assignee"]);
      const lab = labs.find((x) => x.owner === labAssignee)!;
      expect(lab, "the lab task went to a minted scientist").toBeDefined();
      result["tasks"] = { rxTask, labTask, lab_rule: sandboxQuery(sb, "delegations_for", { patient }).find((r) => r["id"] === labTask)!["rule"] };

      s = await startEmrServe({ storeRoot: root, port, client, listenPort: Number(process.env["HEY_PISGAH_EMR_PORT"] ?? 4109), ears: "off", runtime: { holdMs: 1500, proofRetryMs: 1500, watchMs: 8000, obligationTickMs: 1000 }, log: (x) => process.stderr.write(`serve: ${x}\n`) });
      rt = s.runtime;
      const serve = s;
      const sayAs = async (owner: string, text: string) => {
        const r = await fetch(`${serve.url}/tasks/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, patientId: patient, text, spokenAt: now() }) });
        expect(r.status, await r.clone().text()).toBe(202);
        await serve.runtime.settled();
        return (await r.json()) as { line_id: string };
      };
      const view = (owner: string) => serve.runtime.views(owner).find((v) => v.patient_id === patient);

      // Both receiving agents ring their own person's bell; the doctor's agent follows both tasks.
      await until("the pharmacist's nudge", () => { const v = view(pharm.owner); return v && done(v, NUDGE_KIND).length ? v : null; });
      await until("the lab's nudge", () => { const v = view(lab.owner); return v && done(v, NUDGE_KIND).length ? v : null; });

      // The lab scientist says accepted; the order is received, and the doctor's agent closes the task from the record.
      const labAccept = await sayAs(lab.owner, "Accepted receive the lab order.");
      await until("the lab's acknowledgement", () => { const v = view(lab.owner); return v && done(v, ACK_KIND).length; });
      const labClosed = await until("the doctor's agent closing the lab task", () => serve.runtime.views(doc.owner).find((v) => v.delegations.some((d) => d.delegation_id === labTask && d.completed_at)));
      expect(labClosed.notes.some((n) => n.text.startsWith("Done: Receive the lab order. The record shows it"))).toBe(true);

      // The pharmacist accepts, then asks for it prepared and dispensed; the review waits for the consultation to finish.
      const rxAccept = await sayAs(pharm.owner, "Accepted dispense the voice order.");
      await until("the pharmacist's acknowledgement", () => { const v = view(pharm.owner); return v && done(v, ACK_KIND).length; });
      const consultOpen = sandboxQuery(sb, "visit_status", { visit })[0]?.["consultation_state"] === "in_consultation";
      result["consult_open_at_ask"] = consultOpen;
      const ask = await sayAs(pharm.owner, "Prepare and dispense it.");
      if (consultOpen) {
        await until("the hold for the consultation", () => view(pharm.owner)?.notes.some((n) => n.text.startsWith("Held: Dispense the voice order.")));
        expect(view(pharm.owner)!.actions.filter((a) => a.kind === PREPARE_KIND)).toEqual([]);
      }
      // Negative control: the doctor's agent does not close a task the record does not show done.
      expect(serve.runtime.views(doc.owner).flatMap((v) => v.actions).filter((a) => a.kind === COMPLETE_KIND && a.args["delegation_id"] === rxTask)).toEqual([]);

      // The doctor signs the consultation as a person; the pharmacist's agent resumes on its own, prepares and dispenses.
      if (consultOpen) {
        const signed = await person("sign_consult", { visit_id: visit, patient_id: patient });
        result["sign"] = { ok: signed.ok, status: signed.status, note: signed.note ?? null };
        expect(signed.ok, JSON.stringify(signed)).toBe(true);
      }
      const pv = await until("the hold for payment", () => { const v = view(pharm.owner); return v && v.notes.some((n) => n.text.startsWith("Held: Dispense the voice order is prepared and waits for its payment")) ? v : null; }, 180_000);
      result["pharmacist_actions"] = pv.actions.map((a) => ({ kind: a.kind, state: a.state, reason: a.reason }));
      expect(done(pv, PREPARE_KIND)).toHaveLength(1);
      expect(done(pv, PREPARE_KIND)[0]!.args).toMatchObject({ prescription_id: rxId, evidence: `transcript:${ask.line_id}` });
      // The dispense is never tried while the line waits for payment, and the doctor's agent sees the milestone, not completion.
      expect(pv.actions.filter((a) => a.kind === DISPENSE_KIND)).toEqual([]);
      await until("the doctor's milestone", () => serve.runtime.views(doc.owner).find((v) => v.notes.some((n) => n.text.startsWith("Prepared by the pharmacy: Dispense the voice order. It waits for payment"))));
      expect(serve.runtime.views(doc.owner).flatMap((v) => v.actions).filter((a) => a.kind === COMPLETE_KIND && a.args["delegation_id"] === rxTask)).toEqual([]);
      // Negative control: a dispense straight through the door on a line that is not ready is refused by the EMR.
      const early = await port.commit(DISPENSE_KIND, { delegation_id: rxTask, prescription_id: rxId, title: "Dispense the voice order", evidence: `transcript:${ask.line_id}` }, `e4d-early-dispense-${rxId}`, { owner: pharm.owner, evidence: `transcript:${ask.line_id}`, spoken_at: now() });
      result["dispense_not_ready"] = early.ok ? "accepted" : early.reason;
      expect(early).toMatchObject({ ok: false });

      // The record: each order received by its own person through that person's agent, the prescription dispensed, every write on its clinician's behalf.
      const receipts = sandboxQuery(sb, "order_receipt", { visit });
      result["receipts"] = receipts;
      expect(receipts.find((r) => r["kind"] === "prescription")).toMatchObject({ received_by: pharm.owner, rx_status: "issued" });
      expect(receipts.find((r) => r["kind"] === "lab")).toMatchObject({ received_by: lab.owner });
      const rows = sandboxQuery(sb, "delegations_for", { patient });
      result["delegations"] = rows;
      expect(rows.find((r) => r["id"] === rxTask)).toMatchObject({ assignee: pharm.owner, acknowledged_by: pharm.owner, acknowledged_via: pharm.agent, completed_by: null });
      expect(rows.find((r) => r["id"] === labTask)).toMatchObject({ assignee: lab.owner, acknowledged_by: lab.owner, acknowledged_via: lab.agent, completed_by: doc.agent });
      const audit = sandboxQuery(sb, "audit_for_patient", { patient });
      result["audit"] = audit.filter((a) => String(a["agent"] ?? "") !== "" || String(a["action_type"]).startsWith("delegation."));
      expect(audit.filter((a) => a["action_type"] === "delegation.acknowledged").map((a) => a["evidence"]).sort()).toEqual([`transcript:${labAccept.line_id}`, `transcript:${rxAccept.line_id}`].sort());
      const bells = [...sandboxQuery(sb, "bell_for", { delegation: rxTask }), ...sandboxQuery(sb, "bell_for", { delegation: labTask })];
      result["bells"] = bells;
      for (const b of bells) for (const word of ["Paracetamol", "paracetamol", "ZZ-TEST"]) expect(`${b["title"]} ${b["body"]}`).not.toContain(word);
      result["speed"] = [doc.owner, pharm.owner, lab.owner].flatMap((o) => serve.runtime.views(o).flatMap((v) => v.speed.rows.map((r) => ({ owner: o === doc.owner ? "doctor" : o === pharm.owner ? "pharmacist" : "lab", kind: r.kind, ms: r.ms, from_record: r.from_record ?? false }))));
      result["strips"] = Object.fromEntries([["doctor", doc.owner], ["pharmacist", pharm.owner], ["lab", lab.owner]].map(([k, o]) => [k, serve.runtime.views(o!).flatMap((v) => v.notes.map((n) => n.text))]));
    } finally {
      if (process.env["SANDBOX_E4_OUT"]) writeFileSync(process.env["SANDBOX_E4_OUT"], JSON.stringify({ result, requests: requests.map((r) => ({ at: r.at, method: r.method, path: r.path, status: r.status, ms: r.ms, reason: r.reason })) }, null, 1));
      if (s) await s.close();
      client.close();
    }
  }, 20 * 60_000);
});
