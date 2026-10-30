import { describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { EmrRuntime } from "../src/emr/runtime.js";
import { startEmrServe } from "../src/emr/serve.js";
import { PREFERENCES_STREAM, PreferenceError, PreferenceMemory, choosePreference, readRule, scopeAnswer } from "../src/emr/preferences.js";
import type { EmrCommit, EmrContext, EmrPort, EmrProof, EmrTarget, Provenance, SayableNames, WorkArgs } from "../src/emr/port.js";
import { CLERK_KINDS, ins, type W } from "./clerking-helpers.js";
import { emrRoot, gater, type C } from "./emr-helpers.js";

const DOC = "doc-1", OTHER = "doc-2";
// Three admitted patients: two on the children's ward and one on the male ward.
const PATIENTS = {
  p1: { patient: "aaaaaaaa-1111-4222-8333-000000000001", admission: "cccccccc-1111-4222-8333-000000000001", ward: "Children's Ward" },
  p2: { patient: "aaaaaaaa-1111-4222-8333-000000000002", admission: "cccccccc-1111-4222-8333-000000000002", ward: "Children's Ward" },
  p3: { patient: "aaaaaaaa-1111-4222-8333-000000000003", admission: "cccccccc-1111-4222-8333-000000000003", ward: "Male Ward" }
} as const;
type Key = keyof typeof PATIENTS;

class WardsFake implements EmrPort {
  readonly writeKinds = ["record_observation"] as const;
  readonly writes: { kind: string; args: WorkArgs; key: string; prov: Provenance }[] = [];
  kindsFor(): readonly string[] { return CLERK_KINDS; }
  refusedCount(): number { return 0; }
  names(): SayableNames { return { page_targets: {}, clinics: {}, wards: { childrens: ["children's ward"], male: ["male ward"] } }; }
  async resolve(target: EmrTarget): Promise<EmrContext> {
    const p = Object.values(PATIENTS).find((x) => x.admission === target.admission_id || x.patient === target.patient_id);
    if (!p) throw new Error("unknown target");
    return { admission_id: p.admission, patient_id: p.patient, visit_id: null, label: "Patient", facts: { ward: p.ward, bed: "1" }, keywords: [] };
  }
  async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    if (!this.writes.some((w) => w.key === key)) this.writes.push({ kind, args, key, prov });
    return { ok: true, record_id: `${kind}-${this.writes.length}`, record_version: 1, event_ids: [`${kind}:${this.writes.length}`], replayed: false };
  }
  async prove(_k: string, _a: WorkArgs, written: { record_id: string; record_version: number; event_ids: string[] }): Promise<EmrProof | null> {
    return { ...written, record_hash: "0".repeat(64), verified_at: new Date().toISOString(), read: "fake" };
  }
}

// What the gate returns for each line in these tests: an observation item with or without a cadence, a correction, or a note.
const script = (said: string): W[] => {
  if (/^No, make that two hourly/.test(said)) return [{ class: "correction", kind: "add_care_plan_item", cadence: "q2h", confidence: 0.95 }];
  if (/four hourly/.test(said)) return [ins("add_care_plan_item", { title: "observations", item_kind: "observation", cadence: "q4h" })];
  if (/one hourly observations/.test(said)) return [ins("add_care_plan_item", { title: "observations", item_kind: "observation", cadence: "q4h" })];
  if (/observations/.test(said)) return [ins("add_care_plan_item", { title: "observations", item_kind: "observation", cadence: "q4h" })];
  if (/note/.test(said)) return [ins("record_note", { note_type: "progress", text: "settled overnight" })];
  return [];
};

function boot(o: { root?: string; holdMs?: number; gateCalls?: string[] } = {}) {
  const root = o.root ?? emrRoot();
  const port = new WardsFake();
  const prefs = new PreferenceMemory(root);
  let rt: EmrRuntime | null = null;
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater((s) => script(s) as unknown as C[], o.gateCalls ?? []), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: o.holdMs ?? 0, proofRetryMs: 1, preferences: prefs });
  rt.start();
  const say = async (owner: string, who: Key, text: string) => {
    const r = await rt!.say({ owner, target: { admission_id: PATIENTS[who].admission }, text, via: "gate" });
    await rt!.settled();
    return r;
  };
  // A line sent without waiting for its hold, so a correction can reach the action before it is written.
  const sayNow = (owner: string, who: Key, text: string) => rt!.say({ owner, target: { admission_id: PATIENTS[who].admission }, text, via: "gate" });
  const close = async () => { await rt!.stop(); client.close(); prefs.close(); };
  return { rt, port, prefs, root, say, sayNow, close };
}
const cadences = (port: WardsFake) => port.writes.filter((w) => w.kind === "add_care_plan_item").map((w) => w.args["cadence"]);

describe("preference memory: rules read by rule", () => {
  it("reads a cadence for one kind of item, or a note type, and nothing else", () => {
    expect(readRule("from now on, observations two hourly")).toEqual({ field: "care_plan_cadence", item_kind: "observation", value: "q2h" });
    expect(readRule("Ward rule: vitals every 4 hours on this ward")).toEqual({ field: "care_plan_cadence", item_kind: "observation", value: "q4h" });
    expect(readRule("from now on write my notes as ward round notes")).toEqual({ field: "note_type", item_kind: null, value: "ward_round" });
    expect(readRule("from now on be quicker")).toBeNull();
    expect(readRule("observations two hourly and medications four hourly")).toBeNull();
    expect(scopeAnswer("me")).toBe("me");
    expect(scopeAnswer("just this patient")).toBe("patient");
    expect(scopeAnswer("the ward")).toBe("ward");
    expect(scopeAnswer("everyone")).toBe("everyone");
    expect(scopeAnswer("no")).toBe("no");
    expect(scopeAnswer("chart the pulse 88")).toBeNull();
  });
});

describe("preference memory in the EMR runtime", () => {
  it("keeps a patient-specific correction as a candidate only: a fresh encounter is not filled from it and shows why", async () => {
    const a = boot({ holdMs: 1500 });
    await a.sayNow(DOC, "p1", "Add four hourly observations to the care plan.");
    const fix = await a.say(DOC, "p1", "No, make that two hourly.");
    expect(cadences(a.port)).toEqual(["q2h"]);
    expect(a.port.writes[0]!.args).toMatchObject({ title: "observations", item_kind: "observation" });
    const v1 = a.rt.view(fix.task_id)!;
    expect(v1.questions.at(-1)).toMatchObject({ answers: ["patient", "me", "ward", "everyone", "no"] });
    expect(v1.preferences.candidates).toHaveLength(1);
    expect(a.prefs.all()).toMatchObject([{ state: "candidate", scope: null, value: "q2h", source: { kind: "correction" } }]);

    // A fresh encounter with no answer: the cadence is asked for, never filled, and the strip says the candidate was not used.
    const fresh = await a.say(DOC, "p2", "Add observations to the care plan.");
    const v2 = a.rt.view(fresh.task_id)!;
    expect(cadences(a.port)).toEqual(["q2h"]);
    expect(v2.questions.at(-1)?.text).toMatch(/How often/);
    expect(v2.preferences.applied).toEqual([]);
    expect(v2.preferences.withheld).toMatchObject([{ value: "q2h", reason: expect.stringMatching(/no scope was chosen/) }]);
    expect(v2.notes.map((n) => n.text).join(" ")).toMatch(/Not used here: observation items two hourly/);
    await a.close();
  });

  it("applies a correction kept for 'me' on a fresh encounter, visible with its source, and survives a restart", async () => {
    const a = boot({ holdMs: 1500 });
    await a.sayNow(DOC, "p1", "Add four hourly observations to the care plan.");
    await a.say(DOC, "p1", "No, make that two hourly.");
    const word = await a.say(DOC, "p1", "me");
    expect(a.prefs.all()).toMatchObject([{ state: "active", scope: { kind: "me" }, decided: { by: DOC, via: "word", line_id: word.line_id } }]);
    await a.close();

    const b = boot({ root: a.root });
    const fresh = await b.say(DOC, "p3", "Add observations to the care plan.");
    expect(cadences(b.port)).toEqual(["q2h"]);
    const v = b.rt.view(fresh.task_id)!;
    expect(v.preferences.applied).toMatchObject([{ value: "q2h", scope: "your patients", source: expect.stringMatching(/^your correction "No, make that two hourly/), action_id: v.actions[0]!.action_id }]);
    expect(v.notes.map((n) => n.text)).toContain('observation items two hourly (q2h): used your correction "No, make that two hourly.", scope your patients.');

    // A cadence said aloud always beats the preference.
    await b.say(DOC, "p3", "Add four hourly observations to the care plan.");
    expect(cadences(b.port)).toEqual(["q2h", "q4h"]);

    // Another clinician's agent never uses or lists it.
    const other = await b.say(OTHER, "p2", "Add observations to the care plan.");
    expect(b.rt.view(other.task_id)!.preferences).toEqual({ applied: [], withheld: [], candidates: [] });
    expect(b.rt.view(other.task_id)!.questions.at(-1)?.text).toMatch(/How often/);
    await b.close();
  });

  it("keeps a preference for this patient only: applied again for that patient and withheld for the next", async () => {
    const a = boot({ holdMs: 1500 });
    await a.sayNow(DOC, "p1", "Add four hourly observations to the care plan.");
    await a.say(DOC, "p1", "No, make that two hourly.");
    await a.say(DOC, "p1", "just this patient");
    await a.say(DOC, "p1", "Add observations to the care plan.");
    expect(cadences(a.port)).toEqual(["q2h", "q2h"]);
    const next = await a.say(DOC, "p2", "Add observations to the care plan.");
    expect(cadences(a.port)).toEqual(["q2h", "q2h"]);
    expect(a.rt.view(next.task_id)!.preferences.withheld).toMatchObject([{ value: "q2h", scope: "this patient only", reason: "its scope is another patient" }]);
    await a.close();
  });

  it("adds a hospital rule as text under a ward scope: used on that ward, withheld elsewhere, and it outranks a clinician's own default", async () => {
    const a = boot();
    a.prefs.external({ by: "wm-1", text: "Children's ward rule: observations two hourly for every admitted child.", scope: "ward", ward: "Children's Ward" });
    const kid = await a.say(DOC, "p2", "Add observations to the care plan.");
    expect(cadences(a.port)).toEqual(["q2h"]);
    expect(a.rt.view(kid.task_id)!.preferences.applied).toMatchObject([{ scope: "ward Children's Ward", source: expect.stringMatching(/^a hospital rule added as text/) }]);
    const man = await a.say(DOC, "p3", "Add observations to the care plan.");
    expect(cadences(a.port)).toEqual(["q2h"]);
    expect(a.rt.view(man.task_id)!.preferences.withheld).toMatchObject([{ reason: "its scope is ward Children's Ward and this patient is on Male Ward" }]);

    // The clinician's own "from now on", read by rule with no gate call, loses to the ward rule on that ward and wins on the other.
    const calls: string[] = [];
    await a.close();
    const b = boot({ root: a.root, gateCalls: calls });
    const rule = await b.say(DOC, "p3", "From now on, observations six hourly.");
    expect(calls).toEqual([]);
    await b.say(DOC, "p3", "me");
    expect(b.prefs.all().find((p) => p.source.kind === "from_now_on")).toMatchObject({ state: "active", value: "q6h", scope: { kind: "me" }, source: { line_id: rule.line_id } });
    await b.say(DOC, "p3", "Add observations to the care plan.");
    const kid2 = await b.say(DOC, "p1", "Add observations to the care plan.");
    expect(cadences(b.port)).toEqual(["q6h", "q2h"]);
    expect(b.rt.view(kid2.task_id)!.preferences.withheld).toMatchObject([{ value: "q6h", reason: expect.stringMatching(/hospital rule .* came first/) }]);
    await b.close();
  });

  it("lets only the owner choose the scope, declines on no, and tells a rule it cannot read", async () => {
    const a = boot({ holdMs: 1500 });
    await a.sayNow(DOC, "p1", "Add four hourly observations to the care plan.");
    const fix = await a.say(DOC, "p1", "No, make that two hourly.");
    const id = a.prefs.all()[0]!.pref_id;
    expect(() => a.prefs.decide(id, OTHER, "everyone", "strip")).toThrow(PreferenceError);
    expect(() => a.rt.scopePreference(fix.task_id, OTHER, id, "everyone")).toThrow(/another owner/);
    expect(a.rt.scopePreference(fix.task_id, DOC, id, "no")).toEqual({ ok: true, reason: null });
    expect(a.prefs.get(id)).toMatchObject({ state: "declined" });
    expect(a.rt.view(fix.task_id)!.questions).toEqual([]);
    const fresh = await a.say(DOC, "p2", "Add observations to the care plan.");
    expect(a.rt.view(fresh.task_id)!.preferences).toEqual({ applied: [], withheld: [], candidates: [] });
    const vague = await a.say(DOC, "p2", "From now on be quicker with the obs.");
    expect(a.rt.view(vague.task_id)!.notes.at(-1)?.text).toMatch(/could not read either/);
    expect(readStream(a.root, PREFERENCES_STREAM).map((e) => e.record_type)).toEqual(["preference.candidate", "preference.declined"]);
    await a.close();
  });

  it("chooses by scope with no runtime: everyone reaches a colleague, me does not", () => {
    const base = { item_kind: "observation", field: "care_plan_cadence" as const, origin: { patient_id: null, ward: null }, decided: { by: DOC, at: "2026-10-30T00:00:00.000Z", via: "word" as const, line_id: null } };
    const src = { kind: "correction" as const, owner: DOC, task_id: null, line_id: null, quote: "", at: "2026-10-30T00:00:00.000Z" };
    const mine = { ...base, pref_id: "pf-1", owner: DOC, value: "q2h", state: "active" as const, scope: { kind: "me" as const }, source: src };
    const all = { ...base, pref_id: "pf-2", owner: DOC, value: "q6h", state: "active" as const, scope: { kind: "everyone" as const }, source: src };
    expect(choosePreference([mine, all], { owner: DOC, patient_id: null, ward: null, field: "care_plan_cadence", item_kind: "observation" }).applied?.pref_id).toBe("pf-1");
    const theirs = choosePreference([mine, all], { owner: OTHER, patient_id: null, ward: null, field: "care_plan_cadence", item_kind: "observation" });
    expect(theirs.applied?.pref_id).toBe("pf-2");
    expect(theirs.withheld).toEqual([]);
    expect(choosePreference([mine], { owner: DOC, patient_id: null, ward: null, field: "care_plan_cadence", item_kind: "medication" }).applied).toBeNull();
  });

  it("serves the strip: the owner's scope button, a refused colleague, a hospital rule as text, and the list each clinician may see", async () => {
    const root = emrRoot();
    const port = new WardsFake();
    let rt: EmrRuntime | null = null;
    const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater((s) => script(s) as unknown as C[]), taskStateOf: (id) => rt?.stateOf(id) ?? null });
    const s = await startEmrServe({ storeRoot: root, port, client, listenPort: 0, ears: "off", runtime: { holdMs: 1500, proofRetryMs: 1 } });
    rt = s.runtime;
    const post = (path: string, body: unknown) => fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      await post("/tasks/say", { owner: DOC, admissionId: PATIENTS.p1.admission, text: "Add four hourly observations to the care plan.", via: "gate" });
      const r = await post("/tasks/say", { owner: DOC, admissionId: PATIENTS.p1.admission, text: "No, make that two hourly.", via: "gate" });
      const { task_id } = (await r.json()) as { task_id: string };
      await s.runtime.settled();
      const id = s.preferences!.all()[0]!.pref_id;
      expect((await post(`/tasks/${task_id}/preferences/${id}/scope`, { owner: OTHER, scope: "everyone" })).status).toBe(403);
      expect((await post(`/tasks/${task_id}/preferences/${id}/scope`, { owner: DOC, scope: "ward" })).status).toBe(200);
      expect(s.preferences!.get(id)).toMatchObject({ state: "active", scope: { kind: "ward", ward: "Children's Ward" }, decided: { via: "strip" } });
      expect((await post("/preferences/external", { owner: "wm-1", text: "be careful", scope: "everyone" })).status).toBe(422);
      expect((await post("/preferences/external", { owner: "wm-1", text: "Hospital rule: notes as ward round notes", scope: "everyone" })).status).toBe(201);
      const theirs = (await (await fetch(`${s.url}/preferences?owner=${OTHER}`)).json()) as { text: string; source: string }[];
      expect(theirs.map((p) => p.text).sort()).toEqual(["notes as ward round notes", "observation items two hourly (q2h)"]);
      expect(theirs.find((p) => p.text.startsWith("observation"))?.source).toMatch(/^a colleague's correction/);
    } finally {
      await s.close();
      client.close();
    }
  });
});
