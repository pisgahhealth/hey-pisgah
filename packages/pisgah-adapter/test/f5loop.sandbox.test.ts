import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startEmrServe, type EmrRuntime, type Provenance } from "@hey-pisgah/agent";
import { ModelClient } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { loadProfile } from "../src/profile.js";
import { PisgahPort, type DoorLog } from "../src/port.js";
import { SandboxBlock, mintAgentBearer, sandboxQuery } from "../src/sandbox.js";
import { adoptedForEmr } from "../src/versions.js";
import { freshArrival } from "./sandbox-helpers.js";

// Runs only with SANDBOX=1, F5_LOOP=1, the private loop profile and F5_VERSIONS naming the person's version log; the gate is live Spark Open.
const RUN = process.env["SANDBOX"] === "1" && process.env["F5_LOOP"] === "1" && !!process.env["F5_VERSIONS"] && !!process.env["F5_OUT"];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Row = Record<string, unknown>;

describe.skipIf(!RUN)("F5 one learning loop on a fresh EMR stay", () => {
  it("offers the adopted change at the round entry on a ward A stay, drafts and saves the summary on the nurse's word, and withholds it on a ward B stay with its reason", async () => {
    const profile = loadProfile();
    const sb = SandboxBlock.parse(profile.sandbox);
    const out = process.env["F5_OUT"]!;
    mkdirSync(out, { recursive: true });
    const doc = mintAgentBearer(sb);
    const nurse = mintAgentBearer(sb, sb.owners.find((o) => o.login === "nurse.ada")!);
    const requests: DoorLog[] = [];
    const port = new PisgahPort(profile, { bearers: { [doc.owner]: doc.bearer, [nurse.owner]: nurse.bearer }, onRequest: (l) => requests.push(l) });
    const now = () => new Date().toISOString();
    const prov = (line: string): Provenance => ({ owner: doc.owner, evidence: `transcript:${line}`, spoken_at: now() });
    const until = async <T>(what: string, read: () => T | null | undefined | false, ms = 180_000): Promise<T> => {
      const end = Date.now() + ms;
      for (;;) { const v = read(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await wait(500); }
    };
    // A fresh arrival, admitted by the doctor's agent to the ward and bedded, then the doctor's round entry on the stay.
    const stay = async (label: string, ward: string, tag: string) => {
      const { patient, visit } = await freshArrival(profile, label);
      expect(await port.commit("open_consult", { visit_id: visit, patient_id: patient }, `f5-open-${visit}`, prov(`f5-open-${tag}`))).toMatchObject({ ok: true });
      const adm = await port.commit("admit_patient", { visit_id: visit, patient_id: patient, ward, admission_type: "emergency", reason: "ZZ-TEST abdominal pain for observation" }, `f5-admit-${visit}`, prov(`f5-admit-${tag}`));
      expect(adm, JSON.stringify(adm)).toMatchObject({ ok: true });
      const admission = (adm as { record_id: string }).record_id;
      // A bed is taken when the ward has one free; the ward the stay is on comes from the admission either way.
      const bed = await port.commit("assign_bed", { admission_id: admission, ward }, `f5-bed-${visit}`, prov(`f5-bed-${tag}`));
      return { patient, visit, admission, bed: bed.ok ? "assigned" : bed.reason };
    };
    const root = join(out, "store");
    const versions = adoptedForEmr(root, process.env["F5_VERSIONS"]!, () => loadProfile().versions!);
    let rt: EmrRuntime | null = null;
    const client = new ModelClient({ storeRoot: root, mode: "live", recordingsDir: join(out, "recordings"), taskStateOf: (id) => rt?.stateOf(id) ?? null });
    const s = await startEmrServe({ storeRoot: root, port, client, listenPort: Number(process.env["HEY_PISGAH_EMR_PORT"] ?? 4151), ears: "off", runtime: { holdMs: 1500, proofRetryMs: 1500, watchMs: 4000, versions: versions.wiring }, log: (x) => process.stderr.write(`serve: ${x}\n`) });
    rt = s.runtime;
    const result: Row = { version: versions.def.version, definition_hash: versions.def.definition_hash };
    const types = (taskId: string) => readStream(root, `emr/${taskId}`);
    try {
      // F5_B_ADMISSION names an earlier F5 stay to use as the ward B case, so only that part runs.
      const onlyB = process.env["F5_B_ADMISSION"] ?? null;
      if (!onlyB) {
      // Ward A: the fresh applicable encounter.
      const a = await stay("F5 Loop A", "childrens", "a");
      const tA = await s.runtime.open(nurse.owner, { admission_id: a.admission });
      const before = await until("the nurse's first watch", () => s.runtime.view(tA.task_id)!.watching);
      result["a_watch_before_round"] = { round: before["stay.round"] ?? null, ward: before["stay.ward"] ? "read" : null };
      expect(s.runtime.view(tA.task_id)!.questions).toHaveLength(0);
      const round = await port.commit("record_note", { admission_id: a.admission, note_type: "ward_round", text: "Ward round: abdominal pain settling, abdomen soft, tolerating fluids, plan home tomorrow if well." }, `f5-round-${a.admission}`, prov("f5-round-a"));
      expect(round, JSON.stringify(round)).toMatchObject({ ok: true });
      const offered = await until("the offer at the round entry", () => s.runtime.view(tA.task_id)!.questions.find((q) => q.text.startsWith("The round entry is on the stay")));
      result["a_offer"] = { question: offered.text, at: now(), rows: types(tA.task_id).filter((e) => e.record_type === "offer.made").map((e) => e.payload) };
      const say = async (text: string) => {
        const r = await fetch(`${s.url}/tasks/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: nurse.owner, admissionId: a.admission, text, spokenAt: now() }) });
        expect(r.status, await r.clone().text()).toBe(202);
        await s.runtime.settled();
        return (await r.json()) as { line_id: string };
      };
      await say("Draft the summary.");
      const draftQ = await until("the draft for review", () => s.runtime.view(tA.task_id)!.questions.find((q) => q.text.startsWith("Summary draft for your review")));
      result["a_draft_question_chars"] = draftQ.text.length;
      const saveLine = await say("That reads right. Save the summary.");
      const saved = await until("the saved summary proved", () => s.runtime.view(tA.task_id)!.actions.find((x) => x.kind === "record_note" && x.state === "completed" && x.args["label"] === "stay_summary"));
      const notes = sandboxQuery(sb, "notes", { admission: a.admission });
      const provRows = sandboxQuery(sb, "provenance_since", { since: new Date(Date.now() - 3_600_000).toISOString() }).filter((r) => r["evidence"] === `transcript:${saveLine.line_id}`);
      result["a_saved"] = { action: saved.action_id, line: saveLine.line_id, record_id: saved.proof?.record_id ?? null, notes: notes.map((n) => ({ id: n["id"], author: n["author"], note_type: n["note_type"] })), provenance: provRows.map((r) => ({ action_type: r["action_type"], agent: r["agent"], on_behalf_of: r["on_behalf_of"], origin: r["origin"] })) };
      expect(notes.some((n) => n["id"] === saved.proof?.record_id && n["author"] === nurse.agent)).toBe(true);
      expect(provRows.some((r) => r["on_behalf_of"] === nurse.owner && r["agent"] === nurse.agent)).toBe(true);

      result["stays_a"] = { admission: a.admission, patient: a.patient, bed: a.bed };
      result["task_a"] = tA.task_id;
      }
      // Ward B: the withheld case, the same trigger point on a ward the adopted scope does not cover.
      const b = onlyB ? { admission: onlyB, patient: null, bed: "earlier" } : await stay("F5 Loop B", "private", "b");
      const tB = await s.runtime.open(nurse.owner, { admission_id: b.admission });
      await until("the nurse's first watch on B", () => s.runtime.view(tB.task_id)!.watching);
      if (!onlyB) expect((await port.commit("record_note", { admission_id: b.admission, note_type: "ward_round", text: "Ward round: settling, feeding well." }, `f5-round-${b.admission}`, prov("f5-round-b")))).toMatchObject({ ok: true });
      const withheld = await until("the withheld offer", () => types(tB.task_id).find((e) => e.record_type === "version.offer_withheld"));
      await wait(9000);
      const vB = s.runtime.view(tB.task_id)!;
      result["b_withheld"] = { row: withheld.payload, version_in_force: vB.version?.version ?? null, questions: vB.questions.length, offers: types(tB.task_id).filter((e) => e.record_type === "offer.made").length, note: vB.notes.find((n) => n.text.startsWith("Not offered"))?.text ?? null };
      expect(vB.questions).toHaveLength(0);
      result["stay_b"] = { admission: b.admission, patient: b.patient, bed: b.bed, reused: !!onlyB };
      result["task_b"] = tB.task_id;
      result["ok"] = true;
    } finally {
      result["ledger"] = s.runtime.views(nurse.owner).reduce((n, v) => n + v.calls, 0);
      writeFileSync(join(out, "loop.json"), `${JSON.stringify(result, null, 1)}\n`);
      writeFileSync(join(out, "requests.json"), `${JSON.stringify(requests, null, 1)}\n`);
      await s.close();
      client.close();
    }
  }, 1_200_000);
});
