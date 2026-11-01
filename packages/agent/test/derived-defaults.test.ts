import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import { listStreams, readStream } from "@hey-pisgah/store";
import { EmrRuntime, projectEmr } from "../src/emr/runtime.js";
import { CADENCE_WORDS, cadenceSaid } from "../src/emr/work.js";
import { PreferenceMemory, deriveDefaults, pastEntries, type DerivedReading } from "../src/emr/preferences.js";
import type { EmrCommit, EmrContext, EmrPort, EmrProof, EmrTarget, Provenance, SayableNames, WorkArgs } from "../src/emr/port.js";
import { CLERK_KINDS, ins, type W } from "./clerking-helpers.js";
import { emrRoot, gater, type C } from "./emr-helpers.js";

const DR_A = "doc-a", DR_B = "doc-b", DR_EMPTY = "doc-new";
const admission = (i: number) => `cccccccc-1111-4222-8333-${String(i).padStart(12, "0")}`;
const patient = (i: number) => `aaaaaaaa-1111-4222-8333-${String(i).padStart(12, "0")}`;

// A ward with as many synthetic admissions as the test asks for, writing every kind it is given.
class SyntheticWard implements EmrPort {
  readonly writeKinds = ["record_observation"] as const;
  readonly writes: { kind: string; args: WorkArgs; key: string; prov: Provenance }[] = [];
  kindsFor(): readonly string[] { return CLERK_KINDS; }
  refusedCount(): number { return 0; }
  names(): SayableNames { return { page_targets: {}, clinics: {}, wards: { male: ["male ward"] } }; }
  async resolve(target: EmrTarget): Promise<EmrContext> {
    const i = Number(String(target.admission_id).slice(-12));
    return { admission_id: admission(i), patient_id: patient(i), visit_id: null, label: "Synthetic patient", facts: { ward: "Male Ward", bed: "1" }, keywords: [] };
  }
  async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    if (!this.writes.some((w) => w.key === key)) this.writes.push({ kind, args, key, prov });
    return { ok: true, record_id: `${kind}-${this.writes.length}`, record_version: 1, event_ids: [`${kind}:${this.writes.length}`], replayed: false };
  }
  async prove(_k: string, _a: WorkArgs, written: { record_id: string; record_version: number; event_ids: string[] }): Promise<EmrProof | null> {
    return { ...written, record_hash: "0".repeat(64), verified_at: new Date().toISOString(), read: "fake" };
  }
}

// The mock gate reads only what the line says: a note type or a cadence it does not hear stays empty.
const NOTE_SAID: Record<string, RegExp> = { ward_round: /\bward round\b/i, progress: /\bprogress\b/i };
const script = (said: string): W[] => {
  if (/\bnote\b/i.test(said)) return [ins("record_note", { note_type: Object.keys(NOTE_SAID).find((k) => NOTE_SAID[k]!.test(said)) ?? null, text: "reviewed and settled" })];
  const cadence = Object.keys(CADENCE_WORDS).find((c) => cadenceSaid(c, said)) ?? null;
  if (/observations/i.test(said)) return [ins("add_care_plan_item", { title: "observations", item_kind: "observation", cadence })];
  if (/turns/i.test(said)) return [ins("add_care_plan_item", { title: "turns", item_kind: "nursing", cadence })];
  return [];
};

function boot(root = emrRoot()) {
  const port = new SyntheticWard();
  const prefs = new PreferenceMemory(root);
  let rt: EmrRuntime | null = null;
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater((s) => script(s) as unknown as C[]), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1, preferences: prefs });
  rt.start();
  const say = async (owner: string, i: number, text: string) => {
    const r = await rt!.say({ owner, target: { admission_id: admission(i) }, text, via: "gate" });
    await rt!.settled();
    return r;
  };
  const tasks = () => listStreams(root, "emr").map((sid) => projectEmr(readStream(root, sid)));
  const close = async () => { await rt!.stop(); client.close(); prefs.close(); };
  return { rt, port, prefs, root, say, tasks, close };
}

describe("derived defaults: read from the owner's own past notes, by rule", () => {
  it("counts only values the owner said, cites each note, skips filled and fallback values, and needs a clear majority", async () => {
    const a = boot();
    for (let i = 1; i <= 6; i++) await a.say(DR_A, i, "Write a ward round note: reviewed.");
    await a.say(DR_A, 7, "Write a progress note: reviewed.");
    // Three notes with no type said: the runtime's own fallback is never evidence of the clinician's habit.
    for (let i = 8; i <= 10; i++) await a.say(DR_A, i, "Write a note: reviewed.");
    for (let i = 11; i <= 13; i++) await a.say(DR_B, i, "Write a progress note: reviewed.");
    const entries = pastEntries(a.tasks(), DR_A);
    expect(entries.map((e) => e.value).sort()).toEqual(["progress", "ward_round", "ward_round", "ward_round", "ward_round", "ward_round", "ward_round"]);
    const [d, ...rest] = deriveDefaults(entries);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ field: "note_type", item_kind: null, value: "ward_round", k: 6, n: 7 });
    expect(d!.cites).toHaveLength(6);
    expect(d!.quote).toBe("ward round on 6 of your last 7 notes whose type you said");
    // Fewer than five said values, or no clear majority, derives nothing.
    expect(deriveDefaults(pastEntries(a.tasks(), DR_B))).toEqual([]);
    expect(deriveDefaults([...entries.slice(0, 3), ...entries.filter((e) => e.value === "progress"), ...entries.filter((e) => e.value === "progress"), { ...entries[0]!, value: "progress" }])).toEqual([]);
    await a.close();
  });

  it("offers a derived default as a candidate with its source, fills nothing before the owner's one word, and then fills only an unsaid value", async () => {
    const a = boot();
    for (let i = 1; i <= 6; i++) await a.say(DR_A, i, "Write a ward round note: reviewed.");
    const made = a.prefs.derived(DR_A, deriveDefaults(pastEntries(a.tasks(), DR_A)));
    expect(made).toMatchObject([{ state: "candidate", scope: null, value: "ward_round", source: { kind: "derived", owner: DR_A } }]);
    expect(made[0]!.source.cites).toHaveLength(6);
    // A second derivation over the same notes keeps the one candidate.
    expect(a.prefs.derived(DR_A, deriveDefaults(pastEntries(a.tasks(), DR_A)))).toEqual([]);

    const first = await a.say(DR_A, 20, "Write a note: reviewed.");
    const v1 = a.rt.view(first.task_id)!;
    expect(a.port.writes.at(-1)!.args["note_type"]).toBe("progress");
    expect(v1.preferences.applied).toEqual([]);
    expect(v1.preferences.withheld).toMatchObject([{ value: "ward_round", reason: expect.stringMatching(/no scope was chosen/) }]);
    expect(v1.questions.at(-1)).toMatchObject({ text: expect.stringMatching(/^From your own records: ward round on 6 of your last 6 notes whose type you said\. Keep notes as ward round notes/), answers: ["patient", "me", "ward", "everyone", "no"] });

    await a.say(DR_A, 20, "me");
    expect(a.prefs.get(made[0]!.pref_id)).toMatchObject({ state: "active", scope: { kind: "me" }, decided: { by: DR_A, via: "word" } });
    const later = await a.say(DR_A, 21, "Write a note: reviewed.");
    expect(a.port.writes.at(-1)!.args["note_type"]).toBe("ward_round");
    expect(a.rt.view(later.task_id)!.preferences.applied).toMatchObject([{ value: "ward_round", scope: "your patients", source: "your own records (ward round on 6 of your last 6 notes whose type you said)" }]);
    // A type said aloud beats the derived default, and a colleague's agent never uses it.
    await a.say(DR_A, 22, "Write a progress note: reviewed.");
    expect(a.port.writes.at(-1)!.args["note_type"]).toBe("progress");
    const theirs = await a.say(DR_B, 23, "Write a note: reviewed.");
    expect(a.port.writes.at(-1)!.args["note_type"]).toBe("progress");
    expect(a.rt.view(theirs.task_id)!.preferences).toEqual({ applied: [], withheld: [], candidates: [] });
    await a.close();
  });
});

// A seeded generator, so the held-out encounters are the same in every arm.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type Habit = Record<"note" | "observation" | "nursing", [string, string]>;
// Each synthetic clinician's planted habit: the usual value 85% of the time, else the other one.
const HABITS: Record<string, Habit> = {
  [DR_A]: { note: ["ward_round", "progress"], observation: ["q2h", "q4h"], nursing: ["q4h", "q6h"] },
  [DR_B]: { note: ["progress", "ward_round"], observation: ["q4h", "q6h"], nursing: ["q2h", "q4h"] }
};
const CAD_SAY: Record<string, string> = { q2h: "two hourly", q4h: "four hourly", q6h: "six hourly" };
type Slot = { slot: "note" | "observation" | "nursing"; value: string; said: boolean; text: string };
function encounters(owner: string, n: number, seed: number): Slot[][] {
  const r = rng(seed);
  const pick = (h: [string, string]) => (r() < 0.85 ? h[0] : h[1]);
  return Array.from({ length: n }, () => (["note", "observation", "nursing"] as const).map((slot) => {
    const value = pick(HABITS[owner]![slot]);
    const said = r() < 0.5;
    const what = slot === "observation" ? "observations" : "turns";
    const text = slot === "note" ? (said ? `Write a ${value.replace("_", " ")} note: reviewed and settled.` : "Write a note: reviewed and settled.") : said ? `Add ${CAD_SAY[value]} ${what} to the care plan.` : `Add ${what} to the care plan.`;
    return { slot, value, said, text };
  }));
}

type Arm = "before" | "derived_no_scope" | "after" | "shuffled_owner" | "empty";
const TRAIN = 12, HELD = 30;
// One arm: a history, a derivation, a scope word or none, then the same held-out encounters for Dr A, scored on what was written.
async function runArm(arm: Arm) {
  const a = boot();
  let base = 0;
  const play = async (owner: string, list: Slot[][]) => { for (const enc of list) { base += 1; for (const s of enc) await a.say(owner, base, s.text); } };
  if (arm !== "empty") await play(DR_A, encounters(DR_A, TRAIN, 11));
  await play(DR_B, encounters(DR_B, TRAIN, 22));
  const from = arm === "shuffled_owner" ? DR_B : arm === "empty" ? DR_EMPTY : DR_A;
  const readings: DerivedReading[] = arm === "before" ? [] : deriveDefaults(pastEntries(a.tasks(), from));
  const made = a.prefs.derived(DR_A, readings);
  // The offer encounter is not scored: the owner's one word, typed by the harness, settles each offer as it is asked.
  if (arm === "after" || arm === "shuffled_owner") {
    base += 1;
    for (const line of ["Write a note: reviewed.", "Add four hourly observations to the care plan.", "Add four hourly turns to the care plan."]) {
      const r = await a.say(DR_A, base, line);
      if (a.rt.view(r.task_id)!.questions.some((q) => q.text.startsWith("From your own records"))) await a.say(DR_A, base, "me");
    }
  }
  const held = encounters(DR_A, HELD, 33);
  const score = { unsaid_slots: 0, matched: 0, mismatched: 0, asked: 0, said_slots: 0, said_overridden: 0 };
  const perSlot: ("matched" | "mismatched" | "asked")[] = [];
  for (const enc of held) {
    base += 1;
    const i = base;
    for (const s of enc) await a.say(DR_A, i, s.text);
    const mine = a.port.writes.filter((w) => w.args["admission_id"] === admission(i));
    for (const s of enc) {
      const w = s.slot === "note" ? mine.find((x) => x.kind === "record_note") : mine.find((x) => x.kind === "add_care_plan_item" && x.args["item_kind"] === s.slot);
      const got = w ? String(w.args[s.slot === "note" ? "note_type" : "cadence"]) : null;
      if (s.said) { score.said_slots += 1; if (got !== s.value) score.said_overridden += 1; continue; }
      score.unsaid_slots += 1;
      const out = got === null ? "asked" : got === s.value ? "matched" : "mismatched";
      score[out] += 1;
      perSlot.push(out);
    }
  }
  const prefs = a.prefs.all();
  const uses = a.tasks().filter((t) => t.owner === DR_A).reduce((n, t) => n + t.prefs.applied.length, 0);
  const result = { ...score, derived: made.map((p) => ({ field: p.field, item_kind: p.item_kind, value: p.value, cites: p.source.cites?.length ?? 0 })), candidates: made.length, candidates_scoped: prefs.filter((p) => p.owner === DR_A && p.state === "active").length, cites: made.reduce((n, p) => n + (p.source.cites?.length ?? 0), 0), preference_uses: uses };
  await a.close();
  return { result, perSlot };
}

describe("derived defaults: offline before and after on held-out synthetic encounters", () => {
  it("fills more unsaid values as the owner would, with no gain from another clinician's records and none from an empty history", async () => {
    const arms = {} as Record<Arm, Awaited<ReturnType<typeof runArm>>>;
    for (const arm of ["before", "derived_no_scope", "after", "shuffled_owner", "empty"] as const) arms[arm] = await runArm(arm);
    const r = Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, v.result])) as Record<Arm, (typeof arms)["before"]["result"]>;
    // A wrong value in the record is worse than a question, and a question is worse than the right value with none.
    const RANK = { mismatched: 0, asked: 1, matched: 2 } as const;
    const paired = (arm: Arm) => arms[arm].perSlot.reduce((m, out, i) => {
      const d = RANK[out] - RANK[arms.before.perSlot[i]!];
      return { better: m.better + (d > 0 ? 1 : 0), worse: m.worse + (d < 0 ? 1 : 0) };
    }, { better: 0, worse: 0 });
    const net = (x: { matched: number; mismatched: number }) => x.matched - x.mismatched;
    const result = {
      measured_at: new Date().toISOString(), measured: true, source: "synthetic_offline", set: "synthetic", live_calls: 0,
      method: "the engine's own runtime with a scripted gate and a fake ward; habits planted by a seeded generator; scope words typed by the harness",
      clinicians: 2, training_encounters_per_clinician: TRAIN, heldout_encounters: HELD, n: HELD, habit_share_planted: 0.85, said_share: 0.5,
      arms: r, paired_vs_before: { after: paired("after"), shuffled_owner: paired("shuffled_owner"), empty: paired("empty") },
      gain_net: net(r.after) - net(r.before), shuffled_gain_net: net(r.shuffled_owner) - net(r.before),
      gain_matched: r.after.matched - r.before.matched, shuffled_gain_matched: r.shuffled_owner.matched - r.before.matched, wrong_fills_added: r.after.mismatched - r.before.mismatched,
      empty_equals_before: JSON.stringify(r.empty) === JSON.stringify(r.before),
      unscoped_applied: r.derived_no_scope.preference_uses, said_overridden: Object.values(r).reduce((n, x) => n + x.said_overridden, 0),
      unsaid_slots: r.before.unsaid_slots, before_matched: r.before.matched, after_matched: r.after.matched, before_wrong: r.before.mismatched, after_wrong: r.after.mismatched, shuffled_wrong: r.shuffled_owner.mismatched,
      primary_metric: "net fills: values written as the clinician would minus values written wrong; chosen after the first run, where right fills alone hid the shuffled control's wrong fills"
    };
    const out = process.env["HEY_PISGAH_DEFAULTS_RESULT"];
    if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`); }
    expect(r.after.candidates).toBeGreaterThanOrEqual(1);
    expect(r.after.cites).toBeGreaterThan(0);
    expect(result.gain_net).toBeGreaterThan(0);
    expect(result.wrong_fills_added).toBeLessThanOrEqual(0);
    expect(result.shuffled_gain_net).toBeLessThanOrEqual(0);
    expect(result.empty_equals_before).toBe(true);
    expect(result.unscoped_applied).toBe(0);
    expect(JSON.stringify({ ...r.derived_no_scope, derived: [], candidates: 0, cites: 0 })).toBe(JSON.stringify({ ...r.before, candidates: 0, cites: 0 }));
    expect(result.said_overridden).toBe(0);
  }, 240_000);
});
