import { canonical } from "@hey-pisgah/contracts";
import type { ExpectedAction, Talk } from "./talk.js";

const WRITTEN = new Set(["acknowledged", "completed"]);
// One finalised utterance as the agent heard it, mapped to the talk's key by the chunks that made it.
export type RunLine = { line_id: string; key_id: string | null; text: string; classes: string[]; seqs: number[]; ended_at: string | null };
export type RunAction = { action_id: string; line_id: string; kind: string; args: Record<string, unknown>; state: string; corrects_action_id: string | null; written_at: string | null };
export type RunChunk = { seq: number; key_ids: string[]; final: boolean; why: string };
// Everything one run of the talk produced, read back from serve; the scorer needs nothing else.
export type AmbientRun = {
  mode: "live" | "replay" | "mock"; talk_id: string; gate_hash: string | null; started_at: string; finished_at: string;
  lines: RunLine[]; actions: RunAction[]; questions: { line_id: string; text: string }[]; refusals: { line_id: string; kind: string | null; asked_for: string }[];
  chunks: RunChunk[]; calls: number; cost_usd: number; asr_cost_usd: number;
};

const sameValue = (want: unknown, got: unknown) => (typeof want === "number" ? Number(got) === want : String(got).replace(/\s+/g, "") === String(want).replace(/\s+/g, ""));

// Scores one run against the labelled key: actions by precision and recall, actions from talk that was not an instruction, questions against labelled ambiguities, latency from utterance end to the write.
export function scoreAmbient(talk: Talk, run: AmbientRun, opts: { replay_same?: boolean | null; now?: () => Date } = {}) {
  const keyOf = new Map(talk.utterances.map((u) => [u.id, u]));
  const lineKey = new Map(run.lines.map((l) => [l.line_id, l.key_id]));
  const actionKey = new Map(run.actions.map((a) => [a.action_id, lineKey.get(a.line_id) ?? null]));
  const taken = run.actions.filter((a) => WRITTEN.has(a.state));
  const expected = talk.utterances.flatMap((u) => u.key.actions.map((e, i) => ({ key_id: u.id, i, e })));
  const matches = (e: { key_id: string; e: ExpectedAction }, a: RunAction) =>
    actionKey.get(a.action_id) === e.key_id && a.kind === e.e.kind &&
    Object.entries(e.e.values).every(([k, v]) => sameValue(v, a.args[k])) &&
    (e.e.corrects === "any" || (e.e.corrects === null ? a.corrects_action_id === null : a.corrects_action_id !== null && actionKey.get(a.corrects_action_id) === e.e.corrects));
  const used = new Set<string>();
  const pairs: { key_id: string; action_id: string }[] = [];
  for (const e of expected) {
    const hit = taken.find((a) => !used.has(a.action_id) && matches(e, a));
    if (hit) { used.add(hit.action_id); pairs.push({ key_id: e.key_id, action_id: hit.action_id }); }
  }
  const unmatched = taken.filter((a) => !used.has(a.action_id));
  const forTalk = (a: RunAction) => { const k = keyOf.get(actionKey.get(a.action_id) ?? ""); return k ? k.key.classes : []; };
  const notInstruction = (cs: readonly string[]) => !cs.includes("instruction") && !cs.includes("correction");
  const falseFromTalk = unmatched.filter((a) => notInstruction(forTalk(a)));
  const fromAsideOrOption = falseFromTalk.filter((a) => forTalk(a).length > 0 && forTalk(a).every((c) => c === "aside" || c === "option"));
  const qKey = (q: { line_id: string }) => keyOf.get(lineKey.get(q.line_id) ?? "");
  const tied = run.questions.filter((q) => qKey(q)?.key.ambiguity === true);
  const ambiguities = talk.utterances.filter((u) => u.key.ambiguity);
  const refusalsExpected = talk.utterances.filter((u) => u.key.refusal);
  const ended = new Map(run.lines.map((l) => [l.line_id, l.ended_at]));
  const latencies = pairs.map((p) => run.actions.find((a) => a.action_id === p.action_id)!).flatMap((a) => {
    const end = ended.get(a.line_id);
    return end && a.written_at ? [Date.parse(a.written_at) - Date.parse(end)] : [];
  }).sort((x, y) => x - y);
  const finalOf = new Map(run.chunks.map((c) => [c.seq, c.final]));
  const partialsActed = taken.filter((a) => { const l = run.lines.find((x) => x.line_id === a.line_id); return !l || finalOf.get(l.seqs.at(-1) ?? -1) === false; }).length;
  const utterances = talk.utterances.map((u) => {
    const lines = run.lines.filter((l) => l.key_id === u.id);
    const ids = new Set(lines.map((l) => l.line_id));
    const got = [...new Set(lines.flatMap((l) => l.classes))];
    return {
      id: u.id, said: u.say, heard: lines.map((l) => l.text), expected_classes: u.key.classes, classes: got,
      classes_agree: got.length === u.key.classes.length && u.key.classes.every((c) => got.includes(c)),
      expected_actions: u.key.actions.length, actions: run.actions.filter((a) => ids.has(a.line_id)).map((a) => ({ kind: a.kind, args: a.args, state: a.state, corrects: a.corrects_action_id ? actionKey.get(a.corrects_action_id) ?? "unknown" : null, matched: used.has(a.action_id) })),
      questions: run.questions.filter((q) => ids.has(q.line_id)).map((q) => q.text), ambiguity: u.key.ambiguity,
      refusals: run.refusals.filter((r) => ids.has(r.line_id)).map((r) => r.asked_for), refusal_expected: u.key.refusal
    };
  });
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const pct = (p: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]! : null);
  return {
    measured_at: (opts.now?.() ?? new Date()).toISOString(), measured: true, mode: run.mode, talk_id: talk.talk_id, gate_hash: run.gate_hash,
    precision: taken.length ? r6(pairs.length / taken.length) : null, recall: expected.length ? r6(pairs.length / expected.length) : null,
    actions_expected: expected.length, actions_taken: taken.length, actions_matched: pairs.length, actions_missed: expected.length - pairs.length,
    wrong_actions: unmatched.length - falseFromTalk.length, false_actions_from_talk: falseFromTalk.length, actions_from_asides_or_options: fromAsideOrOption.length,
    questions_asked: run.questions.length, questions_tied: tied.length, questions_untied: run.questions.length - tied.length,
    ambiguities: ambiguities.length, ambiguities_asked: ambiguities.filter((u) => utterances.find((x) => x.id === u.id)!.questions.length > 0).length,
    refusals_expected: refusalsExpected.length, refusals_seen: refusalsExpected.filter((u) => utterances.find((x) => x.id === u.id)!.refusals.length > 0).length, refused_kinds: run.refusals.length,
    partials_acted: partialsActed, held_chunks: run.chunks.filter((c) => !c.final).length, lines: run.lines.length,
    lines_unmapped: run.lines.filter((l) => l.key_id === null).length, class_agreement: utterances.filter((u) => u.classes_agree).length,
    latency_ms: { n: latencies.length, p50: pct(0.5), max: latencies.at(-1) ?? null }, latency_p50_ms: pct(0.5),
    replay_same: opts.replay_same ?? null, calls: run.calls, cost_usd: r6(run.cost_usd), asr_cost_usd: r6(run.asr_cost_usd),
    utterances
  };
}
export type AmbientScore = ReturnType<typeof scoreAmbient>;

// What must match when the same recording is played again: what was heard, how each line was classed, what was written, asked and refused.
export function runSignature(run: AmbientRun): string {
  const key = new Map(run.lines.map((l) => [l.line_id, l.key_id]));
  const aKey = new Map(run.actions.map((a) => [a.action_id, key.get(a.line_id)]));
  return canonical({
    lines: run.lines.map((l) => ({ key: l.key_id, text: l.text, classes: l.classes })),
    actions: run.actions.filter((a) => WRITTEN.has(a.state)).map((a) => ({ key: key.get(a.line_id) ?? null, kind: a.kind, args: Object.fromEntries(Object.entries(a.args).filter(([k]) => k !== "corrects_record_id")), corrects: a.corrects_action_id ? aKey.get(a.corrects_action_id) ?? null : null })),
    questions: run.questions.map((q) => key.get(q.line_id) ?? null), refusals: run.refusals.map((r) => key.get(r.line_id) ?? null)
  });
}
export const sameRun = (a: AmbientRun, b: AmbientRun): boolean => runSignature(a) === runSignature(b);
