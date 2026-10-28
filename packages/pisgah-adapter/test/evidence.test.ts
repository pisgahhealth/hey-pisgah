import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OBSERVATION_KIND, SPEECH_CLASSES, WORK_KINDS, caseFacts } from "@hey-pisgah/agent";
import { FACT_VALUES, SimEvent, checkTwoClock } from "@hey-pisgah/contracts";
import { loadJourney } from "@hey-pisgah/evaluator";
import { exportJourneyRun, type ObservedFile } from "../src/evidence.js";
import type { VersionsSpec } from "../src/profile.js";

const OBSERVED = new URL("../../../evaluation/results/observed-cases.json", import.meta.url).pathname;
const SPEC: VersionsSpec = {
  ward_id: "A", requirement_version: "r1", facts: { payer_type: "self_pay", expected_disposition: "home", has_take_home_order: "false" }, facts_source: "test",
  steps: { st05: { fact: "stay.stage", equals: "signed" }, st13: { fact: "stay.stage", equals: "settled" } }, events: {}, documents: {}
};
const KINDS = new Set(["person.acted", "task.opened", "line.classed", "instruction.refused", "record.written", "record.proved", "record.unverified", "report.prepared", "write.refused", "write.failed", "action.cancelled", "question.asked", "question.answered", "offer.made", "version.read", "version.check_failed", "task.paused", "task.resumed", "step.observed"]);
const ROLES = ["doctor", "nurse", "accounts_clerk", "reception", "staff"];
const PERSON_ACTS = new Set(loadJourney().steps.flatMap((s) => ("person" in s && typeof s.person === "string" ? [s.person] : [])));
const STEP_IDS = new Set(loadJourney().steps.map((s) => s.id));
const WORDS = new Set<string>([
  ...KINDS, ...ROLES, "agent", ...ROLES.flatMap((r) => [`${r}_1`, `${r}_1_agent`]), ...WORK_KINDS, OBSERVATION_KIND, "unknown", ...SPEECH_CLASSES, ...PERSON_ACTS, ...STEP_IDS,
  "server", "two_clock", "emr_row", "emr_audit", "agent_ack", "emr_journey", "mock", "live", "A", "B", "C", "r1", "r2",
  ...Object.values(FACT_VALUES).flatMap((v) => (Array.isArray(v) ? v : []))
]);
const ID = /^(c|ev|rec)-[a-z0-9]{8}$/;
const STEP = /^st\d{2}[a-z]?$/;

// Every string in a case must be a case-local id, a known kind, role or value; anything else would be free text or a hospital id.
function strangers(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") { if (!ID.test(v) && !STEP.test(v) && !WORDS.has(v)) out.push(v); }
  else if (Array.isArray(v)) for (const x of v) strangers(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strangers(x, out);
  return out;
}

const U = (n: number) => `${String(n).padStart(8, "0")}-1111-4222-8333-444444444444`;
const at = (s: number) => new Date(Date.parse("2026-10-28T10:00:00.000Z") + s * 1000).toISOString();
let seq = 0;
const env = (type: string, s: number, payload: Record<string, unknown>) => JSON.stringify({ record_type: type, wall_at: at(s), payload, seq: ++seq });

// A run folder with planted names, words and hospital ids in every field the export reads.
function plantedRun(): string {
  const dir = mkdtempSync(join(tmpdir(), "observed-"));
  mkdirSync(join(dir, "store", "emr"), { recursive: true });
  const doc = U(1), patient = U(2), visit = U(3), admission = U(4), note = U(5);
  const lines = [
    env("emr.task.opened", 0, { owner: doc, patient_id: patient, visit_id: visit, admission_id: "", task_id: "t-planted1", run_id: "run-planted1" }),
    env("utterance.heard", 1, { line_id: "u-planted1", spoken_at: at(1), text: "Planted Words: Mrs Plantedname has pain", source: "text" }),
    env("gate.decided", 3, { line_id: "u-planted1", clauses: [{ class: "instruction", kind: "record_note", text: "Planted Words", words: "Planted Words" }] }),
    env("action.proposed", 3, { action_id: "a-planted1", line_id: "u-planted1", kind: "record_note", args: { text: "Planted Words", admission_id: admission }, summary: "Planted summary" }),
    env("action.written", 8, { action_id: "a-planted1", written: { record_id: note, record_version: 1, event_ids: [`note:${note}`] } }),
    env("action.completed", 9, { action_id: "a-planted1", proof: { record_id: note, read: "Planted read" } }),
    env("gate.refused", 10, { line_id: "u-planted1", kind: null, asked_for: "Planted order", words: "Planted order words" }),
    env("watch.changed", 11, { facts: { "stay.stage": "signed", ward: "ZZ-TEST Planted Ward" }, changes: [{ fact: "stay.stage", from: null, to: "signed", label: "Planted label" }, { fact: "ward", from: null, to: "ZZ-TEST Planted Ward", label: "Ward" }] }),
    env("question.asked", 12, { line_id: "watch", question_id: "q-planted1", text: "Planted question about Mrs Plantedname" }),
    env("task.note", 13, { note_id: "n-planted1", text: "Planted note" }),
    env("action.proposed", 14, { action_id: "a-planted2", line_id: "u-planted1", kind: "send_pay_link", args: {}, summary: "Planted" }),
    env("action.written", 15, { action_id: "a-planted2", written: { record_id: "PAY-PLANTED1", record_version: 1, event_ids: [] } }),
    env("action.unverified", 16, { action_id: "a-planted2", reason: "Planted reason" })
  ];
  writeFileSync(join(dir, "store", "emr", "t-planted1.jsonl"), `${lines.join("\n")}\n`);
  writeFileSync(join(dir, "trace.json"), JSON.stringify({
    trace: { mode: "live", started_at: at(0), person: { p05: { ok: true, at: at(10) } }, owner_of: { doctor: doc } },
    records: { provenance: [{ evidence: "transcript:u-planted1", recorded_at: at(7), on_behalf_of: doc }], notes: [{ id: note, author: U(9), created_at: at(7.5) }], visit: [{ id: visit, triaged_at: at(2) }] }
  }));
  return dir;
}

describe("journey runs as observed evidence cases", () => {
  it("keeps no hospital id, name or word from a planted run, and every string is a case-local id, kind, role or value", () => {
    const dir = plantedRun();
    const c = exportJourneyRun(dir, SPEC, caseFacts(SPEC) as Record<string, string | string[]>);
    const text = JSON.stringify(c);
    for (const bad of ["Planted", "planted", "ZZ-TEST", "PAY-", "1111-4222", "u-", "t-planted", "a-planted", "q-planted", "stay.stage", "signed"]) expect(text.includes(bad), bad).toBe(false);
    expect(strangers({ ...c, observed: { ...c.observed } })).toEqual([]);
    expect(c.events.map((e) => e.kind)).toEqual(["task.opened", "line.classed", "record.written", "record.proved", "instruction.refused", "person.acted", "step.observed", "question.asked", "record.written", "record.unverified"]);
  });

  it("puts the spoken time on occurred_at and the EMR's write time on recorded_at", () => {
    const c = exportJourneyRun(plantedRun(), SPEC, caseFacts(SPEC) as Record<string, string | string[]>);
    const [note, pay] = c.events.filter((e) => e.kind === "record.written").map((e) => e.payload as Record<string, unknown>);
    expect(note).toMatchObject({ record_kind: "record_note", occurred_s: 1, recorded_s: 7.5, recorded_clock: "emr_row" });
    expect(pay).toMatchObject({ record_kind: "send_pay_link", occurred_s: 1, recorded_s: 15, recorded_clock: "agent_ack" });
    expect(c.events.find((e) => e.kind === "step.observed")!.payload).toMatchObject({ step_id: "st05" });
    expect(c.events.every((e) => checkTwoClock(e).ok)).toBe(true);
  });

  it("the committed export holds only case-local ids and known words, and every event keeps the two-clock rule", () => {
    const f = JSON.parse(readFileSync(OBSERVED, "utf8")) as ObservedFile;
    expect(f.cases.length).toBeGreaterThanOrEqual(6);
    const text = JSON.stringify(f.cases);
    expect(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(text)).toBe(false);
    for (const bad of ["ZZ-TEST", "PAY-", "\"u-", "\"t-", "\"a-", "\"q-"]) expect(text.includes(bad), bad).toBe(false);
    expect(strangers(f.cases)).toEqual([]);
    for (const c of f.cases) for (const e of c.events) { SimEvent.parse(e); expect(checkTwoClock(e).ok).toBe(true); }
  });
});
