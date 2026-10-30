import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMERGENCY_KIND, sherpaEmbedder, startEmrServe, unidentifiedRef, type EmrRuntime, type EmrTaskView, type Voiceprint } from "@hey-pisgah/agent";
import { ModelClient } from "@hey-pisgah/model";
import { loadProfile, pick } from "../src/profile.js";
import { PisgahPort, type DoorLog } from "../src/port.js";
import { personCaller } from "../src/journey.sandbox.js";
import { SandboxBlock, mintAgentBearer, sandboxQuery } from "../src/sandbox.js";
import { VOICES, speak } from "./e3.sandbox.test.js";

// Runs only with SANDBOX=1 and F3A=1 against the loopback sandbox, with the live gate, the speaker model named by HEY_PISGAH_SPEAKER_MODEL and HEY_PISGAH_SHERPA_DIR, and a private controls file.
const RUN = process.env["SANDBOX"] === "1" && process.env["F3A"] === "1";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)("F3a from an empty emergency encounter to discharge by voice on the sandbox EMR", () => {
  it("opens the arrival, clerks it, records the diagnosis on the owner's matched line and confirm, the doctor signs at the screen, and the stay closes on the confirmed read-back, with nothing preloaded", async () => {
    const profile = loadProfile();
    const sb = SandboxBlock.parse(profile.sandbox);
    const clinic = process.env["HEY_PISGAH_EMERGENCY_CLINIC"];
    expect(clinic, "the A&E clinic id").toMatch(/^[0-9a-f-]{36}$/);
    const embed = sherpaEmbedder({ modelPath: process.env["HEY_PISGAH_SPEAKER_MODEL"] ?? "", sherpaDir: process.env["HEY_PISGAH_SHERPA_DIR"] })!;
    expect(embed).not.toBeNull();
    const doc = mintAgentBearer(sb);
    const log: DoorLog[] = [];
    const port = new PisgahPort(profile, { bearers: { [doc.owner]: doc.bearer }, onRequest: (l) => log.push(l) });
    const call = personCaller(profile, sb, new Map(), log);
    // A keep-alive socket the app already closed resets once; the person step is tried again on a fresh one.
    const person: typeof call = async (op, vars) => { try { return await call(op, vars); } catch { await wait(1000); return call(op, vars); } };
    const root = mkdtempSync(join(tmpdir(), "hp-f3a-"));
    const dir = join(root, "wav");
    mkdirSync(dir, { recursive: true });
    let rt: EmrRuntime | null = null;
    const client = new ModelClient({ storeRoot: root, mode: "live", recordingsDir: join(root, "recordings"), taskStateOf: (id) => rt?.stateOf(id) ?? null });
    const s = await startEmrServe({ storeRoot: root, port, client, listenPort: Number(process.env["HEY_PISGAH_EMR_PORT"] ?? 4119), emergencyClinicId: clinic!, ears: "off", runtime: { holdMs: 1500, proofRetryMs: 1500, keepHeard: true }, log: (x) => process.stderr.write(`serve: ${x}\n`) });
    rt = s.runtime;
    // The diagnosis write's route, body keys, proof read and the code a control sends all come from the private profile.
    const op = profile.work["record_diagnosis"]!;
    if (!("method" in op) || !op.proof) throw new Error("record_diagnosis is not a proved write in the profile");
    const keyOf = (v: string) => Object.entries(op.body).find(([, x]) => x === v)![0];
    const DX = keyOf("$diagnosis"), VISIT = keyOf("$visit_id");
    const shownAt = Object.entries(op.proof.checks).find(([, x]) => x === "$diagnosis")![0];
    const controlsFile = process.env["HEY_PISGAH_F3A_CONTROLS"];
    if (!controlsFile) throw new Error("set HEY_PISGAH_F3A_CONTROLS to the private controls file");
    const codeControl = JSON.parse(readFileSync(controlsFile, "utf8")) as { code_field: string; code_value: string };
    const result: Record<string, unknown> = { preloaded: "nothing: no fixture SQL, no registration, the arrival is opened by the spoken line" };
    let seq = 0;
    const printOf = async (voice: string, text: string): Promise<Voiceprint> => (await embed(speak(voice, text, join(dir, `l${seq++}.wav`))))!;
    const until = async <T>(what: string, read: () => T | null | undefined | false, ms = 90_000): Promise<T> => {
      const end = Date.now() + ms;
      for (;;) { const v = read(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await wait(300); }
    };
    const lineEnds = new Map<string, number>();
    try {
      // 1. Arrival by voice: the emergency phrase opens an unnamed arrival under the doctor's agent.
      const said0 = new Date().toISOString();
      const em = await s.runtime.emergency(doc.owner, { text: "hey Pisgah, emergency, young woman with right lower abdominal pain", spoken_at: said0, source: "audio", args: { unidentified_ref: unidentifiedRef(new Date(said0)), reason: "young woman with right lower abdominal pain", clinic_id: clinic! } });
      const task = em.task_id;
      const view = (): EmrTaskView => s.runtime.view(task)!;
      const arrived = await until("the arrival", () => { const v = view(); const a = v.actions.find((x) => x.kind === EMERGENCY_KIND); return a && ["completed", "refused", "failed"].includes(a.state) ? v : null; });
      expect(arrived.actions.find((x) => x.kind === EMERGENCY_KIND)!.state).toBe("completed");
      const patient = arrived.patient_id!, visit = arrived.visit_id!;
      expect(visit).toMatch(/^[0-9a-f-]{36}$/);
      result["arrival"] = { patient, visit };
      // Nothing about this patient existed before the spoken line: no diagnosis, no stay.
      expect(sandboxQuery(sb, "f3a_dx_rows", { visit })[0]!["n"]).toBe(0);
      expect(sandboxQuery(sb, "admission_for_visit", { visit })).toEqual([]);

      const sayOwn = async (voice: string, text: string) => {
        const voiceprint = await printOf(voice, text);
        const at = new Date().toISOString();
        const r = await s.runtime.say({ owner: doc.owner, target: { patient_id: patient }, text, source: "audio", spoken_at: at, voiceprint }, task);
        lineEnds.set(r.line_id, Date.parse(at));
        await s.runtime.settled(120_000);
        return r;
      };
      const actionsOf = (kind: string) => view().actions.filter((a) => a.kind === kind);

      // 2. Clerking by voice: findings go into the note.
      await sayOwn(VOICES.owner, "She has had pain in the right lower abdomen since this morning, with vomiting.");
      await sayOwn(VOICES.owner, "On examination there is tenderness and guarding in the right iliac fossa.");
      await until("the clerking note", () => actionsOf("record_clerking").filter((a) => a.state === "completed").length >= 2);

      // 3. The diagnosis by voice: the owner's matched line is read back and waits for a confirm line.
      const dxLine = await sayOwn(VOICES.owner, "The diagnosis is acute appendicitis.");
      const dx = await until("the diagnosis read-back", () => actionsOf("record_diagnosis").find((a) => a.awaiting === "confirm"));
      expect(dx.args).toMatchObject({ visit_id: visit, patient_id: patient });
      const diagnosis = String(dx.args["diagnosis"]);
      expect(diagnosis.toLowerCase()).toContain("appendicitis");
      expect(view().questions.at(-1)?.text).toContain("Say confirm to record this diagnosis");
      // Negative controls: Dr B and an unenrolled voice say confirm, and nothing is recorded.
      await sayOwn(VOICES.drb, "Confirm.");
      await sayOwn(VOICES.stranger, "Confirm.");
      // The diagnosis as the doctor's screen shows it, by the proof read the profile names.
      const draftOf = async (): Promise<string | null> => {
        const q = Object.fromEntries(Object.entries(op.proof!.query ?? {}).map(([k, v]) => [k, v === "$visit_id" ? visit : v]));
        const r = await port.request("GET", op.proof!.path, { owner: doc.owner, evidence: `transcript:${dxLine.line_id}`, spoken_at: new Date().toISOString() }, { query: q });
        return r.kind === "response" ? ((pick(r.json, shownAt) as string | null | undefined) ?? null) : null;
      };
      expect(await draftOf()).toBeNull();
      const confirm = await sayOwn(VOICES.owner, "Confirm.");
      const done = await until("the diagnosis recorded and proved", () => actionsOf("record_diagnosis").find((a) => a.state === "completed" || a.state === "refused" || a.state === "failed"));
      expect(done.state, JSON.stringify(done)).toBe("completed");
      expect((await draftOf())).toBe(diagnosis);
      // Dr B stating a diagnosis is refused outright, and the confirmed one stays.
      const drbDx = await sayOwn(VOICES.drb, "The diagnosis is mesenteric adenitis.");
      expect(view().actions.filter((a) => a.kind === "record_diagnosis" && a.line_id === drbDx.line_id)).toEqual([]);
      result["drb_diagnosis_line"] = { classes: view().transcript.find((l) => l.line_id === drbDx.line_id)?.classes ?? null, refused: view().notes.some((n) => n.text.includes("said a diagnosis")) };
      expect((await draftOf())).toBe(diagnosis);
      const dxSpeed = view().speed.rows.find((r) => r.action_id === done.action_id) ?? null;
      result["diagnosis"] = { words: diagnosis, instruction: dxLine.line_id, confirmation: confirm.line_id, verified_ms_from_instruction: dxSpeed?.ms ?? null, verified_ms_from_confirm: dxSpeed ? Date.parse(dxSpeed.verified_at) - (lineEnds.get(confirm.line_id) ?? 0) : null };

      // The door's own controls on the same write, outside the runtime: each refused, and the draft keeps the confirmed words.
      const h = profile.headers;
      const raw = async (headers: Record<string, string>, body: Record<string, unknown>, evidence = `transcript:${dxLine.line_id}`) => {
        const r = await fetch(`${profile.base_url.replace(/\/+$/, "")}/${op.path}`, {
          method: "POST", body: JSON.stringify({ [VISIT]: visit, ...body }),
          headers: { authorization: `Bearer ${doc.bearer}`, "content-type": "application/json", [h.on_behalf_of]: doc.owner, [h.origin]: profile.origin_value, [h.evidence]: evidence, [h.spoken_at]: new Date().toISOString(), [h.idempotency]: `f3a-raw-${Math.random().toString(36).slice(2)}`, ...headers }
        });
        return { status: r.status, text: (await r.text()).slice(0, 200) };
      };
      const tokenOf = async (voice: string, text: string, line: string) => {
        const v = await port.speaker!(doc.owner, (await printOf(voice, text)).vector, { owner: doc.owner, evidence: `transcript:${line}`, spoken_at: new Date().toISOString() });
        return v.speaker === "owner" ? `transcript:${line}~${v.token}` : null;
      };
      const tag = Date.now().toString(36);
      const instr = (await tokenOf(VOICES.owner, "The diagnosis is perforated appendicitis.", `f3a-${tag}-i`))!;
      const conf = (await tokenOf(VOICES.owner, "Confirmed.", `f3a-${tag}-c`))!;
      expect(await tokenOf(VOICES.drb, "The diagnosis is perforated appendicitis.", `f3a-${tag}-b`)).toBeNull();
      const A = h.authorisation!, C = h.confirmation!;
      const controls = {
        no_voice: await raw({}, { [DX]: "ZZ-TEST control one" }),
        instruction_only: await raw({ [A]: instr }, { [DX]: "ZZ-TEST control two" }, instr.split("~")[0]),
        instruction_as_confirmation: await raw({ [A]: instr, [C]: instr }, { [DX]: "ZZ-TEST control three" }, instr.split("~")[0]),
        evidence_not_the_instruction: await raw({ [A]: instr, [C]: conf }, { [DX]: "ZZ-TEST control four" }),
        code_from_agent: await raw({ [A]: instr, [C]: conf }, { [DX]: "ZZ-TEST control five", [codeControl.code_field]: codeControl.code_value }, instr.split("~")[0]),
        forged: await raw({ [A]: instr, [C]: `transcript:f3a-${tag}-f~v1.${Date.now()}.${"A".repeat(43)}` }, { [DX]: "ZZ-TEST control six" }, instr.split("~")[0])
      };
      for (const k of Object.keys(controls) as (keyof typeof controls)[]) expect(controls[k].status, k).toBeGreaterThanOrEqual(400);
      expect((await draftOf())).toBe(diagnosis);
      // A good pair is accepted once; the same two lines said again are refused as already used.
      const valid = await raw({ [A]: instr, [C]: conf }, { [DX]: "ZZ-TEST control seven" }, instr.split("~")[0]);
      const again = await raw({ [A]: instr, [C]: conf }, { [DX]: "ZZ-TEST control eight" }, instr.split("~")[0]);
      result["door_controls"] = { ...controls, valid_pair: valid, reused: again };
      expect(valid.status).toBe(200);
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(again.text).toMatch(/already used/);
      // Put the confirmed diagnosis back as the owner's own words, by voice, so the record carries the confirmed one.
      const instr2 = (await tokenOf(VOICES.owner, "The diagnosis is acute appendicitis, as I said.", `f3a-${tag}-i2`))!;
      const conf2 = (await tokenOf(VOICES.owner, "I confirm.", `f3a-${tag}-c2`))!;
      expect((await raw({ [A]: instr2, [C]: conf2 }, { [DX]: diagnosis }, instr2.split("~")[0])).status).toBe(200);
      expect((await draftOf())).toBe(diagnosis);

      // 4. Admission by voice, on the owner's authority.
      await sayOwn(VOICES.owner, "Admit her to A and E as an emergency for observation.");
      const adm = await until("the admission", () => actionsOf("admit_patient").find((a) => ["completed", "refused", "failed"].includes(a.state)));
      expect(adm.state, JSON.stringify(adm)).toBe("completed");
      const admission = String(sandboxQuery(sb, "admission_for_visit", { visit })[0]!["id"]);
      result["admission"] = admission;
      // The stay opens when the patient is on a bed.
      await sayOwn(VOICES.owner, "Put her on a bed in A and E.");
      const bed = await until("the bed", () => actionsOf("assign_bed").find((a) => ["completed", "refused", "failed"].includes(a.state)));
      expect(bed.state, JSON.stringify(bed)).toBe("completed");

      // 5. Sign-off by the person: the doctor signs at the screen, with the diagnosis the screen shows from the draft.
      const shown = (await draftOf()) ?? "";
      const signed = await person("sign_consult_dx", { visit_id: visit, patient_id: patient, diagnosis: shown });
      expect(signed.ok, JSON.stringify(signed)).toBe(true);
      expect(sandboxQuery(sb, "f3a_dx_rows", { visit })[0]).toMatchObject({ n: 1, primary: true });

      // 6. Home by voice: the paperwork is read back from the record with the diagnosis, and the owner's confirm closes the stay.
      const home = await sayOwn(VOICES.owner, "She can go home now, rest and come back if the pain returns.");
      const rel = await until("the paperwork read-back", () => actionsOf("release_home").find((a) => a.state !== "proposed" || view().questions.at(-1)?.text.includes("Say confirm to discharge")));
      result["home_question"] = view().questions.at(-1)?.text ?? null;
      expect(rel.state, JSON.stringify(view().notes.slice(-3))).toBe("proposed");
      expect(view().questions.at(-1)!.text).toContain(`Diagnosis from the record: ${diagnosis}`);
      // Each owner line here is worded differently, since the hospital gives one recording a token for one line only.
      const homeConfirm = await sayOwn(VOICES.owner, "Yes, confirm.");
      const out = await until("the stay closed and proved", () => actionsOf("release_home").find((a) => ["completed", "refused", "failed"].includes(a.state)), 120_000);
      expect(out.state, JSON.stringify({ out, notes: view().notes.slice(-3) })).toBe("completed");
      expect(sandboxQuery(sb, "e5_stay", { admission })[0]!["state"]).toBe("discharged");
      const homeSpeed = view().speed.rows.find((r) => r.action_id === out.action_id) ?? null;
      result["home"] = { instruction: home.line_id, confirmation: homeConfirm.line_id, verified_ms_from_instruction: homeSpeed?.ms ?? null, verified_ms_from_confirm: homeSpeed ? Date.parse(homeSpeed.verified_at) - (lineEnds.get(homeConfirm.line_id) ?? 0) : null };

      // The record: every agent write on the owner's behalf with its line, the diagnosis audited with both lines, and one person action.
      const audit = sandboxQuery(sb, "f3a_audit_for_visit", { visit });
      result["audit"] = audit.map((a) => ({ action_type: a["action_type"], agent: a["agent"] === doc.agent, on_behalf_of: a["on_behalf_of"] === doc.owner, evidence: a["evidence"] }));
      const dxAudit = sandboxQuery(sb, "f3a_dx_audit", { visit }).find((a) => (a["after"] as Record<string, unknown>)["confirmation"] === `transcript:${confirm.line_id}`)!;
      expect(dxAudit).toMatchObject({ agent: doc.agent, on_behalf_of: doc.owner, origin: profile.origin_value, evidence: `transcript:${dxLine.line_id}` });
      expect((dxAudit["after"] as Record<string, unknown>)["instruction"]).toBe(`transcript:${dxLine.line_id}`);
      const discharged = sandboxQuery(sb, "e5_discharge_audit", { admission })[0]!;
      expect(discharged).toMatchObject({ agent: doc.agent, owner: doc.owner, evidence: `transcript:${home.line_id}` });
      // The accounts person records the payment (simulated: no money moves), so the bed returns to ready for the next run.
      const paid = await person("discharge_mark_paid", { admission_id: admission });
      expect(paid.ok, JSON.stringify(paid)).toBe(true);
      expect(sandboxQuery(sb, "e5_stay", { admission })[0]).toMatchObject({ state: "discharged", cleared: true, bed_holder: null });
      result["touches"] = { person_actions: 2, which: ["the doctor signs the consultation at the screen", "the accounts person records the simulated payment"], spoken_confirms: 2 };
      result["actions"] = view().actions.map((a) => ({ kind: a.kind, state: a.state, reason: a.reason }));
      result["notes"] = view().notes.map((n) => n.text).slice(-12);
      result["usd"] = view().usd;
      result["calls"] = view().calls;
      result["speed"] = view().speed.rows.map((r) => ({ kind: r.kind, ms: r.ms }));
    } finally {
      const file = process.env["HEY_PISGAH_F3A_OUT"];
      if (file) writeFileSync(file, `${JSON.stringify({ result, requests: log.map((r) => ({ at: r.at, method: r.method, path: r.path, status: r.status, ms: r.ms, reason: r.reason ?? null })) }, null, 1)}\n`);
      await s.close();
      client.close();
    }
  }, 20 * 60_000);
});
