import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ModelClient } from "@hey-pisgah/model";
import { EmrRuntime, VERBAL_ORDER_KIND, sherpaEmbedder, type Provenance } from "@hey-pisgah/agent";
import { PisgahPort } from "../src/port.js";
import { loadProfile } from "../src/profile.js";
import { mintAgentBearer, mintPersonBearer, SandboxBlock, sandboxQuery } from "../src/sandbox.js";
import { speak } from "./e3.sandbox.test.js";
import { freshArrival } from "./sandbox-helpers.js";

// Runs only with SANDBOX=1 and G3=1 against the loopback sandbox; the receiver's read-back is a synthetic voice matched by the local speaker model, and no language model is called.
const RUN = process.env["SANDBOX"] === "1" && process.env["G3"] === "1";
const run = Date.now().toString(36);
const now = () => new Date().toISOString();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The synthetic voice the sandbox nurse was enrolled with.
const NURSE_VOICE = "Tessa";
const PARACETAMOL_IV = "48c2d1e3-e2d4-4dc2-beaf-0e293a97b441";
const MORPHINE = "724d635d-0543-4580-b6c8-68b16dffd8e6";
const results: Record<string, unknown> = { run, synthetic: true };

describe.skipIf(!RUN)("G3 dictated and verbal orders, the rights intersection and attestations on the sandbox door", () => {
  it("takes verbal orders only as the rules allow, records each person apart, lets a substitute authenticate, escalates without erasing, and keeps the agent inside its clinician's rights", async () => {
    try { await scenario(); } finally {
      const out = process.env["HEY_PISGAH_G3_OUT"];
      if (out) writeFileSync(out, JSON.stringify(results, null, 1));
    }
  }, 8 * 60_000);
});

async function scenario(): Promise<void> {
    const profile = loadProfile();
    const sb = SandboxBlock.parse(profile.sandbox);
    const clinic = process.env["HEY_PISGAH_EMERGENCY_CLINIC"]!;
    const embed = sherpaEmbedder({ modelPath: process.env["HEY_PISGAH_SPEAKER_MODEL"] ?? "", sherpaDir: process.env["HEY_PISGAH_SHERPA_DIR"] })!;
    expect(embed).not.toBeNull();
    const doc = mintAgentBearer(sb);
    const nurse = mintAgentBearer(sb, sb.owners.find((o) => o.login === "nurse.ada")!);
    const pharm = mintAgentBearer(sb, sb.owners.find((o) => o.login === "pharm.uduak")!);
    const ime = sb.owners.find((o) => o.login === "dr.ime")!;
    const imeId = String(profile.owners.find((o) => o.label === "Dr Ime")!.id);
    const port = new PisgahPort(profile, { bearers: { [doc.owner]: doc.bearer, [nurse.owner]: nurse.bearer, [pharm.owner]: pharm.bearer } });
    const base = profile.base_url.replace(/\/+$/, "");
    const dir = join(process.env["HEY_PISGAH_G3_TMP"] ?? "/tmp", `g3-${run}`);
    let n = 0;
    // The nurse's own read-back, matched to her enrolled voice by the hospital, as "evidence~token".
    const readBack = async (text: string): Promise<{ line: string; auth: string }> => {
      n += 1;
      const line = `g3-${run}-${n}`;
      const prov: Provenance = { owner: nurse.owner, evidence: `transcript:${line}`, spoken_at: now() };
      const v = await port.speaker!(nurse.owner, (await embed(speak(NURSE_VOICE, `${text} Run ${run} line ${n}.`, join(dir, `${line}.wav`))))!.vector, prov);
      if (v.speaker !== "owner") throw new Error(`the nurse's synthetic voice was not matched (${v.speaker})`);
      return { line, auth: `transcript:${line}~${v.token}` };
    };
    const door = async (bearer: string, owner: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
      const h: Record<string, string> = { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...extra };
      if (owner) Object.assign(h, { [profile.headers.on_behalf_of]: owner, [profile.headers.origin]: profile.origin_value, [profile.headers.evidence]: extra["evidence"] ?? `transcript:g3-${run}-call`, [profile.headers.spoken_at]: now(), [profile.headers.idempotency]: `g3-${run}-${Math.random().toString(36).slice(2)}` });
      const r = await fetch(`${base}/${path}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await r.text();
      let json: Record<string, unknown> | null = null;
      try { json = text ? (JSON.parse(text) as Record<string, unknown>) : null; } catch { json = null; }
      return { status: r.status, json, text: text.slice(0, 300) };
    };
    const verbal = async (body: Record<string, unknown>, rb: { line: string; auth: string } | null, as = nurse) =>
      door(as.bearer, as.owner, "POST", "consult/verbal-order", body, rb ? { [profile.headers.authorisation!]: rb.auth, evidence: `transcript:${rb.line}` } : {});

    // An emergency arrival the doctor's agent opens, so the visit is the emergency encounter verbal orders need.
    const opened = await port.commit("open_unnamed_encounter", { unidentified_ref: `ZZ-TEST G3 arrival ${run}`, reason: "Emergency arrival", clinic_id: clinic }, `g3-${run}-arrive`, { owner: doc.owner, evidence: `transcript:g3-${run}-arrive`, spoken_at: now() });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    const patient = (opened as { record_id: string }).record_id;
    const visit = String(sandboxQuery(sb, "visit_for_patient", { patient })[0]!["id"]);
    expect(sandboxQuery(sb, "visit_desk", { visit })[0]!["front_desk_status"]).toBe("emergency_override");
    const rx = (drug: string) => ({ visitId: visit, patientId: patient, issuerId: doc.owner, order: { kind: "prescription", drugCatalogId: drug, dosage: "1 g", frequency: 3, durationDays: 1, quantity: 3 } });
    const lab = (testName: string, issuerId = doc.owner) => ({ visitId: visit, patientId: patient, issuerId, order: { kind: "lab", testName } });

    // Refusals first, each on a body the rules forbid; nothing is spent, so one read-back line serves them all.
    const rb0 = await readBack("Verbal order read back for checking.");
    const refused = {
      opioid_controlled: await verbal(rx(MORPHINE), rb0),
      imaging_prohibited: await verbal({ ...lab("ZZ-TEST Abdominal ultrasound"), order: { kind: "imaging", testName: "ZZ-TEST Abdominal ultrasound" } }, rb0),
      no_read_back: await verbal(lab("ZZ-TEST Full Blood Count"), null),
      receiver_not_eligible: await verbal(lab("ZZ-TEST Full Blood Count"), null, pharm),
      nurse_as_issuer: await verbal(lab("ZZ-TEST Full Blood Count", nurse.owner), rb0),
    };
    const arrivalB = await freshArrival(profile);
    refused["not_emergency" as keyof typeof refused] = await verbal({ ...lab("ZZ-TEST Full Blood Count"), visitId: arrivalB.visit, patientId: arrivalB.patient }, rb0);
    results["refused"] = Object.fromEntries(Object.entries(refused).map(([k, v]) => [k, { status: v.status, text: v.text }]));
    // Each is refused by its own rule, not by a gate in front of it.
    const said = { opioid_controlled: /controlled drug/, imaging_prohibited: /never taken verbally/, no_read_back: /Read the order back/, receiver_not_eligible: /Your role does not take/, nurse_as_issuer: /does not give verbal orders/, not_emergency: /only in an emergency/ } as Record<string, RegExp>;
    for (const [k, v] of Object.entries(refused)) { expect(v.status, `${k}: ${v.text}`).toBe(409); expect(v.text, k).toMatch(said[k]!); }
    expect(sandboxQuery(sb, "verbal_states", { visit })).toHaveLength(0);

    // A verbal prescription and a verbal lab order the nurse took from the doctor, each on her own matched read-back.
    const t0 = Date.now();
    const rb1 = await readBack("Paracetamol one gram IV three times a day, read back to Doctor Edikan.");
    const tookRx = await verbal(rx(PARACETAMOL_IV), rb1);
    results["ms_rx"] = Date.now() - t0;
    expect(tookRx.status, tookRx.text).toBe(200);
    const rb2 = await readBack("Urinalysis now, read back to Doctor Edikan.");
    const tookLab = await verbal(lab("ZZ-TEST Urinalysis"), rb2);
    expect(tookLab.status, tookLab.text).toBe(200);
    // The read-back line is spent: the same line for another order is refused.
    const again = await verbal(lab("ZZ-TEST Full Blood Count"), rb2);
    expect(again.status).toBe(403);
    const states = sandboxQuery(sb, "verbal_states", { visit });
    results["states"] = states;
    expect(states.length).toBeGreaterThanOrEqual(2);
    for (const s of states) expect(s).toMatchObject({ verbal: true, issued_by: doc.owner, received_by: nurse.owner, requested_by: nurse.agent, sent_by: nurse.agent, receiver_role: "nurse", read_back: true, countersigned_by: null });
    expect(states.find((s) => s["kind"] === "prescription")!["window_s"]).toBe(3600);
    expect(states.find((s) => s["kind"] === "lab")!["window_s"]).toBe(60);
    const audit = sandboxQuery(sb, "verbal_audit", { visit });
    expect(audit[0]).toMatchObject({ actor: nurse.agent, agent: nurse.agent, on_behalf_of: nurse.owner, after: { issuedBy: doc.owner, receivedBy: nurse.owner, enteredBy: nurse.agent, prescriberSigned: false } });

    // The rights intersection: the pharmacist's agent has no open task for this prescription, so it may neither prepare nor dispense it.
    const rxId = String(states.find((s) => s["kind"] === "prescription")!["prescription_id"]);
    const prep = await door(pharm.bearer, pharm.owner, "POST", "pharmacy/approve", { prescriptionId: rxId });
    const disp = await door(pharm.bearer, pharm.owner, "POST", "pharmacy/dispense", { prescriptionId: rxId });
    results["task_scope"] = { approve: prep, dispense: disp };
    expect(prep.status).toBe(403);
    expect(disp.status).toBe(403);
    expect(prep.json).toMatchObject({ error: { code: "agent_refused" } });
    expect(disp.json).toMatchObject({ error: { code: "agent_refused" } });

    // Overdue authentication (the one simulated short deadline) rings the issuer and the receiver, and changes nothing that was ordered.
    await wait(65_000);
    results["escalation_read_at"] = now();
    const read = await door(doc.bearer, doc.owner, "GET", `consult/order-send?visitId=${visit}`);
    results["escalation_read"] = { status: read.status, at: now() };
    expect(read.status).toBe(200);
    const labState = sandboxQuery(sb, "verbal_states", { visit }).find((s) => s["kind"] === "lab")!;
    results["lab_state_after_read"] = labState;
    expect(labState["countersign_escalated_at"]).not.toBeNull();
    expect(labState).toMatchObject({ issued_by: doc.owner, received_by: nurse.owner, requested_by: nurse.agent });
    const bells = [...sandboxQuery(sb, "bells_for", { key: `voice-order-countersign-overdue:${String(labState["id"])}` }), ...sandboxQuery(sb, "bells_for", { key: `verbal-order-overdue-receiver:${String(labState["id"])}` })];
    expect(bells.map((b) => b["recipient"]).sort()).toEqual([doc.owner, nurse.owner].sort());
    results["escalated"] = { state: labState, bells };

    // A substitute doctor authenticates both verbal orders on his own session; the receiver's agent cannot countersign at all.
    const imeBearer = mintPersonBearer(sb, { login: ime.login, ...(ime.clinic ? { clinic: ime.clinic } : {}) });
    const nurseTries = await door(nurse.bearer, nurse.owner, "GET", `consult/countersign?visitId=${visit}`);
    expect(nurseTries.status).toBe(403);
    const shown = await door(imeBearer, null, "GET", `consult/countersign?visitId=${visit}`);
    expect(shown.status, shown.text).toBe(200);
    const sb2 = shown.json as { items: { stateId: string }[]; itemsDigest: string; readBackAt: string; readBackSeal: string };
    expect(sb2.items.map((i) => i.stateId).sort()).toEqual(states.map((s) => String(s["id"])).sort());
    const signed = await door(imeBearer, null, "POST", "consult/countersign", { visitId: visit, role: "issuer", itemIds: sb2.items.map((i) => i.stateId), itemsDigest: sb2.itemsDigest, readBackAt: sb2.readBackAt, readBackSeal: sb2.readBackSeal }, { [profile.headers.idempotency]: `g3-${run}-sign` });
    expect(signed.status, signed.text).toBe(200);
    const after = sandboxQuery(sb, "verbal_states", { visit });
    for (const s of after) expect(s).toMatchObject({ countersigned_by: imeId, issued_by: doc.owner, received_by: nurse.owner });
    results["authenticated"] = after;

    // Attestations: the doctor's agent never goes on duty for him.
    const duty = await door(doc.bearer, doc.owner, "POST", "roster/duty/clock-on", { facilityId: process.env["HEY_PISGAH_G3_FACILITY"] ?? "" });
    results["agent_clock_on"] = { status: duty.status, text: duty.text };
    expect(duty.status).toBe(409);
    // The nurse's own agent takes a spoken verbal order end to end by rule, on her matched voice, with no model call.
    const opened2 = await port.commit("open_unnamed_encounter", { unidentified_ref: `ZZ-TEST G3 arrival ${run} b`, reason: "Emergency arrival", clinic_id: clinic }, `g3-${run}-arrive-b`, { owner: doc.owner, evidence: `transcript:g3-${run}-arrive-b`, spoken_at: now() });
    expect(opened2.ok).toBe(true);
    const patient2 = (opened2 as { record_id: string }).record_id;
    const visit2 = String(sandboxQuery(sb, "visit_for_patient", { patient: patient2 })[0]!["id"]);
    const root = mkdtempSync(join(tmpdir(), "hp-g3-"));
    const client = new ModelClient({ storeRoot: root, mode: "mock", mock: () => { throw new Error("G3 makes no model call"); } });
    const rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 500 });
    try {
      const text = `Verbal order from Doctor Edikan, full blood count now, read back. Run ${run}.`;
      const t1 = Date.now();
      const r = await rt.say({ owner: nurse.owner, target: { patient_id: patient2 }, text, source: "audio", voiceprint: (await embed(speak(NURSE_VOICE, text, join(dir, "rt-1.wav"))))! });
      let done = false;
      for (let i = 0; i < 60 && !done; i++) { await rt.settled(); done = !!rt.view(r.task_id)!.actions.find((a) => a.kind === VERBAL_ORDER_KIND && a.state === "completed"); if (!done) await wait(500); }
      results["runtime_ms"] = Date.now() - t1;
      results["runtime_actions"] = rt.view(r.task_id)!.actions.map((a) => ({ kind: a.kind, state: a.state }));
      expect(done).toBe(true);
      const s2 = sandboxQuery(sb, "verbal_states", { visit: visit2 });
      expect(s2).toHaveLength(1);
      expect(s2[0]).toMatchObject({ kind: "lab", verbal: true, issued_by: doc.owner, received_by: nurse.owner, requested_by: nurse.agent, read_back: true });
    } finally {
      await rt.stop();
    }
    results["ok"] = true;
}
