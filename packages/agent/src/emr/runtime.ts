import { canonical, sha256, type TaskState } from "@hey-pisgah/contracts";
import { ModelError, type ModelClient } from "@hey-pisgah/model";
import { listStreams, openStream, type Stream } from "@hey-pisgah/store";
import type { Envelope } from "@hey-pisgah/contracts";
import { shortHash } from "../ids.js";
import { DEFAULT_INTENT_ROUTE, FALLBACK_INTENT_ROUTE, decideIntent, tempText, type Decide, type IntentRoute } from "./intent.js";
import { primaryClass } from "./classes.js";
import { GATE_SETTINGS, gateUtterance, isWide, type GateAction, type GateClause, type GateSettings, type SpeechClass, type WorkClause } from "./gate.js";
import { EmrId, OBSERVATION_KIND, ObservationArgs, type EmrContext, type EmrPort, type EmrProof, type EmrTarget, type InboxPage, type Provenance, type WorkArgs } from "./port.js";
import { READ_ONLY_KINDS, WORK_ARGS, cadenceSaid, dateSaid, summariseWork, wordSaid, type WorkKind } from "./work.js";
import { measuresIn, type Measure, type Rewrite } from "@hey-pisgah/voice";
import { answerChoice, compareReadings, disagreementQuestion, normValue, quotedQuestion, type Choice, type EarReading, type EarsCheck, type SecondEar } from "./ears.js";

export type EmrActionState = "proposed" | "sent" | "acknowledged" | "completed" | "refused" | "cancelled" | "failed";
export type EmrAction = {
  action_id: string; kind: string; args: WorkArgs; summary: string; line_id: string; corrects_action_id: string | null;
  state: EmrActionState; intent_key: string | null; written: { record_id: string; record_version: number; event_ids: string[]; replayed: boolean } | null;
  proof: EmrProof | null; reason: string | null;
  proposed_at: string; written_at: string | null; completed_at: string | null;
  // What a read-only kind found, and a draft held for the owner's review.
  report: string | null; draft: string | null;
  // Written and acknowledged, but no read the EMR offers can show it, so it is never marked completed.
  unverified: boolean;
  // Vitals heard from audio wait for the second ear to agree before the write.
  ears: boolean;
};
// Where an ambient line came from: its listening session, the chunks that made it, and when the speech ended.
export type AmbientMeta = { session_id: string; seqs: number[]; raw_text: string; ended_at: string; final_at: string; trailing_silence_ms: number; finished_by: string };
// kept is false while an ambient line's words live only in memory; they are stored only once an action or a question rests on them.
export type EmrLine = { id: string; text: string; at: string; source: "text" | "audio"; decided: boolean; ambient: AmbientMeta | null; classes: SpeechClass[]; kept: boolean; words: number };
export type EmrRefusal = { line_id: string; kind: string | null; asked_for: string; at: string };
// A question may carry a choice: the values a one-word answer can pick, and the action it completes.
export type QuestionChoice = Choice & { kind: string; base: Record<string, unknown>; corrects_action_id: string | null };
export type EmrQuestion = { question_id: string; text: string; line_id: string; answered_by: string | null; at: string; choice: QuestionChoice | null };
// One comparison of the two readings before a vitals write.
export type EarsRecord = { action_id: string; line_id: string; session_id: string | null; agree: boolean; measures: EarsCheck["measures"]; error: string | null };
// One change the agent saw in what it watches, and the page it found in its own inbox.
export type WatchChange = { fact: string; label: string; from: string | null; to: string | null; at: string };
export type EmrPause = { line_id: string | null; reason: string; at: string; pending: string[]; facts: Record<string, string | null> };
export type EmrTask = {
  task_id: string; owner: string; admission_id: string; patient_id: string | null; visit_id: string | null; run_id: string; goal: string;
  state: TaskState; reason: string | null; actions: Map<string, EmrAction>; order: string[];
  lines: EmrLine[]; questions: EmrQuestion[]; notes: { id: string; text: string; at: string }[]; refusals: EmrRefusal[];
  calls: number; usd: number; fallbacks: number; created_at: string; updated_at: string;
  watch: Record<string, string | null> | null; changes: WatchChange[]; offered: string[]; pages: InboxPage[];
  pause: EmrPause | null; digests: { line_id: string | null; text: string; at: string }[];
  ears: EarsRecord[];
};
// The strip's view of one task.
export type EmrTaskView = {
  task_id: string; goal: string; state: TaskState; reason: string | null; owner: string; admission_id: string; patient_id: string | null; visit_id: string | null;
  actions: {
    action_id: string; kind: string; state: EmrActionState; summary: string; reason: string | null; corrects_action_id: string | null;
    line_id: string; args: Record<string, unknown>; proposed_at: string; written_at: string | null;
    proof?: { record_id: string; record_version: number; event_ids: string[] };
    report?: string; draft?: string; unverified?: true;
  }[];
  questions: { question_id: string; text: string; answers?: string[] }[];
  transcript: { id: string; line_id: string; text: string; at: string; source: "text" | "audio"; decided: boolean; class: SpeechClass | null; classes: SpeechClass[]; kept: boolean; ambient?: AmbientMeta }[];
  // How many lines were heard and how many were kept as evidence; the rest were dropped after their class was decided.
  heard: { lines: number; kept: number; dropped: number };
  // How often the two readings agreed before a vitals write, for the task and per listening session.
  ears: { compared: number; agreed: number; rate: number | null; sessions: { session_id: string; compared: number; agreed: number; rate: number | null }[] };
  notes: { id: string; text: string; at: string }[];
  // Every question the agent asked, answered or not, and every instruction it would not take, for the strip and for scoring.
  asked: { question_id: string; text: string; line_id: string; answered_by: string | null; at: string }[];
  refusals: EmrRefusal[];
  // What the agent watches for its owner, what changed, pages it found, what it was waiting on when paused, and each resume digest.
  watching: Record<string, string | null> | null; changes: WatchChange[]; pages: InboxPage[];
  pause: EmrPause | null; digests: { line_id: string | null; text: string; at: string }[];
  calls: number; usd: number;
  updated_at: string;
};

export type EmrRuntimeOptions = {
  storeRoot: string; client: ModelClient; port: EmrPort;
  // How long a proposed action waits before its write, so a spoken correction or a Stop can reach it first.
  holdMs?: number;
  proofRetryMs?: number;
  routes?: { primary: IntentRoute; fallback: IntentRoute | null };
  // The speech gate for ambient lines; the default is the committed settings.
  gate?: GateSettings;
  // How often each open task reads what it watches; no model is called for it. Off when absent.
  watchMs?: number;
  // The second ear for vitals heard from audio; without it no agreement step runs.
  secondEar?: SecondEar;
  // Keeps every heard line's words in the store, for synthetic evaluation runs only; by default an ambient line's words are stored only when something rests on them.
  keepHeard?: boolean;
  // How long after a question a short spoken answer may settle it by rule.
  answerWindowMs?: number;
  wallNow?: () => Date;
  log?: (line: string) => void;
};

const OPEN_ACTION: ReadonlySet<EmrActionState> = new Set(["proposed", "sent", "acknowledged"]);
const CLOSED_TASK: ReadonlySet<TaskState> = new Set(["cancelled", "failed"]);
const Z = { recorded_at: 0, occurred_at: 0 };
type P = Record<string, unknown>;

// Folds one envelope into the task; the stream is the only source of task state.
export function applyEmr(t: EmrTask | null, e: Envelope): EmrTask | null {
  const x = e.payload as P;
  if (e.record_type === "emr.task.opened") {
    return {
      task_id: String(x["task_id"]), owner: String(x["owner"]), admission_id: String(x["admission_id"] ?? ""), patient_id: (x["patient_id"] as string | null) ?? null,
      visit_id: (x["visit_id"] as string | null | undefined) ?? null,
      run_id: String(x["run_id"]), goal: "", state: "running", reason: null, actions: new Map(), order: [], lines: [], questions: [], notes: [], refusals: [],
      calls: 0, usd: 0, fallbacks: 0, created_at: e.wall_at, updated_at: e.wall_at,
      watch: null, changes: [], offered: [], pages: [], pause: null, digests: [], ears: []
    };
  }
  if (!t) return null;
  t.updated_at = e.wall_at;
  const act = t.actions.get(String(x["action_id"]));
  switch (e.record_type) {
    case "utterance.heard": {
      const ambient = (x["ambient"] as AmbientMeta | undefined) ?? null;
      const text = String(x["text"]);
      t.lines.push({ id: String(x["line_id"]), text, at: String(x["spoken_at"]), source: x["source"] === "audio" ? "audio" : "text", decided: false, ambient, classes: [], kept: !x["withheld"], words: Number(x["words"] ?? text.split(/\s+/).filter(Boolean).length) });
      if (!t.goal && !x["withheld"]) t.goal = text.slice(0, 200);
      // A typed or pushed line answers the open question; an ambient line answers only when the gate hears it as meant for the agent.
      if (!ambient && x["via"] !== "gate") for (const q of t.questions) if (q.answered_by === null) q.answered_by = String(x["line_id"]);
      break;
    }
    case "gate.decided": {
      const l = t.lines.find((y) => y.id === x["line_id"]);
      if (l) { l.decided = true; l.classes = ((x["clauses"] as { class: SpeechClass }[] | undefined) ?? []).map((c) => c.class); }
      t.calls += Number(x["calls"] ?? 1); t.usd += Number(x["cost_usd"] ?? 0);
      if (x["fallback_reason"]) t.fallbacks += 1;
      break;
    }
    case "gate.refused": t.refusals.push({ line_id: String(x["line_id"]), kind: (x["kind"] as string | null) ?? null, asked_for: String(x["asked_for"]), at: e.wall_at }); break;
    case "question.answered": { const q = t.questions.find((y) => y.question_id === x["question_id"]); if (q && q.answered_by === null) q.answered_by = String(x["line_id"]); break; }
    case "intent.decided": {
      const l = t.lines.find((y) => y.id === x["line_id"]);
      if (l) l.decided = true;
      t.calls += Number(x["calls"] ?? 1); t.usd += Number(x["cost_usd"] ?? 0);
      if (x["fallback_reason"]) t.fallbacks += 1;
      break;
    }
    case "intent.failed": { const l = t.lines.find((y) => y.id === x["line_id"]); if (l) l.decided = true; break; }
    case "question.asked": t.questions.push({ question_id: String(x["question_id"]), text: String(x["text"]), line_id: String(x["line_id"]), answered_by: null, at: e.wall_at, choice: (x["choice"] as QuestionChoice | undefined) ?? null }); break;
    case "line.kept": {
      const l = t.lines.find((y) => y.id === x["line_id"]);
      if (l) { l.text = String(x["text"]); l.kept = true; if (l.ambient && typeof x["raw_text"] === "string") l.ambient.raw_text = x["raw_text"]; }
      if (!t.goal) t.goal = String(x["text"]).slice(0, 200);
      break;
    }
    case "line.ruled": { const l = t.lines.find((y) => y.id === x["line_id"]); if (l) { l.decided = true; l.classes = (x["classes"] as SpeechClass[] | undefined) ?? []; } break; }
    case "ears.compared":
      t.ears.push({ action_id: String(x["action_id"]), line_id: String(x["line_id"]), session_id: (x["session_id"] as string | null) ?? null, agree: !!x["agree"], measures: (x["measures"] as EarsCheck["measures"]) ?? [], error: (x["error"] as string | null) ?? null });
      t.calls += Number(x["calls"] ?? 0); t.usd += Number(x["cost_usd"] ?? 0);
      if (x["fallback_reason"]) t.fallbacks += 1;
      break;
    case "task.note": t.notes.push({ id: String(x["note_id"]), text: String(x["text"]), at: e.wall_at }); break;
    case "action.proposed":
      t.actions.set(String(x["action_id"]), {
        action_id: String(x["action_id"]), kind: String(x["kind"] ?? OBSERVATION_KIND), args: x["args"] as WorkArgs, summary: String(x["summary"]), line_id: String(x["line_id"]),
        corrects_action_id: (x["corrects_action_id"] as string | null) ?? null, state: "proposed", intent_key: null, written: null, proof: null, reason: null,
        proposed_at: e.wall_at, written_at: null, completed_at: null, report: null, draft: null, unverified: false, ears: !!x["ears"]
      });
      t.order.push(String(x["action_id"]));
      break;
    case "action.intent": if (act) { act.state = "sent"; act.intent_key = String(x["intent_key"]); } break;
    case "action.written": if (act) { act.state = "acknowledged"; act.written = x["written"] as EmrAction["written"]; act.written_at = e.wall_at; } break;
    case "action.completed": if (act) { act.state = "completed"; act.proof = x["proof"] as EmrProof; act.completed_at = e.wall_at; } break;
    case "action.cancelled": if (act) { act.state = "cancelled"; act.reason = String(x["reason"]); } break;
    case "action.refused": if (act) { act.state = "refused"; act.reason = String(x["reason"]); } break;
    case "action.failed": if (act) { act.state = "failed"; act.reason = String(x["reason"]); } break;
    case "action.unverified": if (act) { act.unverified = true; act.reason = String(x["reason"]); } break;
    case "action.reported": if (act) { act.report = (x["report"] as string | null) ?? null; act.draft = (x["draft"] as string | null) ?? null; } break;
    case "task.state_changed": t.state = x["to"] as TaskState; t.reason = (x["reason"] as string | null) ?? null; break;
    case "task.linked": t.admission_id = String(x["admission_id"]); break;
    case "line.handled": { const l = t.lines.find((y) => y.id === x["line_id"]); if (l) l.decided = true; break; }
    case "task.paused": t.pause = { line_id: (x["line_id"] as string | null) ?? null, reason: String(x["reason"]), at: e.wall_at, pending: (x["pending"] as string[]) ?? [], facts: (x["facts"] as Record<string, string | null>) ?? {} }; break;
    case "task.resumed": t.digests.push({ line_id: (x["line_id"] as string | null) ?? null, text: String(x["digest"]), at: e.wall_at }); t.pause = null; break;
    case "watch.changed": {
      t.watch = (x["facts"] as Record<string, string | null>) ?? {};
      for (const c of (x["changes"] as Omit<WatchChange, "at">[]) ?? []) t.changes.push({ ...c, at: e.wall_at });
      break;
    }
    case "offer.made": t.offered.push(String(x["offer"])); break;
    case "page.received": t.pages.push(x["page"] as InboxPage); break;
    default: break;
  }
  return t;
}

export function projectEmr(records: readonly Envelope[]): EmrTask {
  let t: EmrTask | null = null;
  for (const e of records) t = applyEmr(t, e);
  if (!t) throw new Error("emr task stream has no emr.task.opened");
  return t;
}

export function viewOf(t: EmrTask): EmrTaskView {
  return {
    task_id: t.task_id, goal: t.goal, state: t.state, reason: t.reason, owner: t.owner, admission_id: t.admission_id, patient_id: t.patient_id, visit_id: t.visit_id,
    actions: t.order.map((id) => t.actions.get(id)!).map((a) => ({
      action_id: a.action_id, kind: a.kind, state: a.state, summary: a.summary, reason: a.reason, corrects_action_id: a.corrects_action_id,
      line_id: a.line_id, args: Object.fromEntries(Object.entries(a.args).filter(([k]) => k !== "admission_id")), proposed_at: a.proposed_at, written_at: a.written_at,
      ...(a.proof ? { proof: { record_id: a.proof.record_id, record_version: a.proof.record_version, event_ids: a.proof.event_ids } } : {}),
      ...(a.report ? { report: a.report } : {}), ...(a.draft ? { draft: a.draft } : {}), ...(a.unverified ? { unverified: true as const } : {})
    })),
    questions: t.questions.filter((q) => q.answered_by === null).map((q) => ({ question_id: q.question_id, text: q.text, ...(q.choice ? { answers: answersOf(q.choice) } : {}) })),
    transcript: t.lines.map((l) => ({ id: l.id, line_id: l.id, text: l.kept ? l.text : "", at: l.at, source: l.source, decided: l.decided, class: primaryClass(l.classes) as SpeechClass | null, classes: l.classes, kept: l.kept, ...(l.ambient ? { ambient: l.kept ? l.ambient : { ...l.ambient, raw_text: "" } } : {}) })),
    heard: { lines: t.lines.length, kept: t.lines.filter((l) => l.kept).length, dropped: t.lines.filter((l) => !l.kept && l.decided).length },
    ears: earsSummary(t.ears),
    notes: t.notes,
    asked: t.questions.map((q) => ({ question_id: q.question_id, text: q.text, line_id: q.line_id, answered_by: q.answered_by, at: q.at })),
    refusals: t.refusals, watching: t.watch, changes: t.changes, pages: t.pages, pause: t.pause, digests: t.digests,
    calls: t.calls, usd: Math.round(t.usd * 1e6) / 1e6, updated_at: t.updated_at
  };
}

const rate = (n: number, of: number) => (of ? Math.round((n / of) * 1e4) / 1e4 : null);
// The agreement rate of the two readings, for the task and per listening session.
export function earsSummary(rs: readonly EarsRecord[]): EmrTaskView["ears"] {
  const by = new Map<string, EarsRecord[]>();
  for (const r of rs) if (r.session_id) by.set(r.session_id, [...(by.get(r.session_id) ?? []), r]);
  const agreed = rs.filter((r) => r.agree).length;
  return {
    compared: rs.length, agreed, rate: rate(agreed, rs.length),
    sessions: [...by.entries()].map(([session_id, xs]) => ({ session_id, compared: xs.length, agreed: xs.filter((r) => r.agree).length, rate: rate(xs.filter((r) => r.agree).length, xs.length) }))
  };
}
// The one-word answers a choice offers, as the strip may show them.
export const answersOf = (c: QuestionChoice): string[] => [...(c.yes ? ["yes"] : []), ...c.options.map((o) => Object.values(o).join(" ")), "no"];

const tokens = (t: string) => t.toLowerCase().replace(/[^a-z0-9.]+/g, " ").replace(/\.(?!\d)/g, " ").split(" ").filter(Boolean);
// True when at least four in five of the clause's words are in the line, so a copied earlier line does not pass.
export function fromLine(words: string, line: string): boolean {
  const w = tokens(words);
  if (!w.length) return false;
  const have = new Map<string, number>();
  for (const t of tokens(line)) have.set(t, (have.get(t) ?? 0) + 1);
  let hit = 0;
  for (const t of w) { const n = have.get(t) ?? 0; if (n > 0) { hit += 1; have.set(t, n - 1); } }
  return hit / w.length >= 0.8;
}

const VALUE_KEYS = ["temp_c", "pulse", "resp_rate", "bp", "remark", "spo2", "weight_kg", "priority"] as const;
// Only measurement kinds merge; two care-plan items or two pages in one line stay two actions.
const MERGEABLE: ReadonlySet<string> = new Set([OBSERVATION_KIND, "record_triage_vitals"]);
// Confident instructions of one kind in one line are one action: values merge, an empty "chart these" clause is absorbed, and a value given twice differently becomes a question.
export function mergeInstructions(clauses: readonly GateClause[], floor: number, kinds: readonly string[]): GateClause[] {
  const joinable = (c: GateClause) => c.class === "instruction" && !!c.kind && kinds.includes(c.kind) && MERGEABLE.has(c.kind) && (c.confidence ?? 0) >= floor;
  const out: GateClause[] = [];
  const merged = new Map<string, GateClause>();
  for (const c of clauses) {
    if (!joinable(c)) { out.push(c); continue; }
    const into = merged.get(c.kind!);
    if (!into) { const m = { ...c }; merged.set(c.kind!, m); out.push(m); continue; }
    for (const k of VALUE_KEYS) {
      const v = (c as Record<string, unknown>)[k];
      if (v === null || v === undefined) continue;
      const have = (into as Record<string, unknown>)[k];
      if (have !== null && have !== undefined && String(have) !== String(v)) {
        const i = out.indexOf(into);
        out[i] = { words: `${into.words} ${c.words}`, class: "unclear", question: `You gave two values for ${k.replace("_", " ")}: ${String(have)} and ${String(v)}. Which one should I chart?` };
        merged.delete(c.kind!);
        break;
      }
      (into as Record<string, unknown>)[k] = v;
    }
    if (merged.get(c.kind!) === into) into.words = `${into.words} ${c.words}`.slice(0, 400);
  }
  return out;
}

// One question per line: several unclear clauses of one line become one, with their words joined.
export function oneUnclear(clauses: readonly GateClause[]): GateClause[] {
  const unclear = clauses.filter((c) => c.class === "unclear");
  if (unclear.length < 2) return [...clauses];
  const first = unclear[0]!;
  const one: GateClause = { ...first, words: unclear.map((c) => c.words).join(" ").slice(0, 400), question: unclear.find((c) => c.question)?.question ?? null };
  return clauses.filter((c) => c.class !== "unclear" || c === first).map((c) => (c === first ? one : c));
}

// A plain line for the strip, built from the arguments rather than from model text.
export function summarise(a: ObservationArgs, correctsActionId: string | null): string {
  const parts = [
    a.temp_c !== undefined ? `temperature ${a.temp_c} C` : null, a.pulse !== undefined ? `pulse ${a.pulse}` : null,
    a.resp_rate !== undefined ? `respiratory rate ${a.resp_rate}` : null, a.bp !== undefined ? `blood pressure ${a.bp}` : null
  ].filter((x): x is string => x !== null);
  return `Record ${parts.join(", ")}${a.remark ? `, remark "${a.remark}"` : ""}${correctsActionId ? ` (corrects ${correctsActionId})` : ""}`;
}

export const emrIntentKey = (taskId: string, actionId: string, args: unknown) => sha256(canonical([taskId, actionId, args]));

// A spoken pause and a spoken return; both are handled by rule, with no model call.
export const SPOKEN_PAUSE = /^(?:(?:ok(?:ay)?|right|sorry|wait)[,.!]?\s+)?(?:stop|hold on|hang on|pause)\b(?:[\s,.!-]+(?:i'?ll|i will|we'?ll|let me)\s+come back to (?:this|that|it|her|him)(?:\s+later)?)?[\s.!]*$|\bi'?ll come back to (?:this|that|it)\b/i;
export const SPOKEN_RESUME = /\bwhere were we\b|\b(?:let'?s|we can) (?:carry on|continue|pick (?:this|it|that) (?:back )?up)\b|^(?:ok(?:ay)?,?\s+)?i'?m back\b/i;

type Live = { stream: Stream; task: EmrTask; queue: Promise<void> };
type AnyClause = GateClause & Partial<Omit<WorkClause, keyof GateClause>>;
export type SayInput = {
  // gate sends a typed line through the speech gate, as owners who hold more than observations always do.
  via?: "gate" | "intent";
  owner: string; target: EmrTarget; text: string; source?: "text" | "audio"; spoken_at?: string; audio?: { audio_ms: number; cost_usd: number; session_id: string };
  // Set for a finalised utterance from continuous listening; the speech gate decides it instead of the one-call intent.
  ambient?: AmbientMeta;
  // The patient context the caller already holds for this admission, so a listening line does not wait on another door read.
  context?: EmrContext;
  // The line's audio for the second ear, held in memory only until the line is decided.
  clip?: Uint8Array;
  // Words the vitals vocabulary pass rewrote; a guessed measure word must be confirmed by the second ear.
  rewrites?: readonly Rewrite[];
};
type EarsOutcome = { check: EarsCheck; reading: EarReading | null; error: string | null };

// The EMR agent runtime: one task per owner and admission, journaled intents before every write, proofs by fresh read, and no model call unless the task is running.
export class EmrRuntime {
  private readonly live = new Map<string, Live>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private lineCounter = 0;
  private stopped = false;
  private poller: NodeJS.Timeout | null = null;
  private polling = false;
  // Audio and guessed measures per line, and the second reading per action, in memory only.
  private readonly clips = new Map<string, { wav: Uint8Array; guessed: Set<Measure> }>();
  private readonly checks = new Map<string, Promise<EarsOutcome>>();

  constructor(private readonly o: EmrRuntimeOptions) {}

  private wall(): Date { return this.o.wallNow?.() ?? new Date(); }
  private log(s: string) { this.o.log?.(s); }
  get port(): EmrPort { return this.o.port; }
  // The kinds this owner's agent holds.
  kinds(owner: string): readonly string[] { return this.o.port.kindsFor?.(owner) ?? this.o.port.writeKinds; }

  stateOf = (id: string): TaskState | null => this.live.get(id)?.task.state ?? null;
  taskIds(): string[] { return [...this.live.keys()].sort(); }
  task(id: string): EmrTask | null { return this.live.get(id)?.task ?? null; }
  view(id: string): EmrTaskView | null { const l = this.live.get(id); return l ? viewOf(l.task) : null; }
  views(owner?: string): EmrTaskView[] {
    return [...this.live.values()].map((l) => l.task).filter((t) => owner === undefined || t.owner === owner)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0)).map(viewOf);
  }

  private append(l: Live, type: string, payload: unknown): void {
    applyEmr(l.task, l.stream.append(type, payload, Z));
  }
  private setState(l: Live, to: TaskState, reason: string | null): void {
    if (l.task.state === to) return;
    this.append(l, "task.state_changed", { from: l.task.state, to, reason });
  }

  // Rebuilds every task from its stream; a write that was journaled but not acknowledged is re-sent under the same key, so the door replays it.
  start(): void {
    for (const sid of listStreams(this.o.storeRoot, "emr")) {
      const id = sid.slice("emr/".length);
      if (this.live.has(id)) continue;
      const stream = openStream(this.o.storeRoot, sid, { writer: true });
      const l: Live = { stream, task: projectEmr(stream.records()), queue: Promise.resolve() };
      this.live.set(id, l);
      if (CLOSED_TASK.has(l.task.state)) continue;
      for (const aid of l.task.order) {
        const a = l.task.actions.get(aid)!;
        if (a.state === "sent" || (a.state === "acknowledged" && !a.unverified)) this.enqueue(l, () => this.execute(l, aid));
        else if (a.state === "proposed" && l.task.state === "running") this.hold(l, aid);
      }
      if (l.task.state === "running" && l.task.lines.some((x) => !x.decided)) {
        for (const x of l.task.lines.filter((y) => !y.decided)) this.append(l, "intent.failed", { line_id: x.id, reason: "restarted_before_decision" });
        this.settle(l, "restarted_before_decision");
      }
    }
    if (this.o.watchMs && this.o.watchMs > 0 && (this.o.port.watch || this.o.port.inbox) && !this.poller) {
      this.poller = setInterval(() => { void this.pollOnce(); }, this.o.watchMs);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await Promise.all([...this.live.values()].map((l) => l.queue));
    for (const l of this.live.values()) l.stream.close();
    this.live.clear();
  }

  // Resolves when every queue is drained and no hold timer is pending.
  async settled(timeoutMs = 60_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      await Promise.all([...this.live.values()].map((l) => l.queue));
      if (this.timers.size === 0) return;
      if (Date.now() > end) throw new Error("runtime did not settle in time");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private enqueue(l: Live, fn: () => Promise<void>): void {
    l.queue = l.queue.then(fn).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`emr task ${l.task.task_id} error: ${msg}`);
      try { this.setState(l, "failed", `runtime_error: ${msg.slice(0, 200)}`); } catch { /* the stream may be closed during shutdown */ }
    });
  }

  private nextLineId(owner: string, text: string): string {
    this.lineCounter += 1;
    return `u-${shortHash(owner, text, this.wall().toISOString(), this.lineCounter, process.pid)}`;
  }

  private openTask(owner: string, ctx: EmrContext): Live {
    const n = listStreams(this.o.storeRoot, "emr").length;
    const id = `t-${shortHash(owner, ctx.admission_id, n, this.wall().toISOString())}`;
    const stream = openStream(this.o.storeRoot, `emr/${id}`, { writer: true });
    stream.append("emr.task.opened", { task_id: id, owner, admission_id: ctx.admission_id, patient_id: ctx.patient_id, ...(ctx.visit_id ? { visit_id: ctx.visit_id } : {}), run_id: `run-${shortHash(id, "run")}` }, Z);
    const l: Live = { stream, task: projectEmr(stream.records()), queue: Promise.resolve() };
    this.live.set(id, l);
    return l;
  }

  // The owner's latest task for this admission, or for this patient before the admission existed, that is still open to more words.
  private taskFor(owner: string, ctx: EmrContext): Live | null {
    const open = [...this.live.values()].filter((l) => l.task.owner === owner && !CLOSED_TASK.has(l.task.state));
    const newest = (ls: Live[]) => ls.sort((a, b) => (a.task.created_at < b.task.created_at ? 1 : -1))[0] ?? null;
    const byAdmission = ctx.admission_id ? newest(open.filter((l) => l.task.admission_id === ctx.admission_id)) : null;
    if (byAdmission) return byAdmission;
    const byPatient = ctx.patient_id ? newest(open.filter((l) => l.task.patient_id === ctx.patient_id && (!l.task.admission_id || !ctx.admission_id))) : null;
    if (byPatient && ctx.admission_id && !byPatient.task.admission_id) this.append(byPatient, "task.linked", { admission_id: ctx.admission_id, by: "context" });
    return byPatient;
  }

  // Opens or returns the owner's task for a patient without any words, so the agent starts watching the record for them.
  async open(owner: string, target: EmrTarget): Promise<{ task_id: string }> {
    if (this.stopped) throw new Error("runtime stopped");
    const ctx = await this.o.port.resolve(target, { owner, evidence: "transcript:open", spoken_at: this.wall().toISOString() });
    const l = this.taskFor(owner, ctx) ?? this.openTask(owner, ctx);
    if (!l.task.goal) this.settle(l, "opened");
    return { task_id: l.task.task_id };
  }

  // One utterance opens or continues the owner's task for that patient; the decision runs on the task's serial queue.
  async say(s: SayInput, taskId?: string): Promise<{ task_id: string; line_id: string }> {
    if (this.stopped) throw new Error("runtime stopped");
    const text = s.text.trim().slice(0, 1000);
    if (!text) throw new Error("empty utterance");
    const lineId = this.nextLineId(s.owner, text);
    const spokenAt = s.spoken_at ?? this.wall().toISOString();
    const prov: Provenance = { owner: s.owner, evidence: `transcript:${lineId}`, spoken_at: spokenAt };
    let l: Live | null = null;
    let ctx: EmrContext;
    if (taskId) {
      l = this.live.get(taskId) ?? null;
      if (!l) throw new Error("unknown task");
      if (l.task.owner !== s.owner) throw new Error("the task belongs to another owner");
      ctx = await this.o.port.resolve(this.subjectOf(l.task), prov);
    } else {
      ctx = s.context && s.context.admission_id === s.target.admission_id ? s.context : await this.o.port.resolve(s.target, prov);
      l = this.taskFor(s.owner, ctx) ?? this.openTask(s.owner, ctx);
    }
    if (CLOSED_TASK.has(l.task.state)) throw new Error(`the task is ${l.task.state}`);
    const live = l;
    const viaGate = !!s.ambient || s.via === "gate" || (s.via !== "intent" && isWide(this.kinds(s.owner)));
    // Ambient words reach the store only once an action or a question rests on them; until then they live in memory.
    const withhold = !!s.ambient && !this.o.keepHeard;
    const stored = withhold ? { text: "", withheld: true, words: text.split(/\s+/).filter(Boolean).length, ambient: { ...s.ambient!, raw_text: "" } } : { text, ...(s.ambient ? { ambient: s.ambient } : {}) };
    this.append(live, "utterance.heard", { line_id: lineId, ...stored, source: s.source ?? "text", spoken_at: spokenAt, ...(s.audio ? { audio: s.audio } : {}), ...(viaGate && !s.ambient ? { via: "gate" } : {}) });
    if (withhold) { const ln = live.task.lines.find((x) => x.id === lineId)!; ln.text = text; ln.ambient = { ...s.ambient! }; }
    if (s.clip && this.o.secondEar) this.clips.set(lineId, { wav: s.clip, guessed: new Set((s.rewrites ?? []).filter((r) => r.guessed && r.measure).map((r) => r.measure!)) });
    // A spoken pause or return is handled by rule; while called away nothing heard is decided, so no model is called.
    if (SPOKEN_PAUSE.test(text) && !CLOSED_TASK.has(live.task.state) && live.task.state !== "paused") { this.pauseSpoken(live, lineId, ctx); this.afterLine(live, lineId, true); return { task_id: live.task.task_id, line_id: lineId }; }
    if (live.task.state === "paused" && live.task.reason === "called_away") {
      if (SPOKEN_RESUME.test(text)) this.enqueue(live, async () => { await this.resume(live, lineId, prov); this.afterLine(live, lineId, true); });
      else { this.append(live, "line.handled", { line_id: lineId, as: "heard_while_paused" }); this.afterLine(live, lineId, false); }
      return { task_id: live.task.task_id, line_id: lineId };
    }
    if (live.task.state !== "running") this.setState(live, "running", `heard_${lineId}`);
    this.enqueue(live, async () => {
      try {
        if (!this.answerByRule(live, lineId)) await (viaGate ? this.gate(live, lineId, ctx, prov) : this.decide(live, lineId, ctx, prov));
      } finally { this.afterLine(live, lineId, false); }
    });
    return { task_id: live.task.task_id, line_id: lineId };
  }

  // After a line is decided its audio is let go, and an ambient line's words are stored only when an action or a question rests on them.
  private afterLine(l: Live, lineId: string, keep: boolean): void {
    this.clips.delete(lineId);
    const t = l.task;
    const line = t.lines.find((x) => x.id === lineId);
    if (!line || line.kept) return;
    const rests = keep || t.order.some((id) => t.actions.get(id)!.line_id === lineId) || t.questions.some((q) => q.line_id === lineId || q.answered_by === lineId);
    if (rests) { this.append(l, "line.kept", { line_id: lineId, text: line.text, raw_text: line.ambient?.raw_text ?? null }); return; }
    line.text = "";
    if (line.ambient) line.ambient.raw_text = "";
  }

  // A short answer to the latest open choice ("88", "yes", "no") settles it by rule with no model call; anything else goes to the gate.
  private answerByRule(l: Live, lineId: string): boolean {
    const t = l.task;
    const line = t.lines.find((x) => x.id === lineId);
    if (!line || line.decided || t.state !== "running") return false;
    const q = t.questions.filter((y) => y.answered_by === null || y.answered_by === lineId).at(-1);
    if (!q?.choice || Date.parse(line.at) - Date.parse(q.at) > (this.o.answerWindowMs ?? 120_000)) return false;
    const a = answerChoice(line.text, q.choice);
    if (!a) return false;
    if (q.answered_by === null) this.append(l, "question.answered", { question_id: q.question_id, line_id: lineId });
    this.append(l, "line.ruled", { line_id: lineId, classes: ["instruction"], as: "answer", question_id: q.question_id });
    if (a === "no") { this.note(l, "Left it unwritten, as you said."); this.settle(l, "answered_no"); return true; }
    const c = q.choice;
    const raw: Record<string, unknown> = { ...c.base, ...Object.fromEntries(Object.entries(a).map(([k, v]) => [k, k === "temp_c" ? tempText(v) ?? v : k === "bp" ? v : Number(v)])) };
    const own = Object.fromEntries(Object.entries(a).filter(([, v]) => line.text.includes(String(v).split("/")[0]!)));
    if (c.kind === OBSERVATION_KIND) {
      const parsed = ObservationArgs.safeParse({ ...raw, admission_id: t.admission_id });
      if (!parsed.success) { this.ask(l, lineId, `I could not use that (${parsed.error.issues[0]?.message ?? "invalid"}). Please say it again.`); this.settle(l, "asked"); return true; }
      this.proposeObservation(l, lineId, parsed.data, c.corrects_action_id, own);
      return true;
    }
    const schema = WORK_ARGS[c.kind as Exclude<WorkKind, typeof OBSERVATION_KIND>];
    const parsed = schema?.safeParse(raw);
    if (!parsed?.success) { this.ask(l, lineId, "I could not use that. Please say it again."); this.settle(l, "asked"); return true; }
    this.propose(l, lineId, c.kind, parsed.data, null, own);
    return true;
  }

  private subjectOf(t: EmrTask): EmrTarget {
    return t.admission_id ? { admission_id: t.admission_id } : t.patient_id ? { patient_id: t.patient_id } : { admission_id: t.admission_id };
  }

  // Pauses for a spoken "stop, I'll come back to this": actions on hold stay on hold, unwritten, and are listed for the return.
  private pauseSpoken(l: Live, lineId: string, ctx: EmrContext): void {
    const t = l.task;
    const pending = t.order.filter((id) => t.actions.get(id)!.state === "proposed");
    this.append(l, "line.handled", { line_id: lineId, as: "pause" });
    this.append(l, "task.paused", { line_id: lineId, reason: "called_away", pending, facts: ctx.facts });
    const list = pending.map((id, i) => `${i + 1}. ${t.actions.get(id)!.summary}`).join("; ");
    this.note(l, pending.length ? `Paused. Waiting for you, not written: ${list}.` : "Paused. Nothing was waiting to be written.");
    this.setState(l, "paused", "called_away");
  }

  // Resumes on "where were we": a fresh read of the record, what changed while away, and what is still waiting; then the held actions go on their hold again.
  async resume(l: Live, lineId: string | null, prov: Provenance): Promise<void> {
    const t = l.task;
    if (t.state !== "paused") return;
    const since = t.pause?.at ?? t.updated_at;
    const before = t.pause?.facts ?? {};
    let facts: Record<string, string | null> = {};
    try { facts = (await this.o.port.resolve(this.subjectOf(t), prov)).facts; } catch { facts = before; }
    const changed = Object.keys({ ...before, ...facts }).filter((k) => (before[k] ?? null) !== (facts[k] ?? null)).map((k) => `${k.replace(/_/g, " ")} ${before[k] ?? "none"} to ${facts[k] ?? "none"}`);
    const watched = t.changes.filter((c) => c.at >= since).map((c) => `${c.label} ${c.from ?? "none"} to ${c.to ?? "none"}`);
    const pages = t.pages.filter((p) => p.at >= since).length;
    const heard = t.lines.filter((x) => x.at >= since && x.id !== lineId && x.id !== t.pause?.line_id).length;
    const pending = t.order.filter((id) => t.actions.get(id)!.state === "proposed");
    const digest = [
      changed.length || watched.length ? `While you were away, the record changed: ${[...changed, ...watched].join("; ")}.` : "While you were away, nothing changed in the record.",
      pages ? `${pages} page${pages > 1 ? "s" : ""} came in.` : null,
      heard ? `I heard ${heard} line${heard > 1 ? "s" : ""} and did nothing with ${heard > 1 ? "them" : "it"}.` : null,
      pending.length ? `Still waiting, now going ahead unless you stop me: ${pending.map((id) => t.actions.get(id)!.summary).join("; ")}.` : "Nothing was waiting."
    ].filter(Boolean).join(" ");
    if (lineId) this.append(l, "line.handled", { line_id: lineId, as: "resume" });
    this.append(l, "task.resumed", { line_id: lineId, digest, changed, watched, pending });
    this.note(l, digest);
    this.setState(l, "running", "resumed");
    for (const id of pending) this.hold(l, id);
    this.settle(l, "resumed");
  }

  // The strip's resume button: the same return as "where were we", with no line.
  resumeTask(taskId: string, by: string): boolean {
    const l = this.live.get(taskId);
    if (!l) return false;
    if (l.task.owner !== by) throw new Error("the task belongs to another owner");
    if (l.task.state !== "paused") return false;
    this.enqueue(l, () => this.resume(l, null, { owner: by, evidence: `transcript:resume-${taskId}`.slice(0, 200), spoken_at: this.wall().toISOString() }));
    return true;
  }

  // Stops every proposed action before its write and pauses the task; a write already on the wire finishes and is still proved.
  interrupt(taskId: string, by: string): { cancelled: string[]; in_flight: string[] } | null {
    const l = this.live.get(taskId);
    if (!l) return null;
    if (l.task.owner !== by) throw new Error("the task belongs to another owner");
    const cancelled: string[] = [];
    const inFlight: string[] = [];
    for (const id of l.task.order) {
      const a = l.task.actions.get(id)!;
      if (a.state === "proposed") { this.append(l, "action.cancelled", { action_id: id, reason: "interrupted" }); cancelled.push(id); }
      else if (a.state === "sent" || a.state === "acknowledged") inFlight.push(id);
    }
    if (!CLOSED_TASK.has(l.task.state)) this.setState(l, "paused", "interrupted");
    return { cancelled, in_flight: inFlight };
  }

  private async decide(l: Live, lineId: string, ctx: EmrContext, prov: Provenance): Promise<void> {
    const t = l.task;
    const line = t.lines.find((x) => x.id === lineId);
    if (!line || line.decided) return;
    if (t.state !== "running") { this.append(l, "intent.failed", { line_id: lineId, reason: `task_${t.state}` }); return; }
    const openQ = [...t.questions].reverse().find((q) => q.answered_by === lineId) ?? null;
    let r;
    try {
      r = await decideIntent(this.o.client, {
        context: ctx, said: line.text, openQuestion: openQ?.text ?? null,
        actions: t.order.map((id) => t.actions.get(id)!).map((a) => ({ action_id: a.action_id, kind: a.kind, state: a.state, args: a.args, record_id: a.written?.record_id ?? null })),
        earlier: t.lines.slice(0, t.lines.indexOf(line)).slice(-6).map((x) => ({ id: x.id, text: x.text }))
      }, { run_id: t.run_id, task_id: t.task_id }, this.o.routes ?? { primary: DEFAULT_INTENT_ROUTE, fallback: FALLBACK_INTENT_ROUTE });
    } catch (e) {
      const code = e instanceof ModelError ? e.code : "error";
      this.append(l, "intent.failed", { line_id: lineId, reason: `model_${code}` });
      if (l.task.state === "running") this.setState(l, "needs_input", `model_${code}`);
      return;
    }
    this.append(l, "intent.decided", {
      line_id: lineId, decision: r.value, provider: r.provider, model: r.model, response_id: r.response_id, ledger: r.ledger, cost_usd: r.cost_usd,
      calls: 1 + r.repairs, repairs: r.repairs, fallback_reason: r.fallback_reason
    });
    if (l.task.state !== "running") return;
    this.applyDecision(l, lineId, r.value, prov);
  }

  // The task's actions by number, as the gate sees them; numbers count from the first action of the task.
  private gateActions(t: EmrTask): GateAction[] {
    const n = new Map(t.order.map((id, i) => [id, i + 1]));
    return t.order.map((id) => t.actions.get(id)!).map((a) => ({
      n: n.get(a.action_id)!, kind: a.kind, args: a.args,
      state: a.state === "cancelled" ? "stopped" : a.state === "refused" || a.state === "failed" ? "not recorded" : "active",
      corrects: a.corrects_action_id ? n.get(a.corrects_action_id) ?? null : null
    }));
  }

  // One gate call per finalised ambient utterance, then each clause in order: act, correct, ask, refuse, or only label the line.
  private async gate(l: Live, lineId: string, ctx: EmrContext, prov: Provenance): Promise<void> {
    const t = l.task;
    const line = t.lines.find((x) => x.id === lineId);
    if (!line || line.decided) return;
    if (CLOSED_TASK.has(t.state)) { this.append(l, "intent.failed", { line_id: lineId, reason: `task_${t.state}` }); return; }
    // Lines keep coming while an earlier one is decided, so each ambient line wakes the task again when its turn comes.
    if (t.state !== "running") this.setState(l, "running", `heard_${lineId}`);
    const settings = this.o.gate ?? GATE_SETTINGS;
    const kinds = this.kinds(t.owner);
    const openQ = t.questions.filter((q) => q.answered_by === null).at(-1) ?? null;
    const wide = isWide(kinds);
    const names = wide ? this.o.port.names?.() : undefined;
    let r;
    try {
      r = await gateUtterance(this.o.client, {
        kinds, context: ctx, actions: this.gateActions(t), openQuestion: openQ?.text ?? null,
        recent: t.lines.slice(0, t.lines.indexOf(line)).filter((x) => x.text).slice(-6).map((x) => x.text), said: line.text,
        ...(wide ? { today: this.wall().toISOString().slice(0, 10), ...(names ? { names } : {}) } : {})
      }, { run_id: t.run_id, task_id: t.task_id }, settings);
    } catch (e) {
      const code = e instanceof ModelError ? e.code : "error";
      this.append(l, "intent.failed", { line_id: lineId, reason: `model_${code}` });
      if (l.task.state === "running") this.setState(l, "needs_input", `model_${code}`);
      return;
    }
    // A clause is applied only when its words come from this line; the model sometimes classes the recent words it was shown again.
    const clauses = r.value.clauses.filter((c) => fromLine(c.words, line.text));
    const outside = r.value.clauses.filter((c) => !fromLine(c.words, line.text));
    // A withheld line's clause words stay out of the store too; only the classes and values are kept.
    const bare = (cs: readonly GateClause[]) => (line.kept ? cs : cs.map(({ words, ...c }) => ({ ...c, words: "", word_count: words.split(/\s+/).filter(Boolean).length })));
    this.append(l, "gate.decided", {
      line_id: lineId, clauses: bare(clauses), ...(outside.length ? { outside_line: bare(outside) } : {}), provider: r.provider, model: r.model, response_id: r.response_id, ledger: r.ledger, cost_usd: r.cost_usd,
      calls: 1 + r.repairs, repairs: r.repairs, fallback_reason: r.fallback_reason, prompt_sha256: r.prompt_sha256
    });
    if (l.task.state !== "running") return;
    // Words meant for the agent answer its open question before they are acted on.
    if (clauses.some((c) => c.class === "instruction" || c.class === "correction")) {
      for (const q of t.questions.filter((y) => y.answered_by === null)) this.append(l, "question.answered", { question_id: q.question_id, line_id: lineId });
    }
    for (const c of oneUnclear(mergeInstructions(clauses, settings.confidence_floor, kinds))) this.applyClause(l, lineId, c, settings.confidence_floor, kinds, prov);
    this.settle(l, "heard");
  }

  private applyClause(l: Live, lineId: string, c: GateClause, floor: number, kinds: readonly string[], prov: Provenance): void {
    const t = l.task;
    if (c.class === "unclear") {
      // An unclear vitals line is asked back with what was heard in quotes, so one word can settle it.
      if (measuresIn(c.words).length) {
        const q = quotedQuestion(c.words, c.question ?? null);
        const kind = kinds.includes(OBSERVATION_KIND) ? OBSERVATION_KIND : kinds.includes("record_triage_vitals") ? "record_triage_vitals" : null;
        const base = kind === "record_triage_vitals" ? { ...(t.visit_id ? { visit_id: t.visit_id } : {}), ...(t.patient_id ? { patient_id: t.patient_id } : {}) } : {};
        this.ask(l, lineId, q.text, q.choice && kind ? { ...q.choice, kind, base, corrects_action_id: null } : null);
        return;
      }
      this.ask(l, lineId, c.question ?? `I did not catch what to record from "${c.words.slice(0, 120)}". Please say it again.`);
      return;
    }
    if (c.class !== "instruction" && c.class !== "correction") return;
    if (c.class === "instruction" && (!c.kind || !kinds.includes(c.kind))) {
      const asked = (c.asked_for ?? c.words).slice(0, 200);
      this.append(l, "gate.refused", { line_id: lineId, kind: c.kind ?? null, asked_for: asked, ...(t.lines.find((x) => x.id === lineId)?.kept ? { words: c.words } : {}) });
      this.note(l, `Not mine to do, left for you: ${asked}.`);
      return;
    }
    if ((c.confidence ?? 0) < floor) {
      this.ask(l, lineId, c.question ?? `Did you want me to chart this: "${c.words.slice(0, 160)}"?`);
      return;
    }
    if (c.class === "instruction" && c.kind && c.kind !== OBSERVATION_KIND) return this.applyWork(l, lineId, c as AnyClause, c.kind);
    if (c.class === "correction") {
      const m0 = /^#?(\d+)$/.exec((c.target ?? "").trim());
      const named0 = m0 ? t.order[Number(m0[1]) - 1] : c.target && t.actions.has(c.target) ? c.target : undefined;
      const latest0 = [...t.order].reverse().find((id) => !["cancelled", "refused", "failed"].includes(t.actions.get(id)!.state));
      const target0 = t.actions.get(named0 ?? latest0 ?? "");
      const obsValues = c.temp_c != null || c.pulse != null || c.resp_rate != null || c.bp != null;
      if (target0 && target0.kind !== OBSERVATION_KIND && !obsValues) return this.correctWork(l, lineId, c as AnyClause, target0);
    }
    let corrects: string | null = null;
    if (c.class === "correction") {
      const m = /^#?(\d+)$/.exec((c.target ?? "").trim());
      const named = m ? t.order[Number(m[1]) - 1] : c.target ? (t.actions.has(c.target) ? c.target : undefined) : undefined;
      // A correction targets the most recent action that still stands unless it names another.
      const latest = [...t.order].reverse().find((id) => t.actions.get(id)!.kind === OBSERVATION_KIND && t.actions.get(id)!.state !== "cancelled" && t.actions.get(id)!.state !== "refused" && t.actions.get(id)!.state !== "failed");
      corrects = named ?? latest ?? null;
      if (!corrects) { this.ask(l, lineId, "Which entry should I correct? Please say the values again."); return; }
    }
    const d: Decide = {
      decision: "record", temp_c: c.temp_c ?? null, pulse: c.pulse ?? null, resp_rate: c.resp_rate ?? null, bp: c.bp ?? null, remark: c.remark ?? null,
      corrects_action_id: corrects, cancel_action_id: null, question: null, reason: null, summary: c.words.slice(0, 200)
    };
    this.applyDecision(l, lineId, d, prov);
  }

  // Builds one non-observation action from a clause: every value must have been said, ids come from the task, and anything missing becomes a question.
  private applyWork(l: Live, lineId: string, c: AnyClause, kind: string): void {
    const t = l.task;
    const line = t.lines.find((x) => x.id === lineId)?.text ?? "";
    const said = (v: string | null | undefined) => (v && fromLine(v, line) ? v.trim() : null);
    const words = c.words.trim();
    const needAdmission = () => { if (!t.admission_id) { this.ask(l, lineId, "The patient is not admitted yet, so that has to wait for the admission. Tell me again once it exists."); return false; } return true; };
    const needVisit = () => { if (!t.visit_id) { this.ask(l, lineId, "I do not have this patient's arrival in context, so I cannot do that here."); return false; } return true; };
    const nums = new Set((line.match(/\d+(?:\.\d+)?/g) ?? []).map((x) => String(Number(x))));
    const heard = (v: unknown) => v !== null && v !== undefined && String(v).split("/").every((n) => nums.has(String(Number(n))));
    const ids = { ...(t.patient_id ? { patient_id: t.patient_id } : {}) };
    let raw: Record<string, unknown>;
    let own: Record<string, unknown> = {};
    switch (kind as WorkKind) {
      case "draft_consult_note": if (!needVisit()) return; raw = { visit_id: t.visit_id, ...ids, text: said(c.text) ?? words }; break;
      case "request_admission": {
        if (!needVisit()) return;
        if (!c.ward_class || !wordSaid(c.ward_class, line)) return this.ask(l, lineId, "Which ward class should I request: general, private, ICU, HDU or another?");
        if (!c.admission_type || !wordSaid(c.admission_type, line)) return this.ask(l, lineId, "Is this an emergency or a planned admission?");
        raw = { visit_id: t.visit_id, ...ids, ward_class: c.ward_class, admission_type: c.admission_type, reason: said(c.text) ?? words };
        break;
      }
      case "record_triage_vitals": {
        if (!needVisit()) return;
        raw = { visit_id: t.visit_id, ...ids };
        const dropped: string[] = [];
        for (const k of ["temp_c", "pulse", "resp_rate", "bp", "spo2", "weight_kg"] as const) {
          const v = c[k];
          if (v === null || v === undefined || v === "") continue;
          if (!heard(v)) { dropped.push(`${k} ${String(v)}`); continue; }
          raw[k] = k === "temp_c" ? tempText(v as string | number) ?? String(v) : k === "bp" ? String(v).replace(/\s+/g, "") : v;
        }
        if (dropped.length) this.note(l, `Left out values you did not say: ${dropped.join(", ")}.`);
        own = Object.fromEntries(["temp_c", "pulse", "resp_rate", "bp", "spo2"].filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
        if (c.priority && wordSaid(c.priority, line)) raw["priority"] = c.priority;
        const note = said(c.text);
        if (note) raw["note"] = note.slice(0, 500);
        break;
      }
      case "add_care_plan_item": {
        if (!needAdmission()) return;
        if (!c.cadence || !cadenceSaid(c.cadence, line)) return this.ask(l, lineId, `How often should "${(c.title ?? words).slice(0, 80)}" be done?`);
        raw = { admission_id: t.admission_id, title: (said(c.title) ?? words).slice(0, 200), item_kind: c.item_kind ?? "nursing", cadence: c.cadence };
        break;
      }
      case "record_note": {
        if (!needAdmission()) return;
        const draft = [...t.order].reverse().map((id) => t.actions.get(id)!).find((a) => a.kind === "draft_handover" && a.state === "completed" && a.draft);
        const text = said(c.text);
        if (!text && draft && !t.order.some((id) => { const a = t.actions.get(id)!; return a.kind === "record_note" && a.args["label"] === "handover" && a.proposed_at >= draft.proposed_at && a.state !== "cancelled"; })) {
          raw = { admission_id: t.admission_id, note_type: "nursing", text: draft.draft, label: "handover" };
          break;
        }
        if (!text && !c.text) return this.ask(l, lineId, "What should the note say?");
        raw = { admission_id: t.admission_id, note_type: c.note_type ?? (this.kinds(t.owner).includes("record_triage_vitals") ? "nursing" : "progress"), text: text ?? words };
        break;
      }
      case "draft_handover": case "prepare_bill": case "send_pay_link": if (!needAdmission()) return; raw = { admission_id: t.admission_id }; break;
      case "page_staff": {
        const targets = this.o.port.names?.().page_targets ?? {};
        const to = c.to && targets[c.to] ? c.to : null;
        if (!to || !(targets[to] ?? []).some((w) => wordSaid(w, line))) return this.ask(l, lineId, `Who should I page? I can page ${Object.keys(targets).join(", ") || "nobody yet"}.`);
        raw = { to, text: (said(c.text) ?? words).slice(0, 1500), ...ids, ...(t.visit_id ? { visit_id: t.visit_id } : {}), ...(t.admission_id ? { admission_id: t.admission_id } : {}) };
        break;
      }
      case "schedule_follow_up": {
        if (!needVisit()) return;
        const clinics = this.o.port.names?.().clinics ?? {};
        const clinic = c.clinic && clinics[c.clinic] && (clinics[c.clinic] ?? []).some((w) => wordSaid(w, line)) ? c.clinic : null;
        if (!clinic) return this.ask(l, lineId, `Which clinic should the follow-up be in? I know ${Object.keys(clinics).join(", ") || "none"}.`);
        if (!c.date || !dateSaid(c.date, line)) return this.ask(l, lineId, "Which day should I book? Please say the date.");
        raw = { visit_id: t.visit_id, ...ids, clinic, date: c.date };
        break;
      }
      default: return this.ask(l, lineId, "I cannot do that kind of work here.");
    }
    const schema = WORK_ARGS[kind as Exclude<WorkKind, typeof OBSERVATION_KIND>];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) { this.ask(l, lineId, `I could not use that (${parsed.error.issues[0]?.message ?? "invalid"}). Please say it again.`); return; }
    this.propose(l, lineId, kind, parsed.data, null, own);
  }

  // A correction of other work replaces it while it is still on hold; once written, only a new instruction adds to the record.
  private correctWork(l: Live, lineId: string, c: AnyClause, target: EmrAction): void {
    if (target.state !== "proposed") { this.ask(l, lineId, "That is already in the record and stays as written. Tell me what to add and I will add it."); return; }
    const over = Object.fromEntries(Object.entries(c).filter(([k, v]) => v !== null && v !== undefined && !["words", "class", "kind", "target", "confidence", "question", "asked_for"].includes(k)));
    this.append(l, "action.cancelled", { action_id: target.action_id, reason: `corrected_by_${lineId}` });
    const merged: AnyClause = { ...(c as AnyClause), ...Object.fromEntries(Object.entries(target.args).map(([k, v]) => [k === "reason" || k === "note" ? "text" : k, v])), ...over, class: "instruction", kind: target.kind, words: c.words };
    this.applyWork(l, lineId, merged, target.kind);
  }

  private propose(l: Live, lineId: string, kind: string, args: WorkArgs, correctsId: string | null, own: Record<string, unknown> = {}): void {
    const t = l.task;
    const actionId = `a-${shortHash(t.task_id, lineId, t.order.length + 1)}`;
    const ears = this.startCheck(l, actionId, lineId, own);
    this.append(l, "action.proposed", { action_id: actionId, kind, args, summary: kind === OBSERVATION_KIND ? summarise(args as ObservationArgs, correctsId) : summariseWork(kind, args), line_id: lineId, corrects_action_id: correctsId, hold_ms: this.o.holdMs ?? 0, ...(ears ? { ears: true } : {}) });
    this.settle(l, "proposed");
    if (t.state === "running") this.hold(l, actionId);
  }

  private note(l: Live, text: string): void {
    this.append(l, "task.note", { note_id: `n-${shortHash(l.task.task_id, l.task.notes.length + 1)}`, text });
  }
  private ask(l: Live, lineId: string, text: string, choice: QuestionChoice | null = null): void {
    this.append(l, "question.asked", { question_id: `q-${shortHash(l.task.task_id, l.task.questions.length + 1)}`, line_id: lineId, text: text.slice(0, 300), ...(choice ? { choice } : {}) });
  }

  private applyDecision(l: Live, lineId: string, d: Decide, _prov: Provenance): void {
    const t = l.task;
    if (d.decision === "ask") { this.ask(l, lineId, d.question ?? d.summary); return this.settle(l, "asked"); }
    if (d.decision === "aside") { this.note(l, "Heard an aside; nothing to do."); return this.settle(l, "aside"); }
    if (d.decision === "decline") { this.note(l, `Not done: ${(d.reason ?? d.summary).slice(0, 200)}`); return this.settle(l, "declined"); }
    if (d.decision === "cancel") {
      const a = d.cancel_action_id ? t.actions.get(d.cancel_action_id) : undefined;
      if (a && a.state === "proposed") { this.append(l, "action.cancelled", { action_id: a.action_id, reason: `cancelled_by_${lineId}` }); return this.settle(l, "cancelled_action"); }
      if (a && a.state === "completed") { this.ask(l, lineId, "That entry is already in the record and only an administrator can void it. Say the correct values and I will add a correcting entry."); return this.settle(l, "asked"); }
      this.note(l, "There was no pending action to stop.");
      return this.settle(l, "nothing_to_cancel");
    }
    let corrects: EmrAction | null = null;
    if (d.corrects_action_id) {
      // The model may name the action or the record it wrote; both identify one earlier action.
      corrects = t.actions.get(d.corrects_action_id) ?? [...t.actions.values()].find((x) => x.written?.record_id === d.corrects_action_id) ?? null;
      if (!corrects) { this.ask(l, lineId, "Which entry should I correct? Please say the values again."); return this.settle(l, "asked"); }
    }
    // A correction carries over every value of the corrected action the clinician did not restate.
    const base = corrects ? Object.fromEntries(Object.entries(corrects.args).filter(([k]) => ["temp_c", "pulse", "resp_rate", "bp"].includes(k))) : {};
    const raw: Record<string, unknown> = { ...base, admission_id: t.admission_id };
    // A value is kept only when its number was in the clinician's words, so the model cannot fill one in.
    const said = new Set((t.lines.find((x) => x.id === lineId)?.text.match(/\d+(?:\.\d+)?/g) ?? []).map((x) => String(Number(x))));
    const heard = (v: string | number) => String(v).split("/").every((n) => said.has(String(Number(n))));
    const dropped: string[] = [];
    let own = 0;
    const ownVals: Record<string, unknown> = {};
    const take = (k: string, v: string | number | null | undefined, norm: (x: string | number) => string | number) => {
      if (v === null || v === undefined || v === "") return;
      if (heard(v)) { raw[k] = norm(v); ownVals[k] = raw[k]; own += 1; } else dropped.push(`${k} ${v}`);
    };
    take("temp_c", d.temp_c, (v) => tempText(v) ?? String(v));
    take("pulse", d.pulse, (v) => v);
    take("resp_rate", d.resp_rate, (v) => v);
    take("bp", d.bp, (v) => String(v).replace(/\s+/g, ""));
    if (dropped.length) this.note(l, `Left out values you did not say: ${dropped.join(", ")}.`);
    // A correction must change a value the clinician said; otherwise it would only copy the entry it corrects.
    if (corrects && own === 0) { this.ask(l, lineId, "Which value should I correct? Please say it again."); return this.settle(l, "asked"); }
    if (d.remark) raw["remark"] = d.remark;
    // A correction of an entry already written cites it; a correction of one still on hold replaces it, so nothing is cited.
    if (corrects && corrects.written) raw["corrects_record_id"] = corrects.written.record_id;
    const parsed = ObservationArgs.safeParse(raw);
    if (!parsed.success) {
      this.ask(l, lineId, `I could not use those values (${parsed.error.issues[0]?.message ?? "invalid"}). Please say them again.`);
      return this.settle(l, "asked");
    }
    if (corrects && corrects.state === "proposed") this.append(l, "action.cancelled", { action_id: corrects.action_id, reason: `corrected_by_${lineId}` });
    this.proposeObservation(l, lineId, parsed.data, corrects && corrects.written ? corrects.action_id : null, ownVals);
  }

  // Proposes one observation; when the line came with audio, the second ear reads the values said in it while the action waits on its hold.
  private proposeObservation(l: Live, lineId: string, args: ObservationArgs, correctsId: string | null, own: Record<string, unknown>): void {
    const t = l.task;
    const actionId = `a-${shortHash(t.task_id, lineId, t.order.length + 1)}`;
    const ears = this.startCheck(l, actionId, lineId, own);
    this.append(l, "action.proposed", { action_id: actionId, kind: OBSERVATION_KIND, args, summary: summarise(args, correctsId), line_id: lineId, corrects_action_id: correctsId, hold_ms: this.o.holdMs ?? 0, ...(ears ? { ears: true } : {}) });
    this.settle(l, "proposed");
    this.hold(l, actionId);
  }

  // Starts the second reading of a line's audio for the values said in it; nothing starts without audio, a second ear or a value.
  private startCheck(l: Live, actionId: string, lineId: string, own: Record<string, unknown>): boolean {
    const clip = this.clips.get(lineId);
    const vals = Object.fromEntries(Object.entries(own).filter(([k, v]) => (["temp_c", "pulse", "resp_rate", "bp", "spo2"] as string[]).includes(k) && v !== null && v !== undefined && v !== "")) as Partial<Record<Measure, unknown>>;
    if (!clip || !this.o.secondEar || !Object.keys(vals).length) return false;
    const t = l.task;
    const p = this.o.secondEar(clip.wav, { run_id: t.run_id, task_id: t.task_id, line_id: lineId })
      .then((reading): EarsOutcome => ({ check: compareReadings(vals, reading.text, clip.guessed), reading, error: null }))
      .catch((e: unknown): EarsOutcome => ({
        check: { agree: false, measures: Object.entries(vals).map(([m, v]) => ({ measure: m as Measure, first: normValue(m as Measure, v), second: null, agree: false })) },
        reading: null, error: e instanceof ModelError ? e.code : "ear_failed"
      }));
    this.checks.set(actionId, p);
    return true;
  }

  // Waits for the second reading before the write; when the readings differ the action is stopped and a one-word question shows both.
  private async earsAgree(l: Live, a: EmrAction): Promise<boolean> {
    const t = l.task;
    if (!a.ears || t.ears.some((e) => e.action_id === a.action_id && e.agree)) return true;
    const p = this.checks.get(a.action_id);
    if (!p) {
      this.append(l, "action.cancelled", { action_id: a.action_id, reason: "second_reading_lost" });
      this.ask(l, a.line_id, "I lost the second reading of that before it was written. Please say the values again.");
      this.settle(l, "asked");
      return false;
    }
    const r = await p;
    this.checks.delete(a.action_id);
    const line = t.lines.find((x) => x.id === a.line_id);
    this.append(l, "ears.compared", {
      action_id: a.action_id, line_id: a.line_id, session_id: line?.ambient?.session_id ?? null, agree: r.check.agree, measures: r.check.measures, error: r.error,
      provider: r.reading?.provider ?? null, model: r.reading?.model ?? null, response_id: r.reading?.response_id ?? null, cost_usd: r.reading?.cost_usd ?? 0, calls: r.reading ? r.reading.calls ?? 1 : 0, fallback_reason: r.reading?.fallback_reason ?? null
    });
    if (r.check.agree) return a.state === "proposed" && t.state === "running";
    if (a.state !== "proposed") return false;
    this.append(l, "action.cancelled", { action_id: a.action_id, reason: "readings_differ" });
    const q = disagreementQuestion(r.check);
    const base = Object.fromEntries(Object.entries(a.args).filter(([k]) => k !== "admission_id" && !q.choice.measures.includes(k as Measure)));
    this.ask(l, a.line_id, q.text, { ...q.choice, kind: a.kind, base, corrects_action_id: a.corrects_action_id });
    this.settle(l, "asked");
    return false;
  }

  // Reads what each open task watches and the owner's inbox; changes become notes, a watched stage the owner's work waits on becomes one question, and no model is called.
  async pollOnce(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const port = this.o.port;
      const at = this.wall().toISOString();
      for (const l of [...this.live.values()]) {
        const t = l.task;
        if (CLOSED_TASK.has(t.state) || !port.watch) continue;
        const prov: Provenance = { owner: t.owner, evidence: `watch:${t.task_id}`, spoken_at: at };
        let read;
        try { read = await port.watch(t.owner, { ...this.subjectOf(t), visit_id: t.visit_id }, prov); } catch (e) { this.log(`watch ${t.task_id}: ${e instanceof Error ? e.message : String(e)}`); continue; }
        if (!read || this.stopped) continue;
        const before = t.watch;
        const changes = before ? Object.keys(read.facts).filter((k) => (before[k] ?? null) !== (read.facts[k] ?? null)).map((k) => ({ fact: k, label: read.labels[k] ?? k, from: before[k] ?? null, to: read.facts[k] ?? null })) : [];
        if (!before || changes.length) this.append(l, "watch.changed", { facts: read.facts, changes });
        for (const c of changes) this.note(l, `${c.label}: ${c.from ?? "none"} to ${c.to ?? "none"}.`);
        const kinds = this.kinds(t.owner);
        for (const o of port.offers?.(t.owner) ?? []) {
          const key = `${o.fact}=${o.equals}:${o.kind}`;
          if (!kinds.includes(o.kind) || t.offered.includes(key) || read.facts[o.fact] !== o.equals) continue;
          if (t.order.some((id) => t.actions.get(id)!.kind === o.kind && t.actions.get(id)!.state !== "cancelled")) continue;
          this.append(l, "offer.made", { offer: key });
          this.ask(l, t.lines.at(-1)?.id ?? "watch", o.ask);
          this.settle(l, "offered");
        }
      }
      if (port.inbox) {
        for (const owner of new Set([...this.live.values()].filter((l) => !CLOSED_TASK.has(l.task.state)).map((l) => l.task.owner))) {
          let pages: InboxPage[];
          try { pages = await port.inbox(owner, { owner, evidence: "watch:inbox", spoken_at: at }); } catch { continue; }
          const mine = [...this.live.values()].filter((l) => l.task.owner === owner && !CLOSED_TASK.has(l.task.state));
          const seen = new Set(mine.flatMap((l) => l.task.pages.map((p) => p.page_id)));
          for (const p of pages.filter((x) => !seen.has(x.page_id))) {
            const home = mine.filter((l) => p.patient_id && l.task.patient_id === p.patient_id).at(-1) ?? mine.sort((a, b) => (a.task.updated_at < b.task.updated_at ? -1 : 1)).at(-1);
            if (!home) continue;
            this.append(home, "page.received", { page: p });
            this.note(home, `A page came in: "${p.subject.slice(0, 120)}". I have not acted on it; tell me what you want done.`);
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private hold(l: Live, actionId: string): void {
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.stopped) this.enqueue(l, () => this.execute(l, actionId)); }, this.o.holdMs ?? 0);
    this.timers.add(timer);
  }

  private provFor(t: EmrTask, a: EmrAction): Provenance {
    const line = t.lines.find((x) => x.id === a.line_id);
    return { owner: t.owner, evidence: `transcript:${a.line_id}`, spoken_at: line?.at ?? t.created_at };
  }

  // Journal, write, reconcile once by replaying the same key, then prove by a fresh read; the task state is checked right before the write.
  private async execute(l: Live, actionId: string): Promise<void> {
    const t = l.task;
    const a = t.actions.get(actionId);
    if (!a) return;
    if (a.state === "proposed") {
      if (t.state !== "running") return;
      if (!(await this.earsAgree(l, a))) return;
      this.append(l, "action.intent", { action_id: actionId, intent_key: emrIntentKey(t.task_id, actionId, a.args), args: a.args });
    }
    if (a.state !== "sent" && a.state !== "acknowledged") return;
    const prov = this.provFor(t, a);
    if (a.state === "sent") {
      let c = await this.o.port.commit(a.kind, a.args, a.intent_key!, prov);
      if (!c.ok && c.retryable) {
        this.append(l, "action.retry", { action_id: actionId, reason: c.reason, status: c.status });
        c = await this.o.port.commit(a.kind, a.args, a.intent_key!, prov);
      }
      if (!c.ok) {
        this.append(l, c.retryable ? "action.failed" : "action.refused", { action_id: actionId, reason: c.reason, status: c.status, counted: c.counted });
        return this.settle(l, c.retryable ? "write_failed" : "write_refused");
      }
      this.append(l, "action.written", { action_id: actionId, written: { record_id: c.record_id, record_version: c.record_version, event_ids: c.event_ids, replayed: c.replayed } });
      if (c.report || c.draft) this.append(l, "action.reported", { action_id: actionId, report: c.report ?? null, draft: c.draft ?? null });
    }
    const w = a.written!;
    let proof = await this.o.port.prove(a.kind, a.args, w, prov);
    if (!proof) {
      await new Promise((r) => setTimeout(r, this.o.proofRetryMs ?? 500));
      proof = await this.o.port.prove(a.kind, a.args, w, prov);
    }
    if (!proof && this.o.port.unverifiable?.(a.kind)) {
      this.append(l, "action.unverified", { action_id: actionId, reason: `Sent, not verified: ${this.o.port.unverifiable(a.kind)}` });
      this.note(l, `${a.summary}: sent, but not verified. ${this.o.port.unverifiable(a.kind)}`);
      return this.settle(l, "unverified");
    }
    if (!proof || proof.record_id !== w.record_id) {
      this.append(l, "action.failed", { action_id: actionId, reason: proof ? "proof_for_another_record" : "unproved" });
      return this.settle(l, "unproved");
    }
    this.append(l, "action.completed", { action_id: actionId, proof });
    // An admission the agent requested becomes the task's subject, so later words reach the same task.
    if (a.kind === "request_admission" && !t.admission_id && EmrId.safeParse(w.record_id).success) this.append(l, "task.linked", { admission_id: w.record_id, by: actionId });
    if (a.kind === "draft_handover" && a.draft) this.ask(l, a.line_id, `Handover draft for your review: "${a.draft.slice(0, 900)}" Say save the handover to record it, or tell me what to change.`);
    if (a.kind === "prepare_bill" && a.report) this.note(l, a.report);
    this.settle(l, "proved");
  }

  // Running while any action is open, waiting while a question is open, otherwise done; paused and closed tasks stay as they are.
  private settle(l: Live, reason: string): void {
    const t = l.task;
    if (t.state === "paused" || CLOSED_TASK.has(t.state)) return;
    const open = t.order.some((id) => { const a = t.actions.get(id)!; return OPEN_ACTION.has(a.state) && !a.unverified; });
    if (open) return this.setState(l, "running", null);
    if (t.questions.some((q) => q.answered_by === null)) return this.setState(l, "waiting", "question_open");
    this.setState(l, "done", reason);
  }
}
