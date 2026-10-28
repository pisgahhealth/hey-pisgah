import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLASSES, MOCK_GATE_FILE, loadTalk, runSignature, scoreAmbient, talkDenyHits, type AmbientRun } from "../src/index.js";

const talk = loadTalk();
const T = "2026-10-28T10:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T) + s * 1000).toISOString();
// A hand-built run: one line per utterance, then the given actions, questions and refusals.
const run = (over: Partial<AmbientRun> = {}): AmbientRun => ({
  mode: "mock", talk_id: talk.talk_id, gate_hash: null, started_at: T, finished_at: T,
  lines: talk.utterances.map((u, i) => ({ line_id: `l${i + 1}`, key_id: u.id, text: u.say, classes: [...u.key.classes], seqs: [i], ended_at: at(i * 8) })),
  actions: [
    { action_id: "a1", line_id: "l2", kind: "record_observation", args: { temp_c: "37.9", pulse: 96, resp_rate: 20 }, state: "completed", corrects_action_id: null, written_at: at(14) },
    { action_id: "a2", line_id: "l4", kind: "record_observation", args: { bp: "128/76" }, state: "completed", corrects_action_id: null, written_at: at(30) },
    { action_id: "a3", line_id: "l7", kind: "record_observation", args: { temp_c: "37.9", pulse: 104, resp_rate: 20, corrects_record_id: "r1" }, state: "completed", corrects_action_id: "a1", written_at: at(54) },
    { action_id: "a4", line_id: "l12", kind: "record_observation", args: { resp_rate: 22 }, state: "completed", corrects_action_id: null, written_at: at(95) }
  ],
  questions: [{ line_id: "l11", text: "18 or 22?" }], refusals: [{ line_id: "l9", kind: null, asked_for: "stop the IV fluids" }],
  chunks: talk.utterances.map((u, i) => ({ seq: i, key_ids: [u.id], final: true, why: "quiet_tail" })), calls: 16, cost_usd: 0.06, asr_cost_usd: 0.006,
  ...over
});

describe("the labelled talk", () => {
  it("covers every class, holds four instructions, one unclear line and one refusal, and says nothing denied", () => {
    expect(talkDenyHits(talk)).toEqual([]);
    const classes = new Set(talk.utterances.flatMap((u) => u.key.classes));
    for (const c of CLASSES) expect(classes.has(c), c).toBe(true);
    expect(talk.utterances.flatMap((u) => u.key.actions)).toHaveLength(4);
    expect(talk.utterances.filter((u) => u.key.ambiguity).map((u) => u.id)).toEqual(["u11"]);
    expect(talk.utterances.filter((u) => u.key.refusal).map((u) => u.id)).toEqual(["u09"]);
    expect(talk.utterances.filter((u) => u.key.classes.length > 1).map((u) => u.id)).toEqual(["u04"]);
    const words = talk.utterances.reduce((s, u) => s + u.say.split(" ").length, 0);
    expect(words).toBeGreaterThan(200);
    const mock = JSON.parse(readFileSync(MOCK_GATE_FILE, "utf8")).by_utterance as Record<string, { class: string }[]>;
    for (const u of talk.utterances) expect(mock[u.id]!.map((c) => c.class), u.id).toEqual(u.key.classes);
  });
});

describe("ambient scoring", () => {
  it("scores a run that matches the key as all green with latency from utterance end to write", () => {
    const s = scoreAmbient(talk, run());
    expect(s).toMatchObject({ precision: 1, recall: 1, actions_matched: 4, false_actions_from_talk: 0, questions_tied: 1, questions_untied: 0, ambiguities_asked: 1, refusals_seen: 1, class_agreement: 16 });
    expect(s.latency_ms).toEqual({ n: 4, p50: 6000, max: 7000 });
  });

  it("counts an action from an aside, a correction of the wrong action and a question on a clear line", () => {
    const r = run();
    r.actions.push({ action_id: "a5", line_id: "l3", kind: "record_observation", args: { pulse: 70 }, state: "completed", corrects_action_id: null, written_at: at(20) });
    r.actions[2]!.corrects_action_id = "a2";
    r.questions.push({ line_id: "l5", text: "Chart the wound?" });
    const s = scoreAmbient(talk, r);
    expect(s).toMatchObject({ actions_matched: 3, actions_missed: 1, wrong_actions: 1, false_actions_from_talk: 1, actions_from_asides_or_options: 1, questions_untied: 1 });
    expect(s.precision).toBe(0.6);
    expect(s.recall).toBe(0.75);
  });

  it("does not count a stopped or refused action as taken, and flags an action from a line that never finished", () => {
    const r = run();
    r.actions.push({ action_id: "a6", line_id: "l10", kind: "record_observation", args: { temp_c: "38.5" }, state: "cancelled", corrects_action_id: null, written_at: null });
    r.chunks[3]!.final = false;
    const s = scoreAmbient(talk, r);
    expect(s.actions_taken).toBe(4);
    expect(s.false_actions_from_talk).toBe(0);
    expect(s.partials_acted).toBe(1);
    r.lines[3]!.finished_by = "pause_after_cap";
    expect(scoreAmbient(talk, r).partials_acted).toBe(0);
    r.lines[3]!.finished_by = "held_for_join";
    expect(scoreAmbient(talk, r).partials_acted).toBe(1);
  });

  it("compares replays by what was heard, classed, written and asked, not by record ids or times", () => {
    const a = run();
    const b = run({ started_at: at(500) });
    b.actions = b.actions.map((x) => ({ ...x, written_at: at(999), args: x.args["corrects_record_id"] ? { ...x.args, corrects_record_id: "other" } : x.args }));
    expect(runSignature(a)).toBe(runSignature(b));
    b.lines[2]!.classes = ["instruction"];
    expect(runSignature(a)).not.toBe(runSignature(b));
  });
});
