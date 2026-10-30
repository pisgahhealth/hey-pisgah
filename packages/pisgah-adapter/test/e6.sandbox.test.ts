import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { startEmrServe, type EmrRuntime, type EmrTaskView } from "@hey-pisgah/agent";
import { ModelClient } from "@hey-pisgah/model";
import { listStreams, readStream } from "@hey-pisgah/store";
import { PisgahPort } from "../src/port.js";
import { loadProfile } from "../src/profile.js";
import { mintAgentBearer, sandboxQuery } from "../src/sandbox.js";
import { freshArrival } from "./sandbox-helpers.js";

// Runs only with SANDBOX=1 against the loopback sandbox named in the private profile; record checks use read-only SQL.
const RUN = process.env["SANDBOX"] === "1";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)("E6 preference memory on the sandbox EMR", () => {
  it("keeps a correction as a candidate until its owner scopes it, then applies it on a fresh patient with its source, and withholds a rule scoped to another ward", async () => {
    const profile = loadProfile();
    const first = await freshArrival(profile);
    const second = await freshArrival(profile);
    const third = await freshArrival(profile);
    const mine = mintAgentBearer(first.sb);
    const port = new PisgahPort(profile, { bearers: { [mine.owner]: mine.bearer } });
    const root = process.env["HEY_PISGAH_E6_STORE"] ?? mkdtempSync(join(tmpdir(), "hp-e6-"));
    let rt: EmrRuntime | null = null;
    const client = new ModelClient({ storeRoot: root, mode: "live", recordingsDir: join(root, "recordings"), taskStateOf: (id) => rt?.stateOf(id) ?? null });
    // A long hold, so the spoken correction reaches the care-plan item before it is written.
    const s = await startEmrServe({ storeRoot: root, port, client, listenPort: Number(process.env["HEY_PISGAH_EMR_PORT"] ?? 4111), ears: "off", runtime: { holdMs: 25_000, proofRetryMs: 1500 }, log: (x) => process.stderr.write(`serve: ${x}\n`) });
    rt = s.runtime;
    const post = async (path: string, body: Record<string, unknown>) => fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const say = async (target: Record<string, string>, text: string, settle = true) => {
      process.stderr.write(`say: ${text}\n`);
      const r = await post("/tasks/say", { owner: mine.owner, ...target, text, via: "gate" });
      expect(r.status).toBe(202);
      const b = (await r.json()) as { task_id: string; line_id: string };
      if (settle) await s.runtime.settled(8 * 60_000);
      return b;
    };
    // No bed is asked for, so the run takes none of the sandbox's free beds; the ward is the one the doctor named.
    const admit = async (patient: string, visit: string) => {
      await say({ patientId: patient }, "Admit him as an emergency to the children's ward for observation.");
      const a = sandboxQuery(first.sb, "admission_for_visit", { visit })[0];
      expect(a, "the admission exists").toBeDefined();
      return String(a!["id"]);
    };
    const items = (admission: string) => sandboxQuery(first.sb, "care_items_for", { admission }).filter((x) => x["created_by"] === mine.agent);
    const out: Record<string, unknown> = { measured_at: new Date().toISOString(), measured: true, mode: "live", owner_role: "doctor" };
    try {
      // A hospital rule for another ward, added as text by a person; it must be withheld on the children's ward.
      const rule = await post("/preferences/external", { owner: mine.owner, text: "A and E rule: observations six hourly for every admitted patient.", scope: "ward", ward: "A and E" });
      expect(rule.status).toBe(201);

      // Patient one: a care-plan item corrected while it waits on its hold; the correction becomes a candidate and a question.
      const a1 = await admit(first.patient, first.visit);
      await say({ admissionId: a1 }, "Add four hourly observations to the care plan.", false);
      await wait(1500);
      const fix = await say({ admissionId: a1 }, "No, make that two hourly.");
      for (let i = 0; i < 60 && items(a1).length === 0; i++) await wait(1000);
      expect(items(a1).map((x) => x["cadence_code"])).toEqual(["q2h"]);
      const v1 = s.runtime.view(fix.task_id)!;
      const candidate = s.preferences!.all().find((p) => p.source.kind === "correction")!;
      expect(candidate).toMatchObject({ state: "candidate", value: "q2h", item_kind: "observation" });
      expect(v1.questions.at(-1)?.answers).toEqual(["patient", "me", "ward", "everyone", "no"]);

      // Patient two before any scope is chosen: nothing is filled from the candidate, and the strip says why.
      const a2 = await admit(second.patient, second.visit);
      const before = await say({ admissionId: a2 }, "Add observations to the care plan.");
      const v2a = s.runtime.view(before.task_id)!;
      const itemsBefore = items(a2).length;
      expect(itemsBefore).toBe(0);
      expect(v2a.preferences.applied).toEqual([]);
      const unscoped = v2a.preferences.withheld.filter((w) => w.pref_id === candidate.pref_id);
      expect(unscoped[0]?.reason).toMatch(/no scope was chosen/);
      expect(v2a.questions.at(-1)?.text).toMatch(/How often/);

      // The owner settles the scope with one word on patient one's task.
      await say({ admissionId: a1 }, "me");
      expect(s.preferences!.get(candidate.pref_id)).toMatchObject({ state: "active", scope: { kind: "me" }, decided: { via: "word" } });

      // Patient three, a fresh encounter after the scope was chosen: the preference fills the unsaid cadence, the record shows it, and the strip shows its source; the other ward's rule is withheld.
      const a3 = await admit(third.patient, third.visit);
      const after = await say({ admissionId: a3 }, "Add observations to the care plan.");
      for (let i = 0; i < 60 && items(a3).length === 0; i++) await wait(1000);
      const v2b = s.runtime.view(after.task_id)!;
      expect(items(a3).map((x) => x["cadence_code"])).toEqual(["q2h"]);
      const applied = v2b.preferences.applied.find((p) => p.pref_id === candidate.pref_id);
      expect(applied).toMatchObject({ value: "q2h", scope: "your patients", source: expect.stringMatching(/^your correction/) });
      const act = v2b.actions.find((x) => x.action_id === applied!.action_id)!;
      expect(act).toMatchObject({ kind: "add_care_plan_item", state: "completed" });
      const ruleWithheld = v2b.preferences.withheld.filter((w) => w.value === "q6h");
      expect(ruleWithheld.at(-1)?.reason).toMatch(/its scope is ward A and E and this patient is on children's ward/);

      const gate = listStreams(root, "emr").flatMap((sid) => readStream(root, sid)).filter((e) => e.record_type === "gate.decided").map((e) => e.payload as { model: string; cost_usd: number });
      const view = (v: EmrTaskView) => ({ applied: v.preferences.applied, withheld: v.preferences.withheld, notes: v.notes.map((n) => n.text) });
      Object.assign(out, {
        candidate_held_before_scope: unscoped.length === 1 && itemsBefore === 0 && v2a.preferences.applied.length === 0,
        applied_on_fresh_encounter: !!applied && act.state === "completed", applied_value_in_record: items(a3)[0]?.["cadence_code"] ?? null, patient_two_items_after: items(a2).length,
        applied_source_visible: !!applied?.source && !!applied?.scope, withheld_where_scope_says: ruleWithheld.length >= 1 ? 1 : 0,
        withheld_reasons: [unscoped[0]?.reason ?? null, ruleWithheld.at(-1)?.reason ?? null], scope_decided_by: "owner, one word",
        corrected_entry_in_record: items(a1)[0]?.["cadence_code"] ?? null, record_checks: "read-only SQL on the sandbox care plan, items made by the doctor's agent",
        patient_one: view(v1), patient_two: view(v2a), patient_three: view(v2b),
        gate_calls: gate.length, cost_usd: Math.round(gate.reduce((n, g) => n + (g.cost_usd ?? 0), 0) * 1e6) / 1e6, models: [...new Set(gate.map((g) => g.model))]
      });
    } finally {
      const file = process.env["HEY_PISGAH_E6_REMEMBER"];
      if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`); }
      await s.close();
      client.close();
    }
  }, 30 * 60_000);
});
