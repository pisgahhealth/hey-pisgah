import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import { EmrRuntime, REGISTER_KIND, type EmrTaskView } from "@hey-pisgah/agent";
import { PisgahPort } from "../src/port.js";
import { loadProfile } from "../src/profile.js";
import { mintAgentBearer, SandboxBlock, sandboxQuery } from "../src/sandbox.js";

// Runs only with SANDBOX=1 and G2=1 against the loopback sandbox; every line is typed in its owner's session and no language model is called.
const RUN = process.env["SANDBOX"] === "1" && process.env["G2"] === "1";
const run = Date.now().toString(36);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SAY = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const results: Record<string, unknown> = { run, synthetic: true };

describe.skipIf(!RUN)("G2 a spoken consent covers only what was said, and names who consented, who obtained it and who entered it", () => {
  it("registers two arrivals from the desk's lines with only the purposes said, and refuses a consent that leaves out registration", async () => {
    const profile = loadProfile();
    const sb = SandboxBlock.parse(profile.sandbox);
    const clinic = process.env["HEY_PISGAH_EMERGENCY_CLINIC"];
    expect(clinic).toMatch(/^[0-9a-f-]{36}$/);
    const doc = mintAgentBearer(sb);
    const desk = mintAgentBearer(sb, sb.owners.find((o) => o.login === "reception.b3")!);
    expect(sandboxQuery(sb, "voice_template_live", { person: desk.owner })[0]!["n"]).toBe(0);
    const port = new PisgahPort(profile, { bearers: { [doc.owner]: doc.bearer, [desk.owner]: desk.bearer } });
    const root = mkdtempSync(join(tmpdir(), "hp-g2-"));
    const client = new ModelClient({ storeRoot: root, mode: "mock", mock: () => { throw new Error("G2 makes no model call"); } });
    const rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 500, emergencyClinicId: clinic! });
    const done = (v: EmrTaskView | undefined, kind: string) => (v?.actions ?? []).filter((a) => a.kind === kind && a.state === "completed");
    const until = async <T>(what: string, read: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 90_000): Promise<T> => {
      const end = Date.now() + ms;
      for (;;) { const v = await read(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await wait(500); }
    };
    // One arrival opened by the doctor's agent and named by the doctor, so the front desk gets its registration task.
    const arrival = async (n: number) => {
      const er = await rt.emergency(doc.owner, { text: `Emergency, arrival ${n} of run ${run}.`, spoken_at: new Date().toISOString(), args: { unidentified_ref: `ZZ-TEST G2 arrival ${run} ${n}`, reason: "Emergency arrival", clinic_id: clinic! } });
      await rt.settled();
      const patient = await until("the arrival", () => rt.view(er.task_id)?.patient_id);
      await rt.say({ owner: doc.owner, target: { patient_id: patient }, text: `Her name is Grace Okafor${run.replace(/\d/g, "")}${"ab"[n - 1]}.` }, er.task_id);
      await rt.settled();
      await until("the registration task", async () => { await rt.pollOnce(); await rt.settled(); return rt.views(desk.owner).find((v) => v.patient_id === patient && v.delegations.some((d) => d.task_kind === "registration")); });
      return { patient, task: er.task_id };
    };
    const deskSays = async (patient: string, text: string) => {
      const r = rt.say({ owner: desk.owner, target: { patient_id: patient }, text: `${text}` });
      await rt.settled();
      return r;
    };
    const phone = (n: number) => `0803${String(Date.now()).slice(-6)}${n}`;
    const spoken = (p: string) => p.split("").map((d) => SAY[Number(d)]).join(" ");
    try {
      // A registration consent stamps registration only, and scribing stays unconsented.
      const a = await arrival(1);
      const t0 = Date.now();
      await deskSays(a.patient, `Her phone is ${spoken(phone(1))} and she consents to registration.`);
      const deskA = await until("the first registration", () => rt.views(desk.owner).find((v) => v.patient_id === a.patient && done(v, REGISTER_KIND).length));
      results["ms_first"] = Date.now() - t0;
      const pa = sandboxQuery(sb, "patient_consent", { patient: a.patient })[0]!;
      expect(pa).toMatchObject({ is_unidentified: false, consented_by: desk.owner, consent_version: "v1.3", consent_purposes: [] });
      const atA = sandboxQuery(sb, "attestations_for", { patient: a.patient });
      expect(atA).toHaveLength(1);
      expect(atA[0]).toMatchObject({ consented_by: "patient", obtained_by: desk.owner, entered_by: desk.agent, purposes: ["registration"], notice_version: "v1.3", attribution: "session" });
      const auA = sandboxQuery(sb, "identity_audit", { patient: a.patient });
      expect(auA).toHaveLength(1);
      expect(auA[0]).toMatchObject({ actor: desk.agent, agent: desk.agent, on_behalf_of: desk.owner, consent: { obtainedBy: desk.owner, enteredBy: desk.agent, purposes: ["registration"], stamped: [], attributedBy: "session_voice_not_enrolled" } });
      expect(String(auA[0]!["evidence"])).toMatch(/^transcript:/);
      expect(deskA.notes.at(-1)!.text).toMatch(/Consent recorded for registration only, taken on your session, since your voice is not enrolled; scribe, tests, results sharing, pharmacy, messages, identity check not consented\./);
      results["first"] = { patient: pa, attestation: atA, audit: auA, note: deskA.notes.at(-1)!.text };

      // The purposes said on two lines are stamped, a purpose said against is left out, and a line that leaves out registration registers nothing.
      const b = await arrival(2);
      await deskSays(b.patient, `Her phone is ${spoken(phone(2))}, and she agrees to the consultation being recorded and her tests.`);
      await wait(1500);
      expect(sandboxQuery(sb, "patient_consent", { patient: b.patient })[0]).toMatchObject({ is_unidentified: true });
      expect(rt.views(desk.owner).find((v) => v.patient_id === b.patient)!.notes.at(-1)!.text).toMatch(/does not cover registration/);
      await deskSays(b.patient, "She consents to registration too, but no text messages.");
      await until("the second registration", () => rt.views(desk.owner).find((v) => v.patient_id === b.patient && done(v, REGISTER_KIND).length));
      const pb = sandboxQuery(sb, "patient_consent", { patient: b.patient })[0]!;
      expect(pb).toMatchObject({ is_unidentified: false, consented_by: desk.owner, consent_purposes: ["diagnostic_workflow", "consultation_scribe"] });
      const atB = sandboxQuery(sb, "attestations_for", { patient: b.patient });
      expect(atB[0]).toMatchObject({ purposes: ["consultation_scribe", "diagnostic_workflow", "registration"], attribution: "session", entered_by: desk.agent });
      results["second"] = { patient: pb, attestation: atB };

      // Negative controls at the door: the agent's registration without the consent purposes, and with purposes that leave out registration, are refused.
      const c = await arrival(3);
      const reg = rt.views(desk.owner).find((v) => v.patient_id === c.patient)!.delegations.find((d) => d.task_kind === "registration")!;
      const base = { delegation_id: reg.delegation_id!, patient_id: c.patient, surname: "Okafor", other_names: "ZZ-TEST Grace", phone: phone(3), evidence: `transcript:g2-${run}-ctl`, consent_spoken_at: new Date().toISOString() };
      const prov = { owner: desk.owner, evidence: `transcript:g2-${run}-ctl`, spoken_at: new Date().toISOString() };
      const none = await port.commit(REGISTER_KIND, { ...base, consent_purposes: [] }, `g2-${run}-none`, prov);
      const noReg = await port.commit(REGISTER_KIND, { ...base, consent_purposes: ["scribe", "tests"] }, `g2-${run}-noreg`, prov);
      results["controls"] = { no_purposes: none, no_registration: noReg };
      expect(none).toMatchObject({ ok: false });
      expect(noReg).toMatchObject({ ok: false });
      expect(sandboxQuery(sb, "patient_consent", { patient: c.patient })[0]).toMatchObject({ is_unidentified: true });
      expect(sandboxQuery(sb, "attestations_for", { patient: c.patient })).toHaveLength(0);
      results["ok"] = true;
    } finally {
      await rt.stop();
      const out = process.env["HEY_PISGAH_G2_OUT"];
      if (out) writeFileSync(out, JSON.stringify(results, null, 1));
    }
  }, 6 * 60_000);
});
