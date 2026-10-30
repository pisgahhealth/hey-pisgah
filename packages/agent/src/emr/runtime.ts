import { canonical, sha256, type TaskState } from "@hey-pisgah/contracts";
import { ModelError, type ModelClient } from "@hey-pisgah/model";
import { listStreams, openStream, type Stream } from "@hey-pisgah/store";
import type { Envelope } from "@hey-pisgah/contracts";
import { shortHash } from "../ids.js";
import { DEFAULT_INTENT_ROUTE, FALLBACK_INTENT_ROUTE, decideIntent, tempText, type Decide, type IntentRoute } from "./intent.js";
import { primaryClass } from "./classes.js";
import { CLERKING_KIND, GATE_SETTINGS, gateTwoStage, gateUtterance, holdsClerking, isWide, type GateAction, type GateClause, type GateInput, type GateResult, type GateSettings, type OrderClause, type SpeechClass } from "./gate.js";
import { LEVERS_OFF, hedgedRead, holdLeftMs, leverList, sharedMeasures, willWriteNumber, PROOF_HEDGE_MS, type SpeedLevers } from "./speed.js";
import { EmrId, OBSERVATION_KIND, ObservationArgs, type EmrContext, type EmrPort, type EmrProof, type EmrTarget, type InboxPage, type PaperworkReadBack, type Provenance, type WorkArgs } from "./port.js";
import { READ_ONLY_KINDS, WORK_ARGS, afterSaid, cadenceSaid, dateSaid, doseAgrees, dosesIn, minutesSaid, prescriptionSaid, saysDose, summariseWork, wordSaid, type WorkKind } from "./work.js";
import { cleanTranscript, measuresIn, type Measure, type Rewrite } from "@hey-pisgah/voice";
import { answerChoice, compareReadings, disagreementQuestion, normValue, quotedQuestion, type Choice, type EarReading, type EarsCheck, type SecondEar } from "./ears.js";
import type { VersionWiring } from "./version-offers.js";
import { DOCUMENTATION_KINDS, ORDER_KINDS, recordOf, type SpeakerRecord, type SpeakerVerdict, type Voiceprint } from "./speaker.js";
import { EMERGENCY_KIND, EMERGENCY_LINE, RULE_ONLY_KINDS, emergencyReason, identityFrom, spokenPatient, unidentifiedRef, type EmergencyArgs, type EmrIdentityHold } from "./entry.js";
import { screenFor, SCREEN_PAGES, type ScreenPage, type ScreenPlan } from "./screens.js";
import {
  ACK_KIND, COMPLETE_KIND, DELEGATE_KIND, DELEGATION_ARGS, DELEGATION_RULE_KINDS, DISPENSE_KIND, ESCALATE_KIND, NUDGE_KIND, PREPARE_KIND, REGISTER_KIND, WARD_REVIEW_KIND,
  acceptedTask, consentSaid, nameParts, onlyTeam, orderAsked, phoneSaid, registrationFrom, registrationInstruction, registrationNeeds, teamSaid,
  type DelegationRead, type EmrDelegation
} from "./delegate.js";
import { FROM_NOW_ON, PreferenceError, SCOPE_KINDS, describePref, describeScope, describeSource, readRule, scopeAnswer, type PrefField, type PreferenceMemory } from "./preferences.js";

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
  // A voice order waits for the owner's own matched voice, or for the spoken confirmation a controlled drug needs; the lines that gave them.
  awaiting: "owner_voice" | "confirm" | null; authorised_by_line: string | null; confirmed_by_line: string | null;
  // The page that shows this work, bound to the action's encounter and command id.
  screen: ScreenPlan | null;
  // The paperwork read back from the record before a discharge, which the owner's confirmation covers.
  read_back: PaperworkReadBack | null;
};
// Where an ambient line came from: its listening session, the chunks that made it, and when the speech ended.
export type AmbientMeta = { session_id: string; seqs: number[]; raw_text: string; ended_at: string; final_at: string; trailing_silence_ms: number; finished_by: string };
// kept is false while an ambient line's words live only in memory; they are stored only once an action or a question rests on them.
export type EmrLine = { id: string; text: string; at: string; source: "text" | "audio"; decided: boolean; ambient: AmbientMeta | null; classes: SpeechClass[]; kept: boolean; words: number; speaker: SpeakerRecord | null };
export type EmrRefusal = { line_id: string; kind: string | null; asked_for: string; at: string };
// A question may carry a choice: the values a one-word answer can pick, and the action it completes.
export type QuestionChoice = Choice & { kind: string; base: Record<string, unknown>; corrects_action_id: string | null };
// A question about a voice order is settled by the owner's own matched "yes" or "confirm", never by a model.
export type OrderRule = { kind: "countersign"; args: WorkArgs } | { kind: "confirm" | "authorise"; action_id: string };
export type EmrQuestion = { question_id: string; text: string; line_id: string; answered_by: string | null; at: string; choice: QuestionChoice | null; rule: OrderRule | null; pref_id: string | null };
// One use of a remembered preference in this task, or one it did not use and why, each with its source for the strip.
export type PrefUse = { pref_id: string; field: string; value: string; text: string; scope: string; source: string; line_id: string; action_id: string | null; reason: string | null; at: string };
// One comparison of the two readings before a vitals write.
export type EarsRecord = { action_id: string; line_id: string; session_id: string | null; agree: boolean; measures: EarsCheck["measures"]; error: string | null };
// One change the agent saw in what it watches, and the page it found in its own inbox.
export type WatchChange = { fact: string; label: string; from: string | null; to: string | null; at: string };
export type EmrPause = { line_id: string | null; reason: string; at: string; pending: string[]; facts: Record<string, string | null> };
// The adopted version as this task reads it: the offers it may make, what it says instead, and offers the monitor blocked.
export type EmrVersionView = { version: number; definition_hash: string; offers: string[]; lines: string[]; blocked: { offer: string; requirement_version: string; conflict: string }[] };
// Work held for a time or a record event; it fires once from the runtime's own timer and survives a restart because it lives in the task stream.
export type EmrObligation = {
  obligation_id: string; line_id: string; kind: string; clause: Record<string, unknown>; title: string;
  due_at: string | null; after: "admission" | "result" | null; state: "held" | "fired" | "done" | "cancelled";
  held_at: string; fired_at: string | null; fired_by: string | null; action_id: string | null; anchor_action_id: string | null; reason: string;
};
// One verified action timed from the end of the words that asked for it; parts are the milestones on the way.
export type SpeedRow = { action_id: string; kind: string; line_id: string; from: string; verified_at: string; ms: number; parts: Record<string, number | null>; gate?: string | null; levers?: number[]; from_record?: true };
export type EmrTask = {
  task_id: string; owner: string; admission_id: string; patient_id: string | null; visit_id: string | null; run_id: string; goal: string;
  state: TaskState; reason: string | null; actions: Map<string, EmrAction>; order: string[];
  lines: EmrLine[]; questions: EmrQuestion[]; notes: { id: string; text: string; at: string }[]; refusals: EmrRefusal[];
  calls: number; usd: number; fallbacks: number; created_at: string; updated_at: string;
  watch: Record<string, string | null> | null; changes: WatchChange[]; offered: string[]; pages: InboxPage[];
  pause: EmrPause | null; digests: { line_id: string | null; text: string; at: string }[];
  ears: EarsRecord[];
  version: EmrVersionView | null;
  obligations: EmrObligation[]; speed: SpeedRow[];
  // Spoken identities held for the front desk, and whether the patient is still unnamed.
  identities: EmrIdentityHold[]; unidentified: boolean; label: string;
  // Work this owner's agent handed on or was handed, each state as the record showed it.
  delegations: EmrDelegation[];
  prefs: { applied: PrefUse[]; withheld: PrefUse[]; candidates: string[] };
};
// The strip's view of one task.
export type EmrTaskView = {
  task_id: string; goal: string; state: TaskState; reason: string | null; owner: string; admission_id: string; patient_id: string | null; visit_id: string | null;
  actions: {
    action_id: string; kind: string; state: EmrActionState; summary: string; reason: string | null; corrects_action_id: string | null;
    line_id: string; args: Record<string, unknown>; proposed_at: string; written_at: string | null;
    proof?: { record_id: string; record_version: number; event_ids: string[] };
    report?: string; draft?: string; unverified?: true; awaiting?: "owner_voice" | "confirm"; authorised_by_line?: string;
    // The page the strip opens and fills for this action; command_id and owner_id bind it through navigation.
    screen?: ScreenPlan & { command_id: string; owner_id: string };
  }[];
  questions: { question_id: string; text: string; answers?: string[] }[];
  transcript: { id: string; line_id: string; text: string; at: string; source: "text" | "audio"; decided: boolean; class: SpeechClass | null; classes: SpeechClass[]; kept: boolean; ambient?: AmbientMeta; speaker?: SpeakerRecord }[];
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
  version: EmrVersionView | null;
  // Held work with its time or condition, and the speed of every verified action with the errors beside it.
  obligations: EmrObligation[];
  speed: { rows: SpeedRow[]; p50_ms: number | null; p90_ms: number | null; by_kind: Record<string, { n: number; p50_ms: number | null; p90_ms: number | null }>; errors: { failed: number; refused: number; unverified: number } };
  identities: EmrIdentityHold[]; unidentified: boolean;
  delegations: EmrDelegation[];
  // Every preference applied in this task and every one withheld, each with its source and scope.
  preferences: { applied: PrefUse[]; withheld: PrefUse[]; candidates: string[] };
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
  // The adopted version's watch and offer rules with the monitor; without it no version offer is made.
  versions?: VersionWiring;
  // How often held work is checked for its time or condition; the runtime's own timer, since nothing else calls it.
  obligationTickMs?: number;
  // The speed levers in force; each is off unless named, so a recorded run replays as it was made.
  speed?: Partial<SpeedLevers>;
  wallNow?: () => Date;
  log?: (line: string) => void;
  // Called when the agent moves to the patient the clinician is with: a spoken name or an arrival it opened.
  onSubject?: (owner: string, target: EmrTarget, by: "spoken" | "emergency" | "delegation", at?: string) => void;
  // Called when an arrival the agent was asked to open ends refused or failed, so speech held for it can be released.
  onArrivalFailed?: (owner: string, taskId: string, reason: string) => void;
  // The A&E clinic a spoken emergency opens its arrival on.
  emergencyClinicId?: string;
  // The clinicians' remembered preferences; without it no preference is kept or applied.
  preferences?: PreferenceMemory;
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
      watch: null, changes: [], offered: [], pages: [], pause: null, digests: [], ears: [], version: null, obligations: [], speed: [],
      identities: [], unidentified: !!x["unidentified"], label: String(x["label"] ?? ""), delegations: [], prefs: { applied: [], withheld: [], candidates: [] }
    };
  }
  if (!t) return null;
  t.updated_at = e.wall_at;
  const act = t.actions.get(String(x["action_id"]));
  switch (e.record_type) {
    case "utterance.heard": {
      const ambient = (x["ambient"] as AmbientMeta | undefined) ?? null;
      const text = String(x["text"]);
      t.lines.push({ id: String(x["line_id"]), text, at: String(x["spoken_at"]), source: x["source"] === "audio" ? "audio" : "text", decided: false, ambient, classes: [], kept: !x["withheld"], words: Number(x["words"] ?? text.split(/\s+/).filter(Boolean).length), speaker: null });
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
    case "question.asked": t.questions.push({ question_id: String(x["question_id"]), text: String(x["text"]), line_id: String(x["line_id"]), answered_by: null, at: e.wall_at, choice: (x["choice"] as QuestionChoice | undefined) ?? null, rule: (x["rule"] as OrderRule | undefined) ?? null, pref_id: (x["pref_id"] as string | undefined) ?? null }); break;
    case "speaker.attributed": { const l = t.lines.find((y) => y.id === x["line_id"]); if (l) l.speaker = x["speaker"] as SpeakerRecord; break; }
    case "action.authorised": if (act) { act.awaiting = x["awaiting"] === "confirm" ? "confirm" : null; if (x["as"] === "confirm") act.confirmed_by_line = String(x["line_id"]); else act.authorised_by_line = String(x["line_id"]); } break;
    case "preference.applied": t.prefs.applied.push({ ...(x as PrefUse), at: e.wall_at }); break;
    case "preference.withheld": t.prefs.withheld.push({ ...(x as PrefUse), at: e.wall_at }); break;
    case "preference.candidate_noted": t.prefs.candidates.push(String(x["pref_id"])); break;
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
    // A second reading or a gate call started early that no decision used is still paid for.
    case "ears.unused": case "gate.unused": t.calls += Number(x["calls"] ?? 0); t.usd += Number(x["cost_usd"] ?? 0); break;
    case "task.note": t.notes.push({ id: String(x["note_id"]), text: String(x["text"]), at: e.wall_at }); break;
    case "action.proposed":
      t.actions.set(String(x["action_id"]), {
        action_id: String(x["action_id"]), kind: String(x["kind"] ?? OBSERVATION_KIND), args: x["args"] as WorkArgs, summary: String(x["summary"]), line_id: String(x["line_id"]),
        corrects_action_id: (x["corrects_action_id"] as string | null) ?? null, state: "proposed", intent_key: null, written: null, proof: null, reason: null,
        proposed_at: e.wall_at, written_at: null, completed_at: null, report: null, draft: null, unverified: false, ears: !!x["ears"],
        awaiting: (x["awaiting"] as EmrAction["awaiting"] | undefined) ?? null, authorised_by_line: (x["authorised_by_line"] as string | null | undefined) ?? null, confirmed_by_line: null,
        screen: (x["screen"] as ScreenPlan | undefined) ?? null, read_back: null
      });
      t.order.push(String(x["action_id"]));
      break;
    case "action.read_back": if (act) act.read_back = x["read_back"] as PaperworkReadBack; break;
    case "action.intent": if (act) { act.state = "sent"; act.intent_key = String(x["intent_key"]); if (x["args"]) act.args = x["args"] as WorkArgs; } break;
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
    case "version.rules": t.version = { version: Number(x["version"]), definition_hash: String(x["definition_hash"]), offers: (x["offers"] as string[]) ?? [], lines: (x["lines"] as string[]) ?? [], blocked: [] }; break;
    case "version.check_failed": {
      t.offered.push(String(x["offer"]));
      t.version?.blocked.push({ offer: String(x["offer"]), requirement_version: String(x["requirement_version"]), conflict: String(x["conflict"]) });
      break;
    }
    case "page.received": t.pages.push(x["page"] as InboxPage); break;
    case "task.subject": t.patient_id = (x["patient_id"] as string | null) ?? t.patient_id; t.visit_id = (x["visit_id"] as string | null) ?? t.visit_id; t.unidentified = x["unidentified"] === undefined ? t.unidentified : !!x["unidentified"]; break;
    case "identity.held": t.identities.push(x["identity"] as EmrIdentityHold); break;
    case "obligation.held":
      t.obligations.push({
        obligation_id: String(x["obligation_id"]), line_id: String(x["line_id"]), kind: String(x["kind"]), clause: (x["clause"] as Record<string, unknown>) ?? {}, title: String(x["title"] ?? ""),
        due_at: (x["due_at"] as string | null) ?? null, after: (x["after"] as EmrObligation["after"]) ?? null, state: "held", held_at: e.wall_at,
        fired_at: null, fired_by: null, action_id: null, anchor_action_id: null, reason: String(x["reason"] ?? "")
      });
      break;
    case "obligation.anchored": { const o = t.obligations.find((y) => y.obligation_id === x["obligation_id"]); if (o) o.anchor_action_id = String(x["action_id"]); break; }
    case "obligation.fired": { const o = t.obligations.find((y) => y.obligation_id === x["obligation_id"]); if (o) { o.state = "fired"; o.fired_at = e.wall_at; o.fired_by = String(x["by"]); } break; }
    case "obligation.done": { const o = t.obligations.find((y) => y.obligation_id === x["obligation_id"]); if (o) { o.state = "done"; o.action_id = (x["action_id"] as string | null) ?? null; } break; }
    case "obligation.cancelled": { const o = t.obligations.find((y) => y.obligation_id === x["obligation_id"]); if (o) o.state = "cancelled"; break; }
    case "speed.logged": t.speed.push(x["row"] as SpeedRow); break;
    case "delegation.made": case "delegation.received": t.delegations.push(x["delegation"] as EmrDelegation); break;
    case "delegation.state": {
      const d = t.delegations.find((y) => y.key === x["key"]);
      if (d) for (const k of ["delegation_id", "assigned_at", "acknowledged_at", "completed_at", "escalated_at", "record_id", "ward_review", "asked", "asked_line", "waiting", "prepared_seen"] as const) if (x[k] !== undefined) (d as Record<string, unknown>)[k] = x[k];
      break;
    }
    case "delegation.details": {
      const d = t.delegations.find((y) => y.key === x["key"]);
      if (d?.registration) { if (x["phone"]) d.registration.phone = String(x["phone"]); if (x["consent_line"]) d.registration.consent_line = String(x["consent_line"]); }
      break;
    }
    case "identity.closed": { const o = t.identities.find((y) => y.obligation_id === x["obligation_id"]); if (o) o.state = "done"; break; }
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
      ...(a.report ? { report: a.report } : {}), ...(a.draft ? { draft: a.draft } : {}), ...(a.unverified ? { unverified: true as const } : {}), ...(a.awaiting ? { awaiting: a.awaiting } : {}),
      ...(a.authorised_by_line && a.authorised_by_line !== a.line_id ? { authorised_by_line: a.authorised_by_line } : {}),
      ...(a.screen ? { screen: { ...a.screen, encounter: { patient_id: a.screen.encounter.patient_id ?? t.patient_id, visit_id: a.screen.encounter.visit_id ?? t.visit_id, admission_id: a.screen.encounter.admission_id ?? (t.admission_id || null) }, command_id: a.action_id, owner_id: t.owner } } : {})
    })),
    questions: t.questions.filter((q) => q.answered_by === null).map((q) => ({ question_id: q.question_id, text: q.text, ...(q.choice ? { answers: answersOf(q.choice) } : q.pref_id ? { answers: [...SCOPE_KINDS, "no"] } : {}) })),
    transcript: t.lines.map((l) => ({ id: l.id, line_id: l.id, text: l.kept ? l.text : "", at: l.at, source: l.source, decided: l.decided, class: primaryClass(l.classes) as SpeechClass | null, classes: l.classes, kept: l.kept, ...(l.ambient ? { ambient: l.kept ? l.ambient : { ...l.ambient, raw_text: "" } } : {}), ...(l.speaker ? { speaker: l.speaker } : {}) })),
    heard: { lines: t.lines.length, kept: t.lines.filter((l) => l.kept).length, dropped: t.lines.filter((l) => !l.kept && l.decided).length },
    ears: earsSummary(t.ears),
    notes: t.notes,
    asked: t.questions.map((q) => ({ question_id: q.question_id, text: q.text, line_id: q.line_id, answered_by: q.answered_by, at: q.at })),
    refusals: t.refusals, watching: t.watch, changes: t.changes, pages: t.pages, pause: t.pause, digests: t.digests,
    calls: t.calls, usd: Math.round(t.usd * 1e6) / 1e6, version: t.version,
    obligations: t.obligations, speed: speedSummary(t), identities: t.identities, unidentified: t.unidentified, delegations: t.delegations,
    preferences: { applied: t.prefs.applied, withheld: t.prefs.withheld, candidates: t.prefs.candidates },
    updated_at: t.updated_at
  };
}

// The nearest-rank percentile of a list of durations, or null when there are none.
export function percentile(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}
// p50 and p90 from the end of the words to the verified record, per kind and in all, with the actions that did not verify beside them.
export function speedSummary(t: EmrTask): EmrTaskView["speed"] {
  const kinds = [...new Set(t.speed.map((r) => r.kind))];
  const acts = [...t.actions.values()];
  return {
    rows: t.speed, p50_ms: percentile(t.speed.map((r) => r.ms), 50), p90_ms: percentile(t.speed.map((r) => r.ms), 90),
    by_kind: Object.fromEntries(kinds.map((k) => { const ms = t.speed.filter((r) => r.kind === k).map((r) => r.ms); return [k, { n: ms.length, p50_ms: percentile(ms, 50), p90_ms: percentile(ms, 90) }]; })),
    errors: { failed: acts.filter((a) => a.state === "failed").length, refused: acts.filter((a) => a.state === "refused").length, unverified: acts.filter((a) => a.unverified).length }
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
export function mergeInstructions(clauses: readonly AnyClause[], floor: number, kinds: readonly string[]): AnyClause[] {
  const joinable = (c: AnyClause) => c.class === "instruction" && !!c.kind && kinds.includes(c.kind) && MERGEABLE.has(c.kind) && (c.confidence ?? 0) >= floor;
  const out: AnyClause[] = [];
  const merged = new Map<string, AnyClause>();
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
export function oneUnclear(clauses: readonly AnyClause[]): AnyClause[] {
  const unclear = clauses.filter((c) => c.class === "unclear");
  if (unclear.length < 2) return [...clauses];
  const first = unclear[0]!;
  const one: AnyClause = { ...first, words: unclear.map((c) => c.words).join(" ").slice(0, 400), question: unclear.find((c) => c.question)?.question ?? null };
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
// "Sign everything" asks for the read-back of the owner's voice orders awaiting countersign; the yes that follows signs that batch.
export const SIGN_EVERYTHING = /^(?:(?:ok(?:ay)?|right|now|and)\s+)?(?:please\s+)?(?:countersign|sign)\s+(?:everything|it all|them all|all of (?:it|them)|all (?:the )?(?:voice )?orders|the orders)(?:\s+please)?$/;
// Work that needs the owner's explicit spoken confirmation of what was read back from the record (R-3).
export const CONFIRM_KINDS: ReadonlySet<string> = new Set(["release_home"]);

// The discharge read-back the owner confirms: prescribed and dispensed kept apart, exceptions named for the responsible doctor.
export function paperworkAsk(summary: string, rb: PaperworkReadBack): string {
  const meds = rb.dispensed.length ? `Medicines from the dispense record: ${rb.dispensed.join(", ")}.` : "No medicine was dispensed.";
  const ex = rb.exceptions.length ? ` For you to confirm against dispensing: ${rb.exceptions.join("; ")}.` : "";
  const tests = rb.tests.total ? ` Tests: ${rb.tests.resulted} of ${rb.tests.total} resulted; the rest are not billed.` : "";
  return `${summary}. Diagnosis from the record: ${rb.diagnosis}. ${meds}${ex}${tests} Say confirm to discharge.`.slice(0, 1200);
}

export const PAY_LINK_VERIFIED_NOTE = "Pay link request verified: the bill shows it recorded. This does not show that an SMS arrived or that anyone paid; payment is simulated.";

export const OWNER_YES = /^(?:yes|yeah|yes please|yes sign(?: them| it| everything)?|sign(?: them| it)?|go ahead|send it|do it|confirm(?:ed)?|i confirm|yes confirm)$/;
export const OWNER_NO = /^(?:no|nope|don'?t|do not|cancel(?: it| that)?|leave it)$/;
export const SPOKEN_RESUME = /\bwhere were we\b|\b(?:let'?s|we can) (?:carry on|continue|pick (?:this|it|that) (?:back )?up)\b|^(?:ok(?:ay)?,?\s+)?i'?m back\b/i;

// One open task: its decision queue, its write chain, the gate calls started before their turn, and the context each gated line was said in.
type Live = {
  stream: Stream; task: EmrTask; queue: Promise<void>; writes: Promise<void>; inflight: number; pre: Map<string, Promise<GateResult>>; ctxOf: Map<string, EmrContext>; calling: string | null;
  // Decisions started for a line still waiting at a number cut, by listening session and words.
  spec: Map<string, { gate: Promise<GateResult>; ear: EarlyEar | null }>;
};
// When a line reached each step, in memory only, for the speed rows.
type LineTimes = { asr_at?: number; delivered?: number; gate_start?: number; gate_end?: number; ear_done?: number };
type EarlyEar = { p: Promise<{ reading: EarReading | null; error: string | null }>; uses: number };
type AnyClause = Omit<GateClause, "class"> & { class: SpeechClass } & Partial<Omit<OrderClause, keyof GateClause>>;
const RELATIVE_WORDS = /\b(mother|mum|mom|father|dad|husband|wife|son|daughter|sister|brother|relative|family|aunt|uncle|guardian|grandmother|grandfather)\b/i;
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
  // When the words came back from speech recognition, for the speed rows; never stored.
  heard_at?: number;
  // The segment's voiceprint from the local speaker model, matched by the hospital while the gate reads the words.
  voiceprint?: Voiceprint | null;
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
  // The runtime's own clock for held work, and the obligations already queued to fire.
  private obTick: NodeJS.Timeout | null = null;
  private readonly firing = new Set<string>();
  // The levers in force, the line whose clauses are being applied now, second readings started with the gate, timings, and side work to wait for.
  private readonly lv: SpeedLevers;
  private fresh: string | null = null;
  private readonly early = new Map<string, EarlyEar>();
  private readonly times = new Map<string, LineTimes>();
  private readonly side = new Set<Promise<unknown>>();
  private readonly gateStage = new Map<string, string>();
  private readonly holdEnds = new Map<string, string>();
  // Each line's speaker match while it is in flight, and the owner's match tokens, in memory only and never journaled.
  private readonly speakers = new Map<string, Promise<{ v: SpeakerVerdict; embed_ms: number | null; match_ms: number | null }>>();
  private readonly tokens = new Map<string, string>();
  // The second reading of a spoken dose, per prescription action, compared before the write.
  private readonly doseChecks = new Map<string, Promise<{ agree: boolean; heard: string | null; error: string | null; reading: EarReading | null }>>();
  private readonly doseEars = new Map<string, Promise<{ reading: EarReading | null; error: string | null }>>();
  // Review obligations already checked for a team to hand them to, so the sweep asks once per obligation.
  private readonly reviewTried = new Set<string>();
  // Tasks handed on elsewhere are followed only when made from shortly before this runtime started, so old leftovers are never taken up.
  private readonly startedAt = Date.now();
  // The last ward each task's context named, for preferences scoped to a ward.
  private readonly wards = new Map<string, string>();

  constructor(private readonly o: EmrRuntimeOptions) { this.lv = { ...LEVERS_OFF, ...(o.speed ?? {}) }; }
  get levers(): SpeedLevers { return { ...this.lv }; }

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

  private liveOf(stream: Stream): Live {
    return { stream, task: projectEmr(stream.records()), queue: Promise.resolve(), writes: Promise.resolve(), inflight: 0, pre: new Map(), ctxOf: new Map(), calling: null, spec: new Map() };
  }
  private timesOf(lineId: string): LineTimes {
    let x = this.times.get(lineId);
    if (!x) { x = {}; this.times.set(lineId, x); if (this.times.size > 2000) this.times.delete(this.times.keys().next().value!); }
    return x;
  }
  // Side work, such as a second reading nobody used yet, that settled and stop wait for.
  private track<T>(p: Promise<T>): Promise<T> {
    const q = p.finally(() => this.side.delete(q));
    q.catch(() => undefined);
    this.side.add(q);
    return p;
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
      const l: Live = this.liveOf(stream);
      this.live.set(id, l);
      if (CLOSED_TASK.has(l.task.state)) continue;
      for (const aid of l.task.order) {
        const a = l.task.actions.get(aid)!;
        if (a.state === "sent" || (a.state === "acknowledged" && !a.unverified)) this.enqueueExec(l, () => this.execute(l, aid));
        else if (a.state === "proposed" && l.task.state === "running") this.hold(l, aid);
      }
      if (l.task.state === "running" && l.task.lines.some((x) => !x.decided)) {
        for (const x of l.task.lines.filter((y) => !y.decided)) this.append(l, "intent.failed", { line_id: x.id, reason: "restarted_before_decision" });
        this.settle(l, "restarted_before_decision");
      }
    }
    if (this.o.watchMs && this.o.watchMs > 0 && (this.o.port.watch || this.o.port.inbox || this.o.port.delegations) && !this.poller) {
      this.poller = setInterval(() => { void this.pollOnce(); }, this.o.watchMs);
    }
    this.sweepObligations();
    if (!this.obTick) { this.obTick = setInterval(() => this.sweepObligations(), this.o.obligationTickMs ?? 1000); this.obTick.unref(); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    if (this.obTick) clearInterval(this.obTick);
    this.obTick = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await Promise.all([...this.live.values()].flatMap((l) => [l.queue, l.writes]));
    await Promise.all([...this.side]);
    for (const l of this.live.values()) l.stream.close();
    this.live.clear();
  }

  // Resolves when every queue is drained and no hold timer is pending.
  async settled(timeoutMs = 60_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      // A hold timer may fire while an earlier write waits, so the queues are read again after the wait and must not have moved.
      const seen = [...this.live.values()].flatMap((l) => [l.queue, l.writes]);
      await Promise.all(seen);
      await Promise.all([...this.side]);
      const now = [...this.live.values()].flatMap((l) => [l.queue, l.writes]);
      const moved = now.length !== seen.length || now.some((p, i) => p !== seen[i]);
      if (!moved && this.timers.size === 0 && [...this.live.values()].every((l) => l.inflight === 0)) return;
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

  // A write and its proof go on the task's write chain under lever 3, so decisions of later lines never wait behind them; otherwise on the one queue.
  private enqueueExec(l: Live, fn: () => Promise<void>): void {
    if (!this.lv.proofBeside) return this.enqueue(l, fn);
    l.writes = l.writes.then(fn).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`emr task ${l.task.task_id} write error: ${msg}`);
      try { this.setState(l, "failed", `runtime_error: ${msg.slice(0, 200)}`); } catch { /* the stream may be closed during shutdown */ }
    });
  }

  private nextLineId(owner: string, text: string): string {
    this.lineCounter += 1;
    return `u-${shortHash(owner, text, this.wall().toISOString(), this.lineCounter, process.pid)}`;
  }

  private openTask(owner: string, ctx: EmrContext, extra: Record<string, unknown> = {}): Live {
    const n = listStreams(this.o.storeRoot, "emr").length;
    const id = `t-${shortHash(owner, ctx.admission_id, n, this.wall().toISOString(), ...(extra["entry"] ? [String(extra["entry"])] : []))}`;
    const stream = openStream(this.o.storeRoot, `emr/${id}`, { writer: true });
    stream.append("emr.task.opened", { task_id: id, owner, admission_id: ctx.admission_id, patient_id: ctx.patient_id, ...(ctx.visit_id ? { visit_id: ctx.visit_id } : {}), run_id: `run-${shortHash(id, "run")}`, label: ctx.label.slice(0, 120), ...extra }, Z);
    const l: Live = this.liveOf(stream);
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
    // A spoken acceptance or the front desk's registration details reach the task handed to this owner, by rule and before any read.
    if (!taskId) { const d = this.delegationLine(s.owner, text, s.spoken_at ?? this.wall().toISOString(), s.source ?? "text", s.target); if (d) return d; }
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
      // "hey Pisgah, emergency" heard in a transcript opens an arrival, unless the device already did within the last ten seconds.
      if (EMERGENCY_LINE.test(text) && this.kinds(s.owner).includes(EMERGENCY_KIND)) {
        const recent = [...this.live.values()].some((x) => x.task.owner === s.owner && x.task.unidentified && Date.now() - Date.parse(x.task.created_at) < 10_000);
        if (!recent) {
          const r = await this.emergency(s.owner, { text, spoken_at: s.ambient?.ended_at ?? spokenAt, source: s.source ?? "text", args: { unidentified_ref: unidentifiedRef(new Date(spokenAt)), reason: emergencyReason(text), ...(this.o.emergencyClinicId ? { clinic_id: this.o.emergencyClinicId } : {}) } });
          return { task_id: r.task_id, line_id: r.line_id };
        }
      }
      // A line naming another of the owner's open patients moves the agent to that patient, never silently stopping.
      const known = [...this.live.values()].map((x) => x.task).filter((t) => t.owner === s.owner && !CLOSED_TASK.has(t.state) && t.label && (t.admission_id || t.patient_id))
        .map((t) => ({ label: t.label, target: t.admission_id ? { admission_id: t.admission_id } : { patient_id: t.patient_id! } }));
      const moved = spokenPatient(text, known);
      const target = moved && JSON.stringify(moved.target) !== JSON.stringify(s.target) ? moved.target : s.target;
      if (target !== s.target) this.o.onSubject?.(s.owner, target, "spoken", spokenAt);
      ctx = target === s.target && s.context && s.context.admission_id === s.target.admission_id ? s.context : await this.o.port.resolve(target, prov);
      l = this.taskFor(s.owner, ctx) ?? this.openTask(s.owner, ctx);
    }
    if (CLOSED_TASK.has(l.task.state)) throw new Error(`the task is ${l.task.state}`);
    const live = l;
    if (ctx.facts["ward"]) this.wards.set(live.task.task_id, ctx.facts["ward"]);
    const viaGate = !!s.ambient || s.via === "gate" || (s.via !== "intent" && isWide(this.kinds(s.owner)));
    // Ambient words reach the store only once an action or a question rests on them; until then they live in memory.
    const withhold = !!s.ambient && !this.o.keepHeard;
    const stored = withhold ? { text: "", withheld: true, words: text.split(/\s+/).filter(Boolean).length, ambient: { ...s.ambient!, raw_text: "" } } : { text, ...(s.ambient ? { ambient: s.ambient } : {}) };
    this.append(live, "utterance.heard", { line_id: lineId, ...stored, source: s.source ?? "text", spoken_at: spokenAt, ...(s.audio ? { audio: s.audio } : {}), ...(viaGate && !s.ambient ? { via: "gate" } : {}) });
    if (withhold) { const ln = live.task.lines.find((x) => x.id === lineId)!; ln.text = text; ln.ambient = { ...s.ambient! }; }
    if (s.clip && this.o.secondEar) this.clips.set(lineId, { wav: s.clip, guessed: new Set((s.rewrites ?? []).filter((r) => r.guessed && r.measure).map((r) => r.measure!)) });
    const spec = s.ambient ? this.takeSpeculation(live, s.ambient.session_id, text, lineId) : false;
    const tm = this.timesOf(lineId);
    tm.delivered = Date.now();
    if (s.heard_at !== undefined) tm.asr_at = s.heard_at;
    // Lever 4: the second reading starts now, beside the gate, when the line names a measure and a number.
    if (!spec && s.clip && this.o.secondEar && this.lv.earWithGate && willWriteNumber(text)) this.earEarly(live, lineId, s.clip);
    // A line that says a dose has its second reading started now too, beside the gate, for the prescription it may become.
    if (s.clip && this.o.secondEar && this.lv.earWithGate && saysDose(text) && this.kinds(s.owner).includes("prescribe")) {
      const t0 = live.task;
      const p = this.o.secondEar(s.clip, { run_id: t0.run_id, task_id: t0.task_id, line_id: lineId }).then((reading) => ({ reading, error: null }), (e: unknown) => ({ reading: null, error: e instanceof ModelError ? e.code : "ear_failed" }));
      this.doseEars.set(lineId, this.track(p));
    }
    // The hospital matches the segment's voiceprint while the gate reads the words, so attribution adds no wait of its own.
    const vp = s.voiceprint;
    if (vp && this.o.port.speaker) {
      const t0 = Date.now();
      const fail = (reason: string) => ({ v: { speaker: "unverified", reason } as SpeakerVerdict, embed_ms: vp.ms, match_ms: Date.now() - t0 });
      this.speakers.set(lineId, this.o.port.speaker(s.owner, vp.vector, prov).then((v) => ({ v, embed_ms: vp.ms, match_ms: Date.now() - t0 })).catch(() => fail("match_failed")));
    } else if (s.source === "audio" && this.o.port.speaker) {
      this.speakers.set(lineId, Promise.resolve({ v: { speaker: "unverified", reason: "no_voiceprint" } as SpeakerVerdict, embed_ms: null, match_ms: null }));
    }
    // A spoken pause or return is handled by rule; while called away nothing heard is decided, so no model is called.
    if (SPOKEN_PAUSE.test(text) && !CLOSED_TASK.has(live.task.state) && live.task.state !== "paused") { this.pauseSpoken(live, lineId, ctx); this.afterLine(live, lineId, true); return { task_id: live.task.task_id, line_id: lineId }; }
    if (live.task.state === "paused" && live.task.reason === "called_away") {
      if (SPOKEN_RESUME.test(text)) this.enqueue(live, async () => { await this.resume(live, lineId, prov); this.afterLine(live, lineId, true); });
      else { this.append(live, "line.handled", { line_id: lineId, as: "heard_while_paused" }); this.afterLine(live, lineId, false); }
      return { task_id: live.task.task_id, line_id: lineId };
    }
    // A spoken name for an unnamed patient is held as an obligation for the front desk, by rule and with no model call.
    const named = live.task.unidentified ? identityFrom(text) : null;
    // The naming line is handled whole by rule; anything else said in it waits for the next line.
    if (named) {
      this.holdIdentity(live, lineId, named.name, named.phone);
      this.afterLine(live, lineId, true);
      this.settle(live, "identity_held");
      return { task_id: live.task.task_id, line_id: lineId };
    }
    // "From now on ..." is read by rule as a candidate preference, with no model call; it fills nothing until its scope is chosen.
    if (this.o.preferences && FROM_NOW_ON.test(text)) {
      this.fromNowOn(live, lineId, text, ctx);
      this.afterLine(live, lineId, true);
      this.settle(live, "preference_candidate");
      return { task_id: live.task.task_id, line_id: lineId };
    }
    if (live.task.state !== "running") this.setState(live, "running", `heard_${lineId}`);
    if (viaGate) live.ctxOf.set(lineId, ctx);
    this.enqueue(live, async () => {
      try {
        if (this.orderRuleApplies(live, lineId) && (await this.orderRule(live, lineId, prov))) return;
        if (!this.answerByRule(live, lineId)) await (viaGate ? this.gate(live, lineId, ctx, prov) : this.decide(live, lineId, ctx, prov));
      } finally { live.ctxOf.delete(lineId); this.afterLine(live, lineId, false); }
    });
    this.pump(live);
    return { task_id: live.task.task_id, line_id: lineId };
  }

  // After a line is decided its audio is let go, and an ambient line's words are stored only when an action or a question rests on them.
  private afterLine(l: Live, lineId: string, keep: boolean): void {
    this.clips.delete(lineId);
    this.dropEarly(l, lineId);
    // A dose reading no prescription used is let go, and its cost is still put on the task.
    const dose = this.doseEars.get(lineId);
    if (dose) {
      this.doseEars.delete(lineId);
      void this.track(dose.then((r) => { if (r.reading && !this.stopped) try { this.append(l, "ears.unused", { line_id: lineId, cost_usd: r.reading.cost_usd, calls: r.reading.calls ?? 1, provider: r.reading.provider, model: r.reading.model }); } catch { /* closed */ } }));
    }
    const pre = l.pre.get(lineId);
    if (pre) { l.pre.delete(lineId); this.chargeUnused(l, lineId, pre); }
    const t = l.task;
    const line = t.lines.find((x) => x.id === lineId);
    if (!line || line.kept) return;
    const rests = keep || t.order.some((id) => t.actions.get(id)!.line_id === lineId) || t.questions.some((q) => q.line_id === lineId || q.answered_by === lineId) || t.obligations.some((o) => o.line_id === lineId);
    if (rests) { this.append(l, "line.kept", { line_id: lineId, text: line.text, raw_text: line.ambient?.raw_text ?? null }); return; }
    line.text = "";
    if (line.ambient) line.ambient.raw_text = "";
  }

  // Starts the second reading of a line's audio as the line arrives; the values to compare come later from the gate.
  private earEarly(l: Live, lineId: string, wav: Uint8Array): void {
    if (!this.o.secondEar || this.early.has(lineId)) return;
    this.early.set(lineId, this.startEar(l, lineId, wav));
  }
  private startEar(l: Live, key: string, wav: Uint8Array): EarlyEar {
    const t = l.task;
    const tm = this.timesOf(key);
    const p = this.track(this.o.secondEar!(wav, { run_id: t.run_id, task_id: t.task_id, line_id: key })
      .then((reading) => ({ reading, error: null }), (e: unknown) => ({ reading: null, error: e instanceof ModelError ? e.code : "ear_failed" }))
      .finally(() => { tm.ear_done = Date.now(); }));
    return { p, uses: 0 };
  }

  // The owner's open task for this context, found without linking anything.
  private findTask(owner: string, ctx: EmrContext): Live | null {
    const open = [...this.live.values()].filter((l) => l.task.owner === owner && !CLOSED_TASK.has(l.task.state));
    const newest = (ls: Live[]) => ls.sort((a, b) => (a.task.created_at < b.task.created_at ? 1 : -1))[0] ?? null;
    return (ctx.admission_id ? newest(open.filter((l) => l.task.admission_id === ctx.admission_id)) : null)
      ?? (ctx.patient_id ? newest(open.filter((l) => l.task.patient_id === ctx.patient_id && (!l.task.admission_id || !ctx.admission_id))) : null);
  }

  // Lever 6: while a line that ends on a number waits for the next chunk, its gate call and second reading start; they are used only if the line is delivered with the same words.
  speculate(s: { owner: string; ctx: EmrContext; session_id: string; text: string; clip?: Uint8Array }): boolean {
    if (!this.lv.decideWhileJoining || this.stopped) return false;
    const text = s.text.trim().slice(0, 1000);
    const l = this.findTask(s.owner, s.ctx);
    if (!l || !text || l.task.state === "paused" || SPOKEN_PAUSE.test(text)) return false;
    const key = `${s.session_id}|${text}`;
    if (l.spec.has(key) || l.inflight >= Math.max(1, this.lv.parallelLines) || !this.mayDecideBeside(l.task, text, l.task.lines.filter((x) => !x.decided))) return false;
    if (l.task.state === "waiting") return false;
    const gate = this.callGate(l, { id: key, text }, s.ctx, true, key);
    gate.catch(() => undefined);
    const ear = s.clip && this.o.secondEar && this.lv.earWithGate ? this.startEar(l, key, s.clip) : null;
    l.spec.set(key, { gate, ear });
    return true;
  }

  // Hands a line its decision started at the cut when its words are the same; any other one of the session was joined into a longer line and is let go.
  private takeSpeculation(l: Live, sessionId: string, text: string, lineId: string): boolean {
    const key = `${sessionId}|${text}`;
    for (const [k, v] of [...l.spec]) {
      if (k === key || !k.startsWith(`${sessionId}|`)) continue;
      l.spec.delete(k);
      this.chargeUnused(l, lineId, v.gate);
      if (v.ear) { this.early.set(`${k}#unused`, v.ear); this.dropEarly(l, `${k}#unused`); }
    }
    const sp = l.spec.get(key);
    if (!sp) return false;
    l.spec.delete(key);
    l.pre.set(lineId, sp.gate);
    const tm = this.times.get(key);
    if (tm) { this.times.delete(key); this.times.set(lineId, tm); }
    if (sp.ear) this.early.set(lineId, sp.ear);
    return true;
  }

  // A second reading no action used is let go, and its cost is still put on the task.
  private dropEarly(l: Live, lineId: string): void {
    const e = this.early.get(lineId);
    if (!e) return;
    this.early.delete(lineId);
    if (e.uses > 0) return;
    void this.track(e.p.then((r) => {
      if (!r.reading || this.stopped) return;
      try { this.append(l, "ears.unused", { line_id: lineId, cost_usd: r.reading.cost_usd, calls: r.reading.calls ?? 1, provider: r.reading.provider, model: r.reading.model }); } catch { /* closed */ }
    }));
  }

  // A gate call started early whose answer no decision used is still put on the task.
  private chargeUnused(l: Live, lineId: string, p: Promise<GateResult>): void {
    void this.track(p.then((r) => {
      if (this.stopped) return;
      try { this.append(l, "gate.unused", { line_id: lineId, cost_usd: r.cost_usd, calls: r.calls ?? 1 + r.repairs, model: r.model }); } catch { /* closed */ }
    }, () => undefined));
  }

  // True when a short answer to the open choice would settle this line by rule, so no gate call should start for it.
  private answersByRule(t: EmrTask, text: string): boolean {
    const q = t.questions.filter((y) => y.answered_by === null).at(-1);
    return !!q?.choice && answerChoice(text, q.choice) !== null;
  }

  // Lever 5: starts the gate call early for lines still waiting their turn, up to the lever's count, when no earlier undecided line names a measure they name.
  private pump(l: Live): void {
    if (this.lv.parallelLines <= 1 || this.stopped) return;
    const t = l.task;
    if (CLOSED_TASK.has(t.state) || t.state === "paused") return;
    const waiting = t.lines.filter((x) => !x.decided);
    for (const [i, line] of waiting.entries()) {
      if (l.inflight >= this.lv.parallelLines) return;
      const ctx = l.ctxOf.get(line.id);
      if (!ctx || l.pre.has(line.id) || l.calling === line.id || !this.mayDecideBeside(t, line.text, waiting.slice(0, i))) continue;
      const p = this.callGate(l, line, ctx, true);
      p.catch(() => undefined);
      l.pre.set(line.id, p);
    }
  }

  // A line may be decided beside earlier undecided lines only when it names a measure, none of them names it too, and no rule answer would settle it.
  private mayDecideBeside(t: EmrTask, text: string, earlier: readonly EmrLine[]): boolean {
    if (!willWriteNumber(text) || this.answersByRule(t, text)) return false;
    return earlier.every((e) => sharedMeasures(e.text, text).length === 0);
  }

  // The gate input for a line as the task stands now; a call started before its turn leaves undecided lines out of the recent words.
  private gateInput(t: EmrTask, line: { id: string; text: string }, ctx: EmrContext, early: boolean): GateInput {
    const kinds = this.kinds(t.owner).filter((k) => !RULE_ONLY_KINDS.has(k) && !DELEGATION_RULE_KINDS.has(k));
    const openQ = t.questions.filter((q) => q.answered_by === null).at(-1) ?? null;
    const wide = isWide(kinds);
    const names = wide ? this.o.port.names?.() : undefined;
    const at = t.lines.findIndex((x) => x.id === line.id);
    return {
      kinds, context: ctx, actions: this.gateActions(t), openQuestion: openQ?.text ?? null,
      recent: t.lines.slice(0, at < 0 ? t.lines.length : at).filter((x) => x.text && (!early || x.decided)).slice(-6).map((x) => x.text), said: line.text,
      ...(wide ? { today: this.wall().toISOString().slice(0, 10), ...(names ? { names } : {}) } : {})
    };
  }

  // One gate call for a line: the two-stage gate under lever 2 for a clerking owner, else the gate as committed.
  private callGate(l: Live, line: { id: string; text: string }, ctx: EmrContext, early: boolean, timesKey = line.id): Promise<GateResult> {
    const t = l.task;
    const input = this.gateInput(t, line, ctx, early);
    const settings = this.o.gate ?? GATE_SETTINGS;
    const tm = this.timesOf(timesKey);
    tm.gate_start ??= Date.now();
    l.inflight += 1;
    const call = this.lv.firstStage && holdsClerking(input.kinds) ? gateTwoStage : gateUtterance;
    const p = call(this.o.client, input, { run_id: t.run_id, task_id: t.task_id }, settings);
    // The bookkeeping hangs off the call rather than wrapping it, so an awaited call answers as soon as it did before.
    const done = () => { l.inflight -= 1; tm.gate_end = Date.now(); this.pump(l); };
    p.then(done, done);
    return p;
  }

  // A short answer to the latest open choice ("88", "yes", "no") settles it by rule with no model call; anything else goes to the gate.
  private answerByRule(l: Live, lineId: string): boolean {
    const t = l.task;
    const line = t.lines.find((x) => x.id === lineId);
    if (!line || line.decided || t.state !== "running") return false;
    if (this.scopeByWord(l, lineId, line)) return true;
    const q = t.questions.filter((y) => y.answered_by === null || y.answered_by === lineId).at(-1);
    if (!q?.choice || Date.parse(line.at) - Date.parse(q.at) > (this.o.answerWindowMs ?? 120_000)) return false;
    const a = answerChoice(line.text, q.choice);
    if (!a) return false;
    if (q.answered_by === null) this.append(l, "question.answered", { question_id: q.question_id, line_id: lineId });
    this.append(l, "line.ruled", { line_id: lineId, classes: ["instruction"], as: "answer", question_id: q.question_id });
    if (a === "no") { this.note(l, "Left it unwritten, as you said."); this.settle(l, "answered_no"); return true; }
    this.fresh = lineId;
    try { return this.applyAnswer(l, lineId, line, a, q.choice); } finally { this.fresh = null; }
  }

  private applyAnswer(l: Live, lineId: string, line: EmrLine, a: Record<string, string>, c: QuestionChoice): boolean {
    const t = l.task;
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
    if (this.speakers.has(lineId)) await this.attribute(l, lineId);
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
    // A call started before this line's turn is used when it answered; one that failed is made again now, in order.
    const pre = l.pre.get(lineId);
    l.pre.delete(lineId);
    // Only a line with a voiceprint waits on its match, so lines without one are decided exactly as before.
    const who = this.speakers.has(lineId) ? this.attribute(l, lineId) : null;
    let r: GateResult;
    l.calling = lineId;
    try {
      r = pre ? await pre.catch(() => this.callGate(l, line, ctx, false)) : await this.callGate(l, line, ctx, false);
    } catch (e) {
      if (who) await who;
      const code = e instanceof ModelError ? e.code : "error";
      this.append(l, "intent.failed", { line_id: lineId, reason: `model_${code}` });
      if (l.task.state === "running") this.setState(l, "needs_input", `model_${code}`);
      return;
    } finally { l.calling = null; }
    if (who) await who;
    // A clause is applied only when its words come from this line; the model sometimes classes the recent words it was shown again.
    const all = r.value.clauses as AnyClause[];
    const clauses = all.filter((c) => fromLine(c.words, line.text));
    const outside = all.filter((c) => !fromLine(c.words, line.text));
    // A withheld line's clause words stay out of the store too; only the classes and values are kept.
    const bare = (cs: readonly AnyClause[]) => (line.kept ? cs : cs.map(({ words, ...c }) => ({ ...c, words: "", word_count: words.split(/\s+/).filter(Boolean).length })));
    this.append(l, "gate.decided", {
      line_id: lineId, clauses: bare(clauses), ...(outside.length ? { outside_line: bare(outside) } : {}), provider: r.provider, model: r.model, response_id: r.response_id, ledger: r.ledger, cost_usd: r.cost_usd,
      calls: r.calls ?? 1 + r.repairs, repairs: r.repairs, fallback_reason: r.fallback_reason, prompt_sha256: r.prompt_sha256,
      ...(r.stage ? { stage: r.stage, first_look: r.first_look ?? null, stage_ms: r.stage_ms ?? null } : {}), ...(pre ? { started_early: true } : {})
    });
    this.gateStage.set(lineId, r.stage ?? "full");
    if (l.task.state !== "running") return;
    // Words meant for the agent answer its open question before they are acted on.
    if (clauses.some((c) => c.class === "instruction" || c.class === "correction")) {
      for (const q of t.questions.filter((y) => y.answered_by === null)) this.append(l, "question.answered", { question_id: q.question_id, line_id: lineId });
    }
    this.fresh = lineId;
    try {
      for (const c of oneUnclear(mergeInstructions(clauses, settings.confidence_floor, kinds))) this.applyClause(l, lineId, c, settings.confidence_floor, kinds, prov);
    } finally { this.fresh = null; }
    this.settle(l, "heard");
  }

  private applyClause(l: Live, lineId: string, c: AnyClause, floor: number, kinds: readonly string[], prov: Provenance): void {
    const t = l.task;
    const lineText = t.lines.find((x) => x.id === lineId)?.text ?? "";
    // What the patient or a relative said goes only into its own section of the note; no kind it names is ever acted on.
    if (c.class === "patient_reported") {
      if (kinds.includes(CLERKING_KIND) && t.visit_id) this.proposeClerking(l, lineId, "patient_reported", (c.text && fromLine(c.text, lineText) ? c.text : c.words).trim());
      return;
    }
    // A finding said aloud is documentation, written into its section of the clerking note.
    if (c.class === "finding") {
      if (!kinds.includes(CLERKING_KIND)) return;
      if (!t.visit_id) { this.note(l, "Heard a finding, but no arrival is in context, so the note was not written."); return; }
      this.proposeClerking(l, lineId, c.section ?? "history", this.saidBy(t, lineId, (c.text && fromLine(c.text, lineText) ? c.text : c.words).trim()));
      return;
    }
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
    // Work for a later time or a record event is held as an obligation; the clinician is never asked to say it again.
    if (c.class === "instruction" && c.kind && (c.in_minutes != null || c.after != null || c.kind === "schedule_review")) return this.holdLater(l, lineId, c, c.kind, lineText);
    // Before the admission exists the doctor's spoken vitals go into the clerking note's vitals section.
    if ((c.class === "instruction" || c.class === "correction") && kinds.includes(CLERKING_KIND) && !t.admission_id && t.visit_id && (c.kind === OBSERVATION_KIND || c.class === "correction") && (c.temp_c != null || c.pulse != null || c.resp_rate != null || c.bp != null || c.spo2 != null)) {
      return this.clerkVitals(l, lineId, c, lineText);
    }
    if (c.class === "instruction" && c.kind && c.kind !== OBSERVATION_KIND) return this.applyWork(l, lineId, c, c.kind);
    if (c.class === "correction") {
      const m0 = /^#?(\d+)$/.exec((c.target ?? "").trim());
      const named0 = m0 ? t.order[Number(m0[1]) - 1] : c.target && t.actions.has(c.target) ? c.target : undefined;
      const latest0 = [...t.order].reverse().find((id) => !["cancelled", "refused", "failed"].includes(t.actions.get(id)!.state));
      const target0 = t.actions.get(named0 ?? latest0 ?? "");
      const obsValues = c.temp_c != null || c.pulse != null || c.resp_rate != null || c.bp != null;
      if (target0 && target0.kind !== OBSERVATION_KIND && !obsValues) return this.correctWork(l, lineId, c, target0);
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
  private applyWork(l: Live, lineId: string, c: AnyClause, kind: string, carried: Record<string, unknown> = {}): void {
    const t = l.task;
    const line = t.lines.find((x) => x.id === lineId)?.text ?? "";
    // A value carried over from the entry a correction replaces was said for that entry, so it counts as said.
    const kept = new Set(Object.values(carried).filter((v): v is string => typeof v === "string"));
    const said = (v: string | null | undefined) => (v && (fromLine(v, line) || kept.has(v)) ? v.trim() : null);
    const words = c.words.trim();
    // Work that needs the admission is held until it exists and then resumes itself.
    const needAdmission = () => { if (!t.admission_id) { this.holdObligation(l, lineId, kind, c, { after: "admission", due_at: null, reason: "needs_admission" }); return false; } return true; };
    const needVisit = () => { if (!t.visit_id) { this.ask(l, lineId, "I do not have this patient's arrival in context, so I cannot do that here."); return false; } return true; };
    const nums = new Set((line.match(/\d+(?:\.\d+)?/g) ?? []).map((x) => String(Number(x))));
    const heard = (v: unknown) => v !== null && v !== undefined && String(v).split("/").every((n) => nums.has(String(Number(n))));
    const ids = { ...(t.patient_id ? { patient_id: t.patient_id } : {}) };
    let raw: Record<string, unknown>;
    let own: Record<string, unknown> = {};
    // The preference that filled a value here, journaled against the action once it is proposed.
    const pref: { use: PrefUse | null } = { use: null };
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
        const itemKind = c.item_kind ?? "nursing";
        // A cadence the clinician did not say may come from a remembered preference whose scope covers this patient, shown with its source.
        const cadence = c.cadence && cadenceSaid(c.cadence, line) ? c.cadence : this.preferred(l, lineId, "care_plan_cadence", itemKind, pref);
        if (!cadence) return this.ask(l, lineId, `How often should "${(c.title ?? words).slice(0, 80)}" be done?`);
        raw = { admission_id: t.admission_id, title: (said(c.title) ?? words).slice(0, 200), item_kind: itemKind, cadence };
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
        const noteType = c.note_type && wordSaid(c.note_type, line) ? c.note_type : this.preferred(l, lineId, "note_type", null, pref) ?? c.note_type ?? (this.kinds(t.owner).includes("record_triage_vitals") ? "nursing" : "progress");
        raw = { admission_id: t.admission_id, note_type: noteType, text: text ?? words };
        break;
      }
      case "draft_handover": case "prepare_bill": case "send_pay_link": if (!needAdmission()) return; raw = { admission_id: t.admission_id }; break;
      case "release_home": {
        if (!needAdmission()) return;
        const advice = said(c.text);
        raw = { admission_id: t.admission_id, ...(advice ? { instructions: advice.slice(0, 2000) } : {}), ...(c.date && dateSaid(c.date, line) ? { follow_up_date: c.date } : {}) };
        break;
      }
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
      case "record_allergy": {
        if (!t.patient_id) return this.ask(l, lineId, "I do not have this patient in context, so I cannot add the allergy here.");
        if (!c.substance || !(fromLine(c.substance, line) || wordSaid(c.substance, line))) return this.ask(l, lineId, "Which substance is the patient allergic to?");
        const reaction = said(c.reaction);
        raw = { patient_id: t.patient_id, ...(t.visit_id ? { visit_id: t.visit_id } : {}), substance: c.substance.trim(), severity: c.severity && wordSaid(c.severity, line) ? c.severity : "unknown", ...(reaction ? { reaction } : {}), source: RELATIVE_WORDS.test(line) ? "relative" : "patient" };
        break;
      }
      case "admit_patient": {
        if (!needVisit()) return;
        const ward = this.wardSaid(c.ward, line);
        if (!ward) return this.ask(l, lineId, `Which ward should I admit to? I know ${Object.values(this.o.port.names?.().wards ?? {}).map((w) => w[0]).join(", ") || "none"}.`);
        if (!c.admission_type || !wordSaid(c.admission_type, line)) return this.ask(l, lineId, "Is this an emergency or a planned admission?");
        raw = { visit_id: t.visit_id, ...ids, ward, admission_type: c.admission_type, reason: said(c.text) ?? words };
        break;
      }
      case "assign_bed": {
        if (!needAdmission()) return;
        // The ward said for the bed, else the ward this task admitted to, which the clinician named.
        const admitted = [...t.order].reverse().map((id) => t.actions.get(id)!).find((a) => a.kind === "admit_patient" && a.state === "completed");
        const ward = this.wardSaid(c.ward, line) ?? (admitted ? String(admitted.args["ward"]) : null);
        if (!ward) return this.ask(l, lineId, `Which ward should the bed be in? I know ${Object.values(this.o.port.names?.().wards ?? {}).map((w) => w[0]).join(", ") || "none"}.`);
        raw = { admission_id: t.admission_id, ward };
        break;
      }
      case "order_test": {
        if (!needVisit() || !t.patient_id) return;
        const tests = this.o.port.orderables?.().tests ?? {};
        const key = this.orderableSaid(tests, c.test, line);
        if (!key) return this.ask(l, lineId, `Which test should I send? I can send ${Object.values(tests).map((w) => w[0]).join(", ") || "none"}.`);
        raw = { visit_id: t.visit_id, patient_id: t.patient_id, test: key, ...(c.order_priority && wordSaid(c.order_priority, line) ? { priority: c.order_priority } : /\bstat\b/i.test(line) ? { priority: "stat" } : /\burgent(ly)?\b/i.test(line) ? { priority: "urgent" } : {}) };
        break;
      }
      case "prescribe": {
        if (!needVisit() || !t.patient_id) return;
        const drugs = this.o.port.orderables?.().drugs ?? {};
        const key = this.orderableSaid(Object.fromEntries(Object.entries(drugs).map(([k, d]) => [k, d.words])), c.drug, line);
        if (!key) return this.ask(l, lineId, `Which medicine should I prescribe? I can prescribe ${Object.values(drugs).map((d) => d.words[0]).join(", ") || "none"}.`);
        const rx = prescriptionSaid(line, c);
        if (rx.quantity === null) return this.ask(l, lineId, `How many should the pharmacy give for ${drugs[key]!.words[0]}? Say the number.`);
        raw = { visit_id: t.visit_id, patient_id: t.patient_id, drug: key, quantity: rx.quantity, ...(rx.dose ? { dose: rx.dose } : {}), ...(rx.frequency ? { frequency: rx.frequency } : {}), ...(rx.duration_days ? { duration_days: rx.duration_days } : {}), ...(rx.route ? { route: rx.route } : {}) };
        break;
      }
      default: return this.ask(l, lineId, "I cannot do that kind of work here.");
    }
    const schema = WORK_ARGS[kind as Exclude<WorkKind, typeof OBSERVATION_KIND>];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) { this.ask(l, lineId, `I could not use that (${parsed.error.issues[0]?.message ?? "invalid"}). Please say it again.`); return; }
    const before = t.order.length;
    this.propose(l, lineId, kind, parsed.data, null, own);
    if (pref.use && t.order.length > before) {
      this.append(l, "preference.applied", { ...pref.use, action_id: t.order.at(-1)! });
      this.note(l, `${pref.use.text}: used ${pref.use.source}, scope ${pref.use.scope}.`);
    }
  }

  // A correction of other work replaces it while it is still on hold; once written, only a new instruction adds to the record.
  private correctWork(l: Live, lineId: string, c: AnyClause, target: EmrAction): void {
    if (target.state !== "proposed") { this.ask(l, lineId, "That is already in the record and stays as written. Tell me what to add and I will add it."); return; }
    const over = Object.fromEntries(Object.entries(c).filter(([k, v]) => v !== null && v !== undefined && !["words", "class", "kind", "target", "confidence", "question", "asked_for"].includes(k)));
    this.append(l, "action.cancelled", { action_id: target.action_id, reason: `corrected_by_${lineId}` });
    const merged: AnyClause = { ...(c as AnyClause), ...Object.fromEntries(Object.entries(target.args).map(([k, v]) => [k === "reason" || k === "note" ? "text" : k, v])), ...over, class: "instruction", kind: target.kind, words: c.words };
    const before = l.task.order.length;
    this.applyWork(l, lineId, merged, target.kind, target.args);
    const made = l.task.order.length > before ? l.task.actions.get(l.task.order.at(-1)!) ?? null : null;
    if (made) this.correctionCandidate(l, lineId, target, made);
  }

  // The ward this line was said in, else the last ward the task's context named, else the ward this task admitted to or put a bed in.
  private wardFor(l: Live, lineId: string): string | null {
    const seen = l.ctxOf.get(lineId)?.facts["ward"] ?? this.wards.get(l.task.task_id) ?? null;
    if (seen) return seen;
    const t = l.task;
    const placed = [...t.order].reverse().map((id) => t.actions.get(id)!).find((a) => (a.kind === "admit_patient" || a.kind === "assign_bed") && a.state === "completed");
    const key = placed ? String(placed.args["ward"]) : null;
    return key ? this.o.port.names?.().wards?.[key]?.[0] ?? null : null;
  }

  // Fills one unsaid value from the preference whose scope covers this patient; every one not used is shown with why, and nothing is filled without a scope.
  private preferred(l: Live, lineId: string, field: PrefField, itemKind: string | null, out: { use: PrefUse | null }): string | null {
    const mem = this.o.preferences;
    if (!mem) return null;
    const t = l.task;
    const ward = this.wardFor(l, lineId);
    const r = mem.choose({ owner: t.owner, patient_id: t.patient_id, ward, field, item_kind: itemKind });
    const use = (p: NonNullable<typeof r.applied>, reason: string | null): PrefUse => ({
      pref_id: p.pref_id, field: p.field, value: p.value, text: describePref(p), scope: describeScope(p.scope), source: describeSource(p.source, t.owner),
      line_id: lineId, action_id: null, reason, at: this.wall().toISOString()
    });
    for (const w of r.withheld) {
      if (t.prefs.withheld.some((x) => x.pref_id === w.pref.pref_id && x.line_id === lineId)) continue;
      this.append(l, "preference.withheld", use(w.pref, w.reason));
      this.note(l, `Not used here: ${describePref(w.pref)}, from ${describeSource(w.pref.source, t.owner)}, because ${w.reason}.`);
    }
    if (!r.applied) return null;
    out.use = use(r.applied, null);
    return r.applied.value;
  }

  // A correction that changed a value a preference may hold becomes a candidate only, with one question for its scope; the correction itself stays with this entry.
  private correctionCandidate(l: Live, lineId: string, before: EmrAction, after: EmrAction): void {
    const mem = this.o.preferences;
    if (!mem) return;
    const field: PrefField | null = after.kind === "add_care_plan_item" && after.args["cadence"] !== before.args["cadence"] ? "care_plan_cadence"
      : after.kind === "record_note" && after.args["note_type"] !== before.args["note_type"] ? "note_type" : null;
    if (!field) return;
    const line = l.task.lines.find((x) => x.id === lineId);
    const reading = { field, item_kind: field === "care_plan_cadence" ? String(after.args["item_kind"]) : null, value: String(after.args[field === "care_plan_cadence" ? "cadence" : "note_type"]) };
    const p = mem.candidate({ owner: l.task.owner, reading, source: { kind: "correction", task_id: l.task.task_id, line_id: lineId, quote: line?.kept ? line.text : "" }, patient_id: l.task.patient_id, ward: this.wardFor(l, lineId) });
    this.askScope(l, lineId, p.pref_id, `Corrected for this entry. Keep ${describePref(p)} beyond it? Say patient, me, ward or everyone; no keeps it to this entry.`);
  }

  // "From now on ..." read by rule; a rule it cannot read is said so, and nothing is kept.
  private fromNowOn(l: Live, lineId: string, text: string, ctx: EmrContext): void {
    const mem = this.o.preferences!;
    this.append(l, "line.handled", { line_id: lineId, as: "preference" });
    const reading = readRule(text);
    if (!reading) { this.note(l, "I keep a care-plan cadence for one kind of item, or the type of note, as a preference; I could not read either in that, so nothing was kept."); return; }
    const p = mem.candidate({ owner: l.task.owner, reading, source: { kind: "from_now_on", task_id: l.task.task_id, line_id: lineId, quote: text }, patient_id: l.task.patient_id, ward: ctx.facts["ward"] ?? this.wards.get(l.task.task_id) ?? null });
    this.askScope(l, lineId, p.pref_id, `Keep ${describePref(p)} from now on for whom? Say patient, me, ward or everyone; no keeps nothing.`);
  }

  private askScope(l: Live, lineId: string, prefId: string, text: string): void {
    this.append(l, "preference.candidate_noted", { pref_id: prefId, line_id: lineId });
    this.append(l, "question.asked", { question_id: `q-${shortHash(l.task.task_id, l.task.questions.length + 1)}`, line_id: lineId, text: text.slice(0, 300), pref_id: prefId });
  }

  // One word settles the open scope question by rule; a scope the context cannot fill is asked again.
  private scopeByWord(l: Live, lineId: string, line: EmrLine): boolean {
    const mem = this.o.preferences;
    const q = l.task.questions.filter((y) => y.answered_by === null || y.answered_by === lineId).at(-1);
    if (!mem || !q?.pref_id || Date.parse(line.at) - Date.parse(q.at) > (this.o.answerWindowMs ?? 120_000)) return false;
    const a = scopeAnswer(line.text);
    if (!a) return false;
    if (q.answered_by === null) this.append(l, "question.answered", { question_id: q.question_id, line_id: lineId });
    this.append(l, "line.ruled", { line_id: lineId, classes: ["instruction"], as: "preference_scope", question_id: q.question_id });
    this.settleScope(l, q.pref_id, a, "word", lineId);
    this.settle(l, "preference_scoped");
    return true;
  }

  // The strip's scope buttons and the one-word answer both land here; the owner alone decides.
  scopePreference(taskId: string, by: string, prefId: string, answer: (typeof SCOPE_KINDS)[number] | "no"): { ok: boolean; reason: string | null } {
    const l = this.live.get(taskId);
    if (!l) return { ok: false, reason: "unknown_task" };
    if (l.task.owner !== by) throw new Error("the task belongs to another owner");
    const q = l.task.questions.find((x) => x.pref_id === prefId && x.answered_by === null);
    if (q) this.append(l, "question.answered", { question_id: q.question_id, line_id: `strip:${prefId}` });
    return this.settleScope(l, prefId, answer, "strip", null);
  }

  private settleScope(l: Live, prefId: string, a: (typeof SCOPE_KINDS)[number] | "no", via: "word" | "strip", lineId: string | null): { ok: boolean; reason: string | null } {
    try {
      const p = this.o.preferences!.decide(prefId, l.task.owner, a, via, lineId);
      this.note(l, p.state === "declined" ? `Not kept: ${describePref(p)} stays with the entry it came from.` : `Kept: ${describePref(p)}, scope ${describeScope(p.scope)}.`);
      return { ok: true, reason: null };
    } catch (e) {
      if (!(e instanceof PreferenceError)) throw e;
      this.note(l, e.code === "no_ward" ? "I do not know this patient's ward, so I cannot keep it for the ward. Say patient, me or everyone." : `Not kept: ${e.message}.`);
      if (e.code === "no_ward" || e.code === "no_patient") this.askScope(l, lineId ?? `strip:${prefId}`, prefId, "Which scope then? Say patient, me or everyone; no keeps it to this entry.");
      return { ok: false, reason: e.code };
    }
  }

  // The ward key the clinician named, matched against the words the hospital gave for it.
  private wardSaid(ward: string | null | undefined, line: string): string | null {
    const wards = this.o.port.names?.().wards ?? {};
    const norm = (x: string) => ` ${x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
    const said = (w: string) => norm(line).includes(norm(w));
    if (ward && wards[ward] && (wards[ward] ?? []).some(said)) return ward;
    const hit = Object.entries(wards).filter(([, ws]) => ws.some(said));
    return hit.length === 1 ? hit[0]![0] : null;
  }

  // Writes one section of the clerking note; the consultation is opened for the owner first if this task has not opened it.
  private proposeClerking(l: Live, lineId: string, section: string, text: string, own: Record<string, unknown> = {}): void {
    const t = l.task;
    if (!t.visit_id || !text) return;
    const kinds = this.kinds(t.owner);
    const opened = t.order.some((id) => { const a = t.actions.get(id)!; return a.kind === "open_consult" && !["cancelled", "refused", "failed"].includes(a.state); });
    if (!opened && kinds.includes("open_consult") && t.patient_id) this.propose(l, lineId, "open_consult", { visit_id: t.visit_id, patient_id: t.patient_id }, null);
    const parsed = WORK_ARGS.record_clerking.safeParse({ visit_id: t.visit_id, ...(t.patient_id ? { patient_id: t.patient_id } : {}), section, text: text.slice(0, 2000) });
    if (!parsed.success) { this.note(l, `The note could not take that: ${parsed.error.issues[0]?.message ?? "invalid"}.`); return; }
    this.propose(l, lineId, CLERKING_KIND, parsed.data, null, own);
  }

  // The doctor's spoken vitals before admission, kept only where the number was said, as a line of the note's vitals section.
  private clerkVitals(l: Live, lineId: string, c: AnyClause, line: string): void {
    const nums = new Set((line.match(/\d+(?:\.\d+)?/g) ?? []).map((x) => String(Number(x))));
    const heard = (v: unknown) => v !== null && v !== undefined && String(v).split("/").every((n) => nums.has(String(Number(n))));
    const own: Record<string, unknown> = {};
    const parts: string[] = [];
    const put = (k: string, v: unknown, label: string, unit = "") => { if (heard(v)) { own[k] = k === "temp_c" ? tempText(v as string | number) ?? String(v) : v; parts.push(`${label} ${String(own[k])}${unit}`); } };
    put("temp_c", c.temp_c, "temperature", " C"); put("pulse", c.pulse, "pulse"); put("resp_rate", c.resp_rate, "respiratory rate"); put("bp", c.bp, "blood pressure"); put("spo2", c.spo2, "oxygen saturation", "%");
    if (!parts.length) { this.ask(l, lineId, "Which values should I write? Please say them again."); return; }
    const text = `${c.class === "correction" ? "Corrected: " : ""}${parts.join(", ")}.`;
    this.proposeClerking(l, lineId, "vitals", text.charAt(0).toUpperCase() + text.slice(1), own);
  }

  // An instruction for later: a review at a time said, or any of the owner's kinds at a time said or once the admission or a result exists.
  private holdLater(l: Live, lineId: string, c: AnyClause, kind: string, line: string): void {
    const t = l.task;
    const minutes = c.in_minutes != null || kind === "schedule_review" ? minutesSaid(line) : null;
    const after = c.after && afterSaid(c.after, line) ? c.after : null;
    if (kind === "schedule_review" && minutes === null) { this.ask(l, lineId, "When should the review be? Say the time, such as in one hour."); return; }
    if (minutes === null && !after) { this.ask(l, lineId, "When should I do that? Say a time, or that it waits for the admission or a result."); return; }
    const at = Date.parse(t.lines.find((x) => x.id === lineId)?.ambient?.ended_at ?? t.lines.find((x) => x.id === lineId)?.at ?? this.wall().toISOString());
    const due_at = minutes !== null ? new Date((Number.isFinite(at) ? at : this.wall().getTime()) + minutes * 60_000).toISOString() : null;
    if (after === "admission" && t.admission_id && due_at === null) { const { after: _a, in_minutes: _m, ...now } = c; return this.applyWork(l, lineId, now, kind); }
    this.holdObligation(l, lineId, kind, c, { after, due_at, reason: kind === "schedule_review" ? "review" : "later" });
  }

  // Journals one obligation; a review is also put on the ward board as a STAT item once the admission exists.
  private holdObligation(l: Live, lineId: string, kind: string, c: AnyClause, w: { after: "admission" | "result" | null; due_at: string | null; reason: string }): void {
    const t = l.task;
    const { in_minutes: _m, after: _a, words, ...rest } = c;
    const clause = Object.fromEntries(Object.entries({ ...rest, words }).filter(([, v]) => v !== null && v !== undefined));
    const title = (c.title ?? c.text ?? words).trim().slice(0, 200);
    if (t.obligations.some((o) => o.line_id === lineId && o.kind === kind && o.state === "held")) return;
    const obligation_id = `o-${shortHash(t.task_id, lineId, kind, t.obligations.length + 1)}`;
    this.append(l, "obligation.held", { obligation_id, line_id: lineId, kind, clause, title, due_at: w.due_at, after: w.after, reason: w.reason });
    const when = [w.due_at ? `at ${w.due_at.slice(11, 16)} UTC` : null, w.after === "admission" ? "once the patient is admitted" : w.after === "result" ? "when the result is back" : null].filter(Boolean).join(", ");
    this.note(l, `Held ${when}: ${kind === "schedule_review" ? `review, ${title}` : summariseWork(kind, clause)}. I will do it then without being asked again.`);
    this.anchorReviews(l);
    if (kind === "schedule_review") this.delegateReview(l, lineId, `${title} ${String(c.words ?? "")}`, w.due_at);
  }

  // Puts each held review on the ward board as a STAT item at its due time, once there is an admission to hang it on.
  private anchorReviews(l: Live): void {
    const t = l.task;
    if (!t.admission_id || !this.kinds(t.owner).includes("schedule_review")) return;
    for (const o of t.obligations.filter((x) => x.kind === "schedule_review" && x.state === "held" && !x.anchor_action_id && x.due_at)) {
      const parsed = WORK_ARGS.schedule_review.safeParse({ admission_id: t.admission_id, title: o.title, due_at: o.due_at });
      if (!parsed.success) continue;
      const before = t.order.length;
      this.propose(l, o.line_id, "schedule_review", parsed.data, null);
      if (t.order.length > before) this.append(l, "obligation.anchored", { obligation_id: o.obligation_id, action_id: t.order.at(-1) });
    }
  }

  // The runtime's own timer: each held obligation whose time came or whose condition holds is queued to fire once; a paused task waits.
  private sweepObligations(): void {
    if (this.stopped) return;
    const now = this.wall().getTime();
    for (const l of this.live.values()) {
      const t = l.task;
      if (CLOSED_TASK.has(t.state) || t.state === "paused") continue;
      if (t.admission_id && t.obligations.some((o) => o.kind === "schedule_review" && o.state === "held" && !o.anchor_action_id)) this.enqueue(l, async () => this.anchorReviews(l));
      if (t.delegations.some((d) => d.ward_review === "held" && d.delegation_id) && this.onBed(t)) this.enqueue(l, async () => this.requestReviews(l));
      if (t.admission_id && t.patient_id && t.obligations.some((o) => o.kind === "schedule_review" && o.state !== "cancelled" && !this.reviewTried.has(o.obligation_id) && !t.delegations.some((d) => d.line_id === o.line_id))) {
        this.enqueue(l, async () => {
          for (const o of t.obligations.filter((x) => x.kind === "schedule_review" && x.state !== "cancelled" && !this.reviewTried.has(x.obligation_id) && !t.delegations.some((d) => d.line_id === x.line_id))) {
            this.reviewTried.add(o.obligation_id);
            this.delegateReview(l, o.line_id, `${o.title} ${String(o.clause["words"] ?? "")}`, o.due_at);
          }
        });
      }
      const results = this.o.port.resultFacts?.(t.owner) ?? [];
      for (const o of t.obligations) {
        if (o.state !== "held" || this.firing.has(o.obligation_id)) continue;
        const timeCame = o.due_at !== null && Date.parse(o.due_at) <= now;
        const condition = o.after === "admission" ? !!t.admission_id : o.after === "result" ? t.changes.some((c) => results.includes(c.fact) && c.at >= o.held_at) : false;
        // A held time and a condition both have to be met when both were said.
        const ready = o.due_at !== null && o.after !== null ? timeCame && condition : timeCame || condition;
        if (!ready) continue;
        this.firing.add(o.obligation_id);
        this.enqueue(l, async () => { try { this.fire(l, o.obligation_id, timeCame ? "timer" : "condition"); } finally { this.firing.delete(o.obligation_id); } });
      }
    }
  }

  // Fires one obligation exactly once: the fired record is journaled first, then its work is proposed from the words that asked for it.
  private fire(l: Live, obligationId: string, by: string): void {
    const t = l.task;
    const o = t.obligations.find((x) => x.obligation_id === obligationId);
    if (!o || o.state !== "held" || t.state === "paused" || CLOSED_TASK.has(t.state)) return;
    this.append(l, "obligation.fired", { obligation_id: o.obligation_id, by });
    if (o.kind === "schedule_review") {
      this.note(l, `Review due now: ${o.title}.${o.anchor_action_id ? " It is on the ward board." : ""}`);
      this.append(l, "obligation.done", { obligation_id: o.obligation_id, action_id: o.anchor_action_id });
      return this.settle(l, "review_due");
    }
    const before = new Set(t.order);
    const c = { ...o.clause, words: String(o.clause["words"] ?? o.title), class: "instruction", kind: o.kind, confidence: 1 } as AnyClause;
    if (o.kind === OBSERVATION_KIND) this.applyClause(l, o.line_id, c, 0, this.kinds(t.owner), this.provFor(t, { line_id: o.line_id } as EmrAction));
    else this.applyWork(l, o.line_id, c, o.kind);
    const made = t.order.find((id) => !before.has(id) && t.actions.get(id)!.kind === o.kind) ?? null;
    // Work that is still blocked is held again under a new obligation, so this one is done.
    this.append(l, "obligation.done", { obligation_id: o.obligation_id, action_id: made });
    this.settle(l, "obligation_fired");
  }

  private propose(l: Live, lineId: string, kind: string, rawArgs: WorkArgs, correctsId: string | null, own: Record<string, unknown> = {}): void {
    const t = l.task;
    const who = this.speakerOf(t, lineId);
    const summary = kind === OBSERVATION_KIND ? summarise(rawArgs as ObservationArgs, correctsId) : summariseWork(kind, rawArgs);
    // Only the owner's own matched voice changes the patient's care; documentation from another voice is kept and marked with who said it.
    const needsOwner = kind !== "countersign" && (ORDER_KINDS.has(kind) || (who !== null && !DOCUMENTATION_KINDS.has(kind)));
    if (needsOwner && who?.speaker === "other_clinician") {
      this.append(l, "speaker.refused", { line_id: lineId, kind, speaker: who.label });
      this.note(l, `${who.label} said: ${summary}. Not done: ${who.label}'s orders need ${who.label}'s own session; a voice never changes whose agent this is.`);
      return this.settle(l, "other_clinician");
    }
    const args = DOCUMENTATION_KINDS.has(kind) && who && who.speaker !== "owner" ? this.attributed(kind, rawArgs, who) : rawArgs;
    let awaiting: EmrAction["awaiting"] = needsOwner && who?.speaker !== "owner" ? "owner_voice" : null;
    const controlled = kind === "prescribe" && !!this.o.port.orderables?.().drugs[String(args["drug"])]?.controlled;
    if (!awaiting && (controlled || CONFIRM_KINDS.has(kind))) awaiting = "confirm";
    const authorisedBy = kind === "countersign" || (ORDER_KINDS.has(kind) && who?.speaker === "owner") ? lineId : null;
    const actionId = `a-${shortHash(t.task_id, lineId, t.order.length + 1)}`;
    const ears = this.startCheck(l, actionId, lineId, own);
    if (kind === "prescribe" && typeof args["dose"] === "string") this.startDoseCheck(l, actionId, lineId, args["dose"]);
    const anchor = awaiting ? null : this.anchorOf(t, lineId);
    const screen = this.screenOf(t, kind, args);
    this.append(l, "action.proposed", { action_id: actionId, kind, args, summary, line_id: lineId, corrects_action_id: correctsId, hold_ms: this.o.holdMs ?? 0, ...this.holdUntil(anchor), ...(ears ? { ears: true } : {}), ...(awaiting ? { awaiting } : {}), ...(authorisedBy ? { authorised_by_line: authorisedBy } : {}), ...(screen ? { screen } : {}) });
    if (awaiting === "owner_voice") this.ask(l, lineId, `Held: ${summary}. ${who ? "I could not match the voice to you" : "I heard no voice to match"}, so it waits until you say yes yourself.`, null, { kind: "authorise", action_id: actionId });
    if (awaiting === "confirm" && !CONFIRM_KINDS.has(kind)) this.ask(l, lineId, `${summary}. This is a controlled drug: say confirm to send it.`, null, { kind: "confirm", action_id: actionId });
    this.settle(l, "proposed");
    if (CONFIRM_KINDS.has(kind)) void this.readBackPaperwork(l, lineId, actionId);
    this.noteHold(actionId, anchor);
    if (t.state === "running" && !awaiting) this.hold(l, actionId, anchor);
  }

  // The line's matched speaker, once the hospital answered; null when the line had no voice to match.
  private speakerOf(t: EmrTask, lineId: string): SpeakerRecord | null { return t.lines.find((x) => x.id === lineId)?.speaker ?? null; }

  // Journals who spoke the line once the match is back; the owner's token stays in memory for the order the line authorises.
  private async attribute(l: Live, lineId: string): Promise<SpeakerRecord | null> {
    const p = this.speakers.get(lineId);
    if (!p) return this.speakerOf(l.task, lineId);
    this.speakers.delete(lineId);
    const r = await p;
    if (r.v.speaker === "owner") this.tokens.set(lineId, r.v.token);
    const rec = recordOf(r.v, r.embed_ms, r.match_ms);
    this.append(l, "speaker.attributed", { line_id: lineId, speaker: rec });
    return rec;
  }

  // Words another clinician said carry their name, and words nobody could be matched to say so.
  private saidBy(t: EmrTask, lineId: string, text: string): string {
    const who = this.speakerOf(t, lineId);
    if (!who || who.speaker === "owner") return text;
    return who.speaker === "other_clinician" ? `${who.label} said: ${text}` : `Speaker not verified: ${text}`;
  }

  private attributed(kind: string, a: WorkArgs, who: SpeakerRecord): WorkArgs {
    const tag = who.speaker === "other_clinician" ? `${who.label} said` : "Speaker not verified";
    if (kind === OBSERVATION_KIND) return { ...a, remark: [tag, a["remark"]].filter(Boolean).join(". ").slice(0, 300) };
    if (kind === "record_triage_vitals") return { ...a, note: [tag, a["note"]].filter(Boolean).join(". ").slice(0, 500) };
    if ((kind === "record_note" || kind === "draft_consult_note") && typeof a["text"] === "string" && !a["text"].startsWith(tag)) return { ...a, text: `${tag}: ${a["text"]}` };
    return a;
  }

  // The test or medicine key the line names: the gate's key when its words were said, else the one key whose words were said.
  private orderableSaid(m: Record<string, readonly string[]>, named: string | null | undefined, line: string): string | null {
    if (named && m[named]?.some((w) => wordSaid(w, line))) return named;
    const hit = Object.entries(m).filter(([, ws]) => ws.some((w) => wordSaid(w, line)));
    return hit.length === 1 ? hit[0]![0] : null;
  }

  // What a short line says to the voice-order rules: sign everything, or a yes or no to the latest open order question.
  // Reads the discharge paperwork from the record and asks the owner to confirm exactly that reading.
  private async readBackPaperwork(l: Live, lineId: string, actionId: string): Promise<void> {
    const t = l.task;
    const a = t.actions.get(actionId);
    if (!a || !t.admission_id || !this.o.port.readPaperwork) {
      if (a) this.append(l, "action.cancelled", { action_id: actionId, reason: "no_paperwork_read" });
      this.note(l, "I cannot read the discharge paperwork here, so nothing was discharged.");
      return this.settle(l, "no_paperwork");
    }
    let rb: PaperworkReadBack;
    try { rb = await this.o.port.readPaperwork(t.owner, t.admission_id, this.provFor(t, a)); } catch (e) {
      this.append(l, "action.cancelled", { action_id: actionId, reason: "paperwork_read_failed" });
      this.note(l, `I could not read the discharge paperwork (${e instanceof Error ? e.message.slice(0, 80) : "read failed"}), so nothing was discharged. Say it again.`);
      return this.settle(l, "paperwork_read_failed");
    }
    this.append(l, "action.read_back", { action_id: actionId, read_back: rb });
    if (!rb.diagnosis) {
      this.append(l, "action.cancelled", { action_id: actionId, reason: "no_diagnosis_in_record" });
      this.note(l, "The record has no diagnosis for this stay, so I did not ask you to confirm a discharge. Record the diagnosis first.");
      return this.settle(l, "no_diagnosis");
    }
    if (rb.unsigned > 0) this.note(l, `${rb.unsigned} voice order${rb.unsigned === 1 ? " still awaits" : "s still await"} your countersign; the hospital will not discharge until you say sign everything.`);
    if (t.actions.get(actionId)?.awaiting === "confirm") this.ask(l, lineId, paperworkAsk(a.summary, rb), null, { kind: "confirm", action_id: actionId });
    this.settle(l, "read_back");
  }

  private orderWords(t: EmrTask, lineId: string): { sign: boolean; yes: boolean; no: boolean; q: EmrQuestion | null } | null {
    const line = t.lines.find((x) => x.id === lineId);
    if (!line || line.decided || t.state !== "running") return null;
    const text = line.text.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
    const sign = SIGN_EVERYTHING.test(text);
    const open = t.questions.filter((y) => y.answered_by === null && y.rule).at(-1) ?? null;
    const q = open && Date.parse(line.at) - Date.parse(open.at) <= (this.o.answerWindowMs ?? 600_000) ? open : null;
    const yes = text.split(" ").length <= 5 && OWNER_YES.test(text);
    const no = text.split(" ").length <= 4 && OWNER_NO.test(text);
    return sign || (q && (yes || no)) ? { sign, yes, no, q } : null;
  }
  private orderRuleApplies(l: Live, lineId: string): boolean { return this.orderWords(l.task, lineId) !== null; }

  // Short owner answers about voice orders, and "sign everything", settled by rule with no model call once the voice is matched.
  private async orderRule(l: Live, lineId: string, prov: Provenance): Promise<boolean> {
    const t = l.task;
    const w = this.orderWords(t, lineId);
    if (!w) return false;
    const { sign, no, q } = w;
    const who = await this.attribute(l, lineId);
    this.append(l, "line.ruled", { line_id: lineId, classes: ["instruction"], as: sign ? "sign_everything" : "order_answer", ...(q ? { question_id: q.question_id } : {}) });
    if (who?.speaker !== "owner") {
      this.append(l, "speaker.refused", { line_id: lineId, kind: sign ? "countersign" : q?.rule?.kind ?? null, speaker: who?.label ?? who?.speaker ?? "no_voice" });
      this.note(l, `${who?.speaker === "other_clinician" ? `${who.label} said that` : "I could not match that voice to you"}, so nothing was signed or sent. Say it yourself.`);
      this.settle(l, "needs_owner_voice");
      return true;
    }
    if (sign) { await this.readBackBatch(l, lineId, prov); return true; }
    this.append(l, "question.answered", { question_id: q!.question_id, line_id: lineId });
    const rule = q!.rule!;
    if (no) {
      if (rule.kind !== "countersign") { const a = t.actions.get(rule.action_id); if (a?.state === "proposed") this.append(l, "action.cancelled", { action_id: a.action_id, reason: `declined_by_${lineId}` }); }
      this.note(l, rule.kind === "countersign" ? "Not signed, as you said." : "Not sent, as you said.");
      this.settle(l, "declined");
      return true;
    }
    if (rule.kind === "countersign") {
      const parsed = WORK_ARGS.countersign.safeParse(rule.args);
      if (!parsed.success) { this.note(l, "That read-back could not be signed; say sign everything again."); this.settle(l, "read_back_invalid"); return true; }
      this.propose(l, lineId, "countersign", parsed.data, null);
      return true;
    }
    const a = t.actions.get(rule.action_id);
    if (!a || a.state !== "proposed" || !a.awaiting) { this.note(l, "There was nothing waiting for your word."); this.settle(l, "nothing_waiting"); return true; }
    const controlled = a.kind === "prescribe" && !!this.o.port.orderables?.().drugs[String(a.args["drug"])]?.controlled;
    const confirmKind = CONFIRM_KINDS.has(a.kind);
    if (a.awaiting === "owner_voice") {
      this.append(l, "action.authorised", { action_id: a.action_id, line_id: lineId, as: "authorise", awaiting: controlled || confirmKind ? "confirm" : null });
      if (controlled) { this.ask(l, lineId, `${a.summary}. This is a controlled drug: say confirm to send it.`, null, { kind: "confirm", action_id: a.action_id }); this.settle(l, "asked"); return true; }
      if (confirmKind) {
        if (a.read_back) this.ask(l, lineId, paperworkAsk(a.summary, a.read_back), null, { kind: "confirm", action_id: a.action_id });
        this.settle(l, "asked");
        return true;
      }
    } else if (confirmKind && (!a.read_back || lineId === a.line_id)) {
      // A discharge is confirmed only on its read-back, by a line after the instruction.
      this.note(l, "The paperwork has not been read back yet, so nothing was confirmed. Say confirm once it shows.");
      this.settle(l, "read_back_pending");
      return true;
    } else {
      this.append(l, "action.authorised", { action_id: a.action_id, line_id: lineId, as: "confirm", awaiting: null });
    }
    this.settle(l, "authorised");
    this.hold(l, a.action_id);
    return true;
  }

  // Reads back the identified batch of voice orders awaiting the owner's countersign, shown on screen before anything is signed.
  private async readBackBatch(l: Live, lineId: string, prov: Provenance): Promise<void> {
    const t = l.task;
    if (!t.visit_id || !this.o.port.readBack || !this.kinds(t.owner).includes("countersign")) { this.note(l, "There are no voice orders here for you to countersign."); return this.settle(l, "nothing_to_sign"); }
    let rb;
    try { rb = await this.o.port.readBack(t.owner, t.visit_id, prov); } catch (e) {
      this.note(l, `I could not read back the orders to countersign (${e instanceof Error ? e.message.slice(0, 80) : "read failed"}). Say sign everything again.`);
      return this.settle(l, "read_back_failed");
    }
    this.append(l, "countersign.read_back", { line_id: lineId, item_ids: rb.items.map((i) => i.stateId), items_digest: rb.itemsDigest, read_back_at: rb.readBackAt, awaiting_second: rb.awaitingSecond.map((i) => i.stateId), changed: rb.changed.map((i) => i.stateId) });
    if (rb.awaitingSecond.length) this.note(l, `Waiting for a second clinician's countersign: ${rb.awaitingSecond.map((i) => i.label).join(", ")}.`);
    if (rb.changed.length) this.note(l, `Changed since you gave them, so not in this batch: ${rb.changed.map((i) => i.label).join(", ")}.`);
    if (!rb.items.length || !rb.itemsDigest || !rb.seal) { this.note(l, "Nothing is waiting for your countersign on this patient."); return this.settle(l, "nothing_to_sign"); }
    const labels = rb.items.map((i) => `${i.label}${i.controlled ? " (controlled)" : ""}${i.sentAt ? ` sent ${i.sentAt.slice(11, 16)}` : ""}`);
    this.ask(l, lineId, `Countersign ${rb.items.length} voice order${rb.items.length === 1 ? "" : "s"}: ${labels.map((x, i) => `${i + 1}. ${x}`).join("; ")}. Say yes to sign exactly these.`, null,
      { kind: "countersign", args: { visit_id: t.visit_id, item_ids: rb.items.map((i) => i.stateId), items_digest: rb.itemsDigest, read_back_at: rb.readBackAt, read_back_seal: rb.seal, labels: rb.items.map((i) => i.label.slice(0, 120)) } });
    this.settle(l, "read_back");
  }

  private note(l: Live, text: string): void {
    this.append(l, "task.note", { note_id: `n-${shortHash(l.task.task_id, l.task.notes.length + 1)}`, text });
  }
  private ask(l: Live, lineId: string, text: string, choice: QuestionChoice | null = null, rule: OrderRule | null = null): void {
    this.append(l, "question.asked", { question_id: `q-${shortHash(l.task.task_id, l.task.questions.length + 1)}`, line_id: lineId, text: text.slice(0, rule ? 900 : 300), ...(choice ? { choice } : {}), ...(rule ? { rule } : {}) });
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
  private proposeObservation(l: Live, lineId: string, observed: ObservationArgs, correctsId: string | null, own: Record<string, unknown>): void {
    const t = l.task;
    const who = this.speakerOf(t, lineId);
    const args = who && who.speaker !== "owner" ? (this.attributed(OBSERVATION_KIND, observed, who) as ObservationArgs) : observed;
    const actionId = `a-${shortHash(t.task_id, lineId, t.order.length + 1)}`;
    const ears = this.startCheck(l, actionId, lineId, own);
    const anchor = this.anchorOf(t, lineId);
    this.append(l, "action.proposed", { action_id: actionId, kind: OBSERVATION_KIND, args, summary: summarise(args, correctsId), line_id: lineId, corrects_action_id: correctsId, hold_ms: this.o.holdMs ?? 0, ...this.holdUntil(anchor), ...(ears ? { ears: true } : {}) });
    this.settle(l, "proposed");
    this.noteHold(actionId, anchor);
    this.hold(l, actionId, anchor);
  }

  // Starts the second reading of a line's audio for the values said in it; nothing starts without audio, a second ear or a value.
  private startCheck(l: Live, actionId: string, lineId: string, own: Record<string, unknown>): boolean {
    const clip = this.clips.get(lineId);
    const vals = Object.fromEntries(Object.entries(own).filter(([k, v]) => (["temp_c", "pulse", "resp_rate", "bp", "spo2"] as string[]).includes(k) && v !== null && v !== undefined && v !== "")) as Partial<Record<Measure, unknown>>;
    if (!clip || !this.o.secondEar || !Object.keys(vals).length) return false;
    const t = l.task;
    const failed = (error: string): EarsOutcome => ({
      check: { agree: false, measures: Object.entries(vals).map(([m, v]) => ({ measure: m as Measure, first: normValue(m as Measure, v), second: null, agree: false })) },
      reading: null, error
    });
    // A reading started with the gate is compared now; it is charged to the first action that uses it.
    const early = this.early.get(lineId);
    if (early) {
      const first = early.uses === 0;
      early.uses += 1;
      this.checks.set(actionId, early.p.then(({ reading, error }) => reading
        ? { check: compareReadings(vals, reading.text, clip.guessed), reading: first ? reading : { ...reading, cost_usd: 0, calls: 0 }, error: null }
        : failed(error ?? "ear_failed")));
      return true;
    }
    const tm = this.timesOf(lineId);
    const p = this.o.secondEar(clip.wav, { run_id: t.run_id, task_id: t.task_id, line_id: lineId })
      .then((reading): EarsOutcome => ({ check: compareReadings(vals, reading.text, clip.guessed), reading, error: null }))
      .catch((e: unknown): EarsOutcome => failed(e instanceof ModelError ? e.code : "ear_failed"))
      .finally(() => { tm.ear_done = Date.now(); });
    this.checks.set(actionId, p);
    return true;
  }

  // The second ear reads a spoken dose too, so a unit it hears differently holds the prescription instead of writing it.
  private startDoseCheck(l: Live, actionId: string, lineId: string, dose: string): void {
    const clip = this.clips.get(lineId);
    const early = this.doseEars.get(lineId);
    this.doseEars.delete(lineId);
    if (!early && (!clip || !this.o.secondEar)) return;
    const t = l.task;
    const read = () => this.o.secondEar!(clip!.wav, { run_id: t.run_id, task_id: t.task_id, line_id: lineId }).then((reading) => ({ reading, error: null }), (e: unknown) => ({ reading: null as EarReading | null, error: e instanceof ModelError ? e.code : "ear_failed" }));
    // A second reading that failed or heard no dose at all is read once more, as the vitals path does; one that heard a different dose is never read again.
    const ear = (early ?? read()).then((r) => (clip && this.o.secondEar && (!r.reading || !dosesIn(cleanTranscript(r.reading.text)).length) ? read() : r));
    this.doseChecks.set(actionId, ear.then(({ reading, error }) => reading
      ? { agree: doseAgrees(dose, cleanTranscript(reading.text)), heard: reading.text.slice(0, 200), error: null, reading }
      : { agree: false, heard: null, error: error ?? "ear_failed", reading: null }));
  }
  private async doseAgreed(l: Live, a: EmrAction): Promise<boolean> {
    const p = this.doseChecks.get(a.action_id);
    if (!p) return true;
    const r = await p;
    this.doseChecks.delete(a.action_id);
    this.append(l, "ears.dose_compared", { action_id: a.action_id, line_id: a.line_id, agree: r.agree, error: r.error, provider: r.reading?.provider ?? null, model: r.reading?.model ?? null, cost_usd: r.reading?.cost_usd ?? 0, calls: r.reading ? r.reading.calls ?? 1 : 0 });
    if (r.agree) return a.state === "proposed" && l.task.state === "running";
    if (a.state !== "proposed") return false;
    this.append(l, "action.cancelled", { action_id: a.action_id, reason: "dose_readings_differ" });
    this.ask(l, a.line_id, `The dose for ${String(a.args["drug"]).replace(/_/g, " ")} was not heard the same way twice${r.heard ? ` (the second reading heard "${r.heard.slice(0, 80)}")` : ""}. Nothing was sent; please say the order again with its dose.`);
    this.settle(l, "asked");
    return false;
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
        this.versionOffers(l, read.facts, kinds);
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
      await this.pollDelegations(at);
    } finally {
      this.polling = false;
    }
  }

  // The adopted version's offers at their trigger points; the monitor re-checks the requirement data before each one, and a failed check blocks it and raises the conflict.
  private versionOffers(l: Live, facts: Record<string, string | null>, kinds: readonly string[]): void {
    const v = this.o.versions;
    if (!v) return;
    const t = l.task;
    const rules = v.rulesFor(t.owner, kinds);
    if (!rules) return;
    if (!t.version || t.version.version !== rules.version) {
      this.append(l, "version.rules", { version: rules.version, definition_hash: rules.definition_hash, parent_version: rules.parent_version, offers: rules.offers.map((o) => o.key), lines: rules.lines, readings: rules.readings });
      for (const line of rules.lines) this.note(l, line);
    }
    for (const o of rules.offers) {
      if (t.offered.includes(o.key) || !o.when.every((w) => facts[w.fact] === w.equals)) continue;
      if (t.order.some((id) => t.actions.get(id)!.kind === o.kind && t.actions.get(id)!.state !== "cancelled")) continue;
      const c = v.check(o);
      if (!c.ok) {
        this.append(l, "version.check_failed", { offer: o.key, version: o.version, step_id: o.step_id, document_id: o.document_id, stage: o.stage, requirement_version: c.requirement_version, failures: c.failures, conflict: c.conflict });
        this.append(l, "version.revision_proposed", { version: o.version, requirement_version: c.requirement_version, ops: c.revision_ops, approval: "a person" });
        this.note(l, c.conflict);
        continue;
      }
      this.append(l, "offer.made", { offer: o.key, version: o.version, step_id: o.step_id, requirement_version: c.requirement_version });
      this.ask(l, t.lines.at(-1)?.id ?? "watch", o.ask);
      this.settle(l, "offered");
    }
  }

  // Under lever 1 an action proposed while its own line is decided is held from the end of that line; held work, a resume or a restart gets the whole hold again.
  private anchorOf(t: EmrTask, lineId: string): number | null {
    if (!this.lv.holdFromSpeech || this.fresh !== lineId) return null;
    const line = t.lines.find((x) => x.id === lineId);
    const at = Date.parse(line?.ambient?.ended_at ?? line?.at ?? "");
    return Number.isFinite(at) ? at : null;
  }
  private holdUntil(anchor: number | null): Record<string, string> {
    return anchor === null ? {} : { hold_until: new Date(anchor + (this.o.holdMs ?? 0)).toISOString() };
  }
  private noteHold(actionId: string, anchor: number | null): void {
    if (anchor !== null) this.holdEnds.set(actionId, new Date(anchor + (this.o.holdMs ?? 0)).toISOString());
  }

  private hold(l: Live, actionId: string, anchor: number | null = null): void {
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.stopped) this.enqueueExec(l, () => this.execute(l, actionId)); }, holdLeftMs(this.o.holdMs ?? 0, anchor, this.wall().getTime()));
    this.timers.add(timer);
  }

  private provFor(t: EmrTask, a: EmrAction): Provenance {
    const line = t.lines.find((x) => x.id === a.line_id);
    // Work the record started, with no spoken line behind it, names the record it came from.
    const evidence = a.line_id.startsWith("rec-") ? `record:${a.line_id.slice(4)}` : `transcript:${a.line_id}`;
    const base: Provenance = { owner: t.owner, evidence, spoken_at: line?.at ?? t.created_at };
    // A discharge carries the owner's matched instruction (or the yes that authorised it) and the later matched confirmation.
    const voicedLine = (lineId: string | null) => { const tok = lineId ? this.tokens.get(lineId) : undefined; return lineId && tok ? `transcript:${lineId}~${tok}` : undefined; };
    if (CONFIRM_KINDS.has(a.kind)) {
      const authorisation = voicedLine(a.authorised_by_line ?? a.line_id), confirmation = voicedLine(a.confirmed_by_line);
      return { ...base, ...(a.read_back ? { read_back_digest: a.read_back.digest } : {}), voice: { ...(authorisation ? { authorisation } : {}), ...(confirmation ? { confirmation } : {}) } };
    }
    if (!a.kind || !ORDER_KINDS.has(a.kind)) return base;
    // An order carries the owner's matched lines as "evidence~token"; a token lost on restart leaves the header out, and the hospital refuses the write.
    const voiced = (lineId: string | null) => { const tok = lineId ? this.tokens.get(lineId) : undefined; return lineId && tok ? `transcript:${lineId}~${tok}` : undefined; };
    const authorisation = voiced(a.authorised_by_line);
    const confirmation = a.kind === "countersign" ? authorisation : voiced(a.confirmed_by_line);
    return { ...base, voice: { ...(authorisation ? { authorisation } : {}), ...(confirmation ? { confirmation } : {}) } };
  }

  // Journal, write, reconcile once by replaying the same key, then prove by a fresh read; the task state is checked right before the write.
  private async execute(l: Live, actionId: string): Promise<void> {
    const t = l.task;
    const a = t.actions.get(actionId);
    if (!a) return;
    if (a.state === "proposed") {
      if (t.state !== "running" || a.awaiting) return;
      if (!(await this.earsAgree(l, a))) return;
      if (!(await this.doseAgreed(l, a))) return;
      // A note section is sent with every section already written, so the draft always holds the whole note as it stands.
      // A discharge carries the diagnosis the record holds, never one taken from the words.
      if (CONFIRM_KINDS.has(a.kind) && (!a.read_back?.diagnosis || !a.confirmed_by_line)) {
        this.append(l, "action.refused", { action_id: actionId, reason: a.read_back?.diagnosis ? "not_confirmed" : "no_diagnosis_in_record", status: null, counted: false });
        return this.settle(l, "write_refused");
      }
      const args = a.kind === CLERKING_KIND ? { ...a.args, note: this.noteSoFar(t, a) } : CONFIRM_KINDS.has(a.kind) ? { ...a.args, primary_diagnosis: a.read_back!.diagnosis } : a.args;
      this.append(l, "action.intent", { action_id: actionId, intent_key: emrIntentKey(t.task_id, actionId, args), args });
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
        if (a.kind === EMERGENCY_KIND) this.o.onArrivalFailed?.(t.owner, t.task_id, c.reason);
        if (a.kind === "countersign" && !c.retryable) this.note(l, "Nothing was signed: the orders changed after they were read back, or one is not yours to sign now. Say sign everything to read them back again.");
        return this.settle(l, c.retryable ? "write_failed" : "write_refused");
      }
      this.append(l, "action.written", { action_id: actionId, written: { record_id: c.record_id, record_version: c.record_version, event_ids: c.event_ids, replayed: c.replayed } });
      if (c.report || c.draft) this.append(l, "action.reported", { action_id: actionId, report: c.report ?? null, draft: c.draft ?? null });
    }
    const w = a.written!;
    const v0 = Date.now();
    let proof: EmrProof | null;
    // Lever 3: a second read starts at 500 ms when the first is slow or finds nothing, and the first proof found wins.
    if (this.lv.proofBeside) proof = await hedgedRead(() => this.o.port.prove(a.kind, a.args, w, prov), PROOF_HEDGE_MS);
    else {
      proof = await this.o.port.prove(a.kind, a.args, w, prov);
      if (!proof) {
        await new Promise((r) => setTimeout(r, this.o.proofRetryMs ?? 500));
        proof = await this.o.port.prove(a.kind, a.args, w, prov);
      }
    }
    const verifyMs = Date.now() - v0;
    if (!proof && this.o.port.unverifiable?.(a.kind)) {
      this.append(l, "action.unverified", { action_id: actionId, reason: `Sent, not verified: ${this.o.port.unverifiable(a.kind)}` });
      this.note(l, `${a.summary}: sent, but not verified. ${this.o.port.unverifiable(a.kind)}`);
      return this.settle(l, "unverified");
    }
    if (!proof || proof.record_id !== w.record_id) {
      this.append(l, "action.failed", { action_id: actionId, reason: proof ? "proof_for_another_record" : "unproved" });
      if (a.kind === EMERGENCY_KIND) this.o.onArrivalFailed?.(t.owner, t.task_id, proof ? "proof_for_another_record" : "unproved");
      return this.settle(l, "unproved");
    }
    this.append(l, "action.completed", { action_id: actionId, proof });
    this.append(l, "speed.logged", { row: this.speedRow(t, a, verifyMs) });
    if (DELEGATION_RULE_KINDS.has(a.kind)) this.afterDelegation(l, a, w.record_id);
    else this.handOff(l, a, w.record_id);
    // An unnamed arrival the agent opened becomes the task's patient and arrival, so later words reach it.
    if (a.kind === EMERGENCY_KIND && EmrId.safeParse(w.record_id).success) {
      const visit = w.event_ids.map((e) => /^visit:(.+)$/.exec(e)?.[1]).find((v) => v && EmrId.safeParse(v).success) ?? null;
      this.append(l, "task.subject", { patient_id: w.record_id, visit_id: visit, unidentified: true, by: actionId });
      this.o.onSubject?.(t.owner, { patient_id: w.record_id }, "emergency", t.lines.find((x) => x.id === a.line_id)?.at);
    }
    // An admission the agent requested or made becomes the task's subject, so later words reach the same task and held work can resume.
    if ((a.kind === "request_admission" || a.kind === "admit_patient") && !t.admission_id && EmrId.safeParse(w.record_id).success) {
      this.append(l, "task.linked", { admission_id: w.record_id, by: actionId });
      this.anchorReviews(l);
      this.sweepObligations();
    }
    if (a.kind === "draft_handover" && a.draft) this.ask(l, a.line_id, `Handover draft for your review: "${a.draft.slice(0, 900)}" Say save the handover to record it, or tell me what to change.`);
    if (a.kind === "prepare_bill" && a.report) this.note(l, a.report);
    // A pay link read back from the bill proves only that the request is recorded.
    if (a.kind === "send_pay_link") this.note(l, PAY_LINK_VERIFIED_NOTE);
    this.settle(l, "proved");
  }

  // The page that shows a kind of work for this owner, bound to the task's encounter.
  private screenOf(t: EmrTask, kind: string, args: WorkArgs): ScreenPlan | null {
    const page = this.o.port.screenPage?.(t.owner, kind);
    return screenFor(kind, args, { patient_id: t.patient_id, visit_id: t.visit_id, admission_id: t.admission_id }, page && (SCREEN_PAGES as readonly string[]).includes(page) ? (page as ScreenPage) : undefined, (p) => this.o.port.pageHref?.(p));
  }

  // Holds a spoken identity on the encounter as one open obligation; completing it is the front desk's, so nothing is written to the record here.
  private holdIdentity(l: Live, lineId: string, name: string, phone: string | null): void {
    const t = l.task;
    const ob: EmrIdentityHold = {
      obligation_id: `o-${shortHash(t.task_id, lineId, "identity", t.identities.length + 1)}`, kind: "identity_pending", state: "open",
      encounter: { patient_id: t.patient_id, visit_id: t.visit_id }, name, phone, said_by: t.owner, line_id: lineId, at: t.lines.find((x) => x.id === lineId)?.at ?? this.wall().toISOString(), completes_by: "receptionist"
    };
    this.append(l, "line.ruled", { line_id: lineId, classes: ["instruction"], as: "identity" });
    this.append(l, "identity.held", { identity: ob });
    // The obligation rests on the line, so its words are kept as the evidence now.
    const line = t.lines.find((x) => x.id === lineId);
    if (line && !line.kept) this.append(l, "line.kept", { line_id: lineId, text: line.text, raw_text: line.ambient?.raw_text ?? null });
    this.note(l, `Held for the front desk to register: ${name}${phone ? `, phone ${phone}` : ", no phone yet"}.`);
    this.delegateRegistration(l, lineId, ob.obligation_id, name, phone);
  }

  // "hey Pisgah, emergency" with no patient open: one task and one unnamed arrival through the door, the spoken line its evidence, with no model call.
  async emergency(owner: string, e: { text: string; spoken_at: string; args: EmergencyArgs; source?: "text" | "audio"; wake?: Record<string, unknown> }): Promise<{ task_id: string; line_id: string; action_id: string }> {
    if (this.stopped) throw new Error("runtime stopped");
    if (!this.kinds(owner).includes(EMERGENCY_KIND)) throw new Error("this owner's agent does not open arrivals");
    const ctx: EmrContext = { admission_id: "", patient_id: null, visit_id: null, label: "Unnamed arrival", facts: {}, keywords: [] };
    const l = this.openTask(owner, ctx, { entry: "emergency", unidentified: true });
    const lineId = this.nextLineId(owner, e.text);
    this.append(l, "utterance.heard", { line_id: lineId, text: e.text.slice(0, 1000), source: e.source ?? "audio", spoken_at: e.spoken_at, entry: "emergency", ...(e.wake ? { wake: e.wake } : {}) });
    this.append(l, "line.ruled", { line_id: lineId, classes: ["instruction"], as: "emergency" });
    const actionId = `a-${shortHash(l.task.task_id, lineId, 1)}`;
    const screen = this.screenOf(l.task, EMERGENCY_KIND, e.args);
    this.append(l, "action.proposed", { action_id: actionId, kind: EMERGENCY_KIND, args: e.args, summary: `Open an unnamed emergency arrival: ${e.args.unidentified_ref}`, line_id: lineId, corrects_action_id: null, hold_ms: 0, ...(screen ? { screen } : {}) });
    this.setState(l, "running", `heard_${lineId}`);
    this.enqueue(l, () => this.execute(l, actionId));
    return { task_id: l.task.task_id, line_id: lineId, action_id: actionId };
  }

  // The owner's open tasks with their patients, newest first, so a spoken name can move the agent to the right one.
  openSubjects(owner: string): { task_id: string; target: EmrTarget; unidentified: boolean; at: string }[] {
    return [...this.live.values()].map((x) => x.task).filter((t) => t.owner === owner && !CLOSED_TASK.has(t.state) && (t.admission_id || t.patient_id))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .map((t) => ({ task_id: t.task_id, target: t.admission_id ? { admission_id: t.admission_id } : { patient_id: t.patient_id! }, unidentified: t.unidentified, at: t.updated_at }));
  }

  // The note's sections from every clerking write already verified, then this one, each section's lines in the order spoken.
  private noteSoFar(t: EmrTask, a: EmrAction): Record<string, string> {
    const out: Record<string, string> = {};
    for (const x of t.order.map((id) => t.actions.get(id)!).filter((y) => y.kind === CLERKING_KIND && (y.state === "completed" || y.action_id === a.action_id))) {
      const sec = String(x.args["section"]);
      const text = String(x.args["text"]);
      if (!(out[sec] ?? "").includes(text)) out[sec] = out[sec] ? `${out[sec]} ${text}` : text;
    }
    return out;
  }

  // Times one verified action from the end of the words that asked for it; a held obligation is timed from when it fired.
  private speedRow(t: EmrTask, a: EmrAction, verifyMs: number): SpeedRow {
    const line = t.lines.find((x) => x.id === a.line_id);
    const fired = t.obligations.find((o) => o.action_id === a.action_id || (o.line_id === a.line_id && o.kind === a.kind && o.fired_at && o.fired_at <= a.proposed_at));
    // Work the record started is timed from when the agent saw the record change, so another person's time is never counted as the agent's.
    const byRecord = a.line_id.startsWith("rec-") || a.kind === COMPLETE_KIND || a.kind === ESCALATE_KIND || a.kind === WARD_REVIEW_KIND;
    const from = byRecord ? a.proposed_at : fired?.fired_at ?? line?.ambient?.ended_at ?? line?.at ?? a.proposed_at;
    const verified = this.wall().toISOString();
    const d = (x: string | null | undefined) => (x ? Date.parse(x) - Date.parse(from) : null);
    const n = (x: number | undefined) => (x === undefined || fired || byRecord ? null : x - Date.parse(from));
    const tm = this.times.get(a.line_id) ?? {};
    const gate = this.gateStage.get(a.line_id) ?? null;
    return {
      action_id: a.action_id, kind: a.kind, line_id: a.line_id, from, verified_at: verified, ms: Date.parse(verified) - Date.parse(from),
      parts: {
        heard: fired || byRecord ? null : d(line?.ambient?.final_at), asr: n(tm.asr_at), delivered: n(tm.delivered), gate_start: n(tm.gate_start), gate_end: n(tm.gate_end), ear_done: n(tm.ear_done),
        proposed: d(a.proposed_at), hold_until: this.holdEnds.has(a.action_id) ? d(this.holdEnds.get(a.action_id)) : null, written: d(a.written_at), verified: d(verified), verify_ms: verifyMs, hold_ms: this.o.holdMs ?? 0
      },
      gate: fired || byRecord ? null : gate, levers: leverList(this.lv), ...(byRecord ? { from_record: true } : {})
    };
  }

  // A rule-taken delegation action: the task runs again and the action waits its hold like any other, unless the clinician paused the task.
  private ruleAct(l: Live, lineId: string, kind: string, args: Record<string, unknown>): string | null {
    const parsed = DELEGATION_ARGS[kind]?.safeParse(args);
    if (!parsed?.success) { this.log(`delegation ${kind}: ${parsed?.error.issues[0]?.message ?? "no schema"}`); return null; }
    if (CLOSED_TASK.has(l.task.state) || l.task.state === "paused" || !this.kinds(l.task.owner).includes(kind)) return null;
    this.setState(l, "running", `rule_${kind}`);
    const before = l.task.order.length;
    this.propose(l, lineId, kind, parsed.data, null);
    return l.task.order.length > before ? l.task.order.at(-1)! : null;
  }

  // Attempts of one delegation action kind for one delegation that did not end refused, failed or cancelled; the repair cap counts every attempt.
  private attempts(t: EmrTask, kind: string, delegationId: string | null): { live: boolean; tries: number } {
    const xs = t.order.map((id) => t.actions.get(id)!).filter((a) => a.kind === kind && (delegationId === null || a.args["delegation_id"] === delegationId));
    return { live: xs.some((a) => a.state !== "refused" && a.state !== "failed" && a.state !== "cancelled"), tries: xs.length };
  }

  private newDelegation(key: string, lineId: string, kind: string, title: string, team: string | null, dueAt: string | null, wardReview: EmrDelegation["ward_review"], extra: Partial<EmrDelegation> = {}): EmrDelegation {
    return {
      key, delegation_id: null, side: "delegator", task_kind: kind, title, team, action_id: key, line_id: lineId, at: this.wall().toISOString(),
      assigned_at: null, acknowledged_at: null, completed_at: null, escalated_at: null, record_id: null, ward_review: wardReview, due_at: dueAt, registration: null, obligation_id: null, ...extra
    };
  }

  // A review held for a time whose words name one of the owner's teams becomes a task for that team's on-duty doctor, once there is an admission to review.
  private delegateReview(l: Live, lineId: string, words: string, dueAt: string | null): void {
    const t = l.task;
    if (!this.kinds(t.owner).includes(DELEGATE_KIND) || !t.patient_id || !t.admission_id) return;
    if (t.delegations.some((d) => d.line_id === lineId)) return;
    const teams = this.o.port.delegationTeams?.(t.owner) ?? {};
    const team = teamSaid(words, teams, "review");
    if (!team) return;
    const spec = teams[team]!;
    const minutes = dueAt ? Math.max(0, Math.round((Date.parse(dueAt) - this.wall().getTime()) / 60_000)) : null;
    const escalate = spec.escalate_after_minutes ?? minutes;
    const id = this.ruleAct(l, lineId, DELEGATE_KIND, {
      task_kind: "review", team, patient_id: t.patient_id, admission_id: t.admission_id, ...(t.visit_id ? { visit_id: t.visit_id } : {}),
      subject_table: "admissions", subject_id: t.admission_id, title: spec.title, instruction: words.trim().slice(0, 2000),
      ...(dueAt ? { due_at: dueAt } : {}), ...(escalate !== null && escalate !== undefined ? { escalate_after_minutes: escalate } : {}), evidence: `transcript:${lineId}`
    });
    if (id) this.append(l, "delegation.made", { delegation: this.newDelegation(id, lineId, "review", spec.title, team, dueAt, "held") });
  }

  // A spoken identity becomes a task for the front desk, which alone may name the record; the identity closes here when the record shows the name.
  private delegateRegistration(l: Live, lineId: string, obligationId: string, name: string, phone: string | null): void {
    const t = l.task;
    if (!this.kinds(t.owner).includes(DELEGATE_KIND) || !t.patient_id) return;
    const teams = this.o.port.delegationTeams?.(t.owner) ?? {};
    const team = onlyTeam(teams, "registration");
    if (!team) return;
    const spec = teams[team]!;
    const id = this.ruleAct(l, lineId, DELEGATE_KIND, {
      task_kind: "registration", team, patient_id: t.patient_id, ...(t.visit_id ? { visit_id: t.visit_id } : {}), subject_table: "patients", subject_id: t.patient_id,
      title: spec.title, instruction: registrationInstruction(name, phone), ...(spec.escalate_after_minutes !== undefined ? { escalate_after_minutes: spec.escalate_after_minutes } : {}), evidence: `transcript:${lineId}`
    });
    if (id) this.append(l, "delegation.made", { delegation: this.newDelegation(id, lineId, "registration", spec.title, team, null, "none", { obligation_id: obligationId }) });
  }

  // A verified write the profile hands on, such as a sent voice order, becomes a task for the team that performs it, about the record the write made.
  private handOff(l: Live, a: EmrAction, recordId: string): void {
    const t = l.task;
    const h = this.o.port.delegationHandoffs?.(t.owner)[a.kind];
    if (!h || !t.patient_id || !EmrId.safeParse(recordId).success || !this.kinds(t.owner).includes(DELEGATE_KIND)) return;
    const spec = (this.o.port.delegationTeams?.(t.owner) ?? {})[h.team];
    if (!spec || t.delegations.some((d) => d.side === "delegator" && d.line_id === a.line_id && d.team === h.team)) return;
    const id = this.ruleAct(l, a.line_id, DELEGATE_KIND, {
      task_kind: spec.task_kind, team: h.team, patient_id: t.patient_id, ...(t.admission_id ? { admission_id: t.admission_id } : {}), ...(t.visit_id ? { visit_id: t.visit_id } : {}),
      subject_table: h.subject_table, subject_id: recordId, title: spec.title, instruction: `${a.summary}`.slice(0, 2000),
      ...(spec.escalate_after_minutes !== undefined ? { escalate_after_minutes: spec.escalate_after_minutes } : {}), evidence: `transcript:${a.line_id}`
    });
    if (id) this.append(l, "delegation.made", { delegation: this.newDelegation(id, a.line_id, spec.task_kind, spec.title, h.team, null, "none") });
  }

  private onBed(t: EmrTask): boolean {
    return t.order.some((id) => { const a = t.actions.get(id)!; return a.kind === "assign_bed" && a.state === "completed"; });
  }

  // The ward review request goes to the team's clinic once the patient is on a bed, which the EMR needs before it takes one.
  private requestReviews(l: Live): void {
    const t = l.task;
    if (!t.admission_id || !this.onBed(t)) return;
    for (const d of t.delegations.filter((x) => x.ward_review === "held" && x.delegation_id && x.team)) {
      const tried = this.attempts(t, WARD_REVIEW_KIND, d.delegation_id);
      if (tried.live || tried.tries >= 2) continue;
      this.ruleAct(l, d.line_id, WARD_REVIEW_KIND, { delegation_id: d.delegation_id, admission_id: t.admission_id, team: d.team, reason: `${d.title}, asked for by voice` });
    }
  }

  // The words that a rule takes are kept as evidence on the task they belong to.
  private ruledLine(l: Live, owner: string, text: string, spokenAt: string, source: "text" | "audio", as: string): string {
    const lineId = this.nextLineId(owner, text);
    this.append(l, "utterance.heard", { line_id: lineId, text, source, spoken_at: spokenAt });
    this.append(l, "line.ruled", { line_id: lineId, classes: ["instruction"], as });
    return lineId;
  }

  // A spoken "accepted <task>" acknowledges the one open task it names, and the desk's phone or consent words fill a registration; anything else is not a delegation line.
  delegationLine(owner: string, text: string, spokenAt: string, source: "text" | "audio", target?: EmrTarget): { task_id: string; line_id: string } | null {
    const open = [...this.live.values()].filter((l) => l.task.owner === owner && !CLOSED_TASK.has(l.task.state))
      .flatMap((l) => l.task.delegations.filter((d) => d.side === "assignee" && d.delegation_id && !d.completed_at).map((d) => ({ l, d, title: d.title })));
    if (!open.length) return null;
    const waiting = open.filter((x) => !x.d.acknowledged_at);
    // With the patient open, an acceptance is read against that patient's tasks first, so the same task for two patients is not ambiguous.
    const atHand = waiting.filter((x) => target && ((target.admission_id && x.l.task.admission_id === target.admission_id) || (target.patient_id && x.l.task.patient_id === target.patient_id)));
    const acc = acceptedTask(text, atHand.length ? atHand : waiting);
    if (acc) {
      const home = "hit" in acc ? acc.hit.l : open.at(-1)!.l;
      const lineId = this.ruledLine(home, owner, text, spokenAt, source, "accept");
      if ("hit" in acc) this.ruleAct(home, lineId, ACK_KIND, { delegation_id: acc.hit.d.delegation_id, title: acc.hit.d.title, evidence: `transcript:${lineId}` });
      else if ("ambiguous" in acc) this.ask(home, lineId, `Which task do you accept? ${acc.ambiguous.map((x) => x.title).join("; ")}. Say accepted and its name.`);
      else this.note(home, `No task waiting for you matches that. Waiting: ${waiting.map((x) => x.title).join("; ") || "none"}.`);
      this.settle(home, "accept_line");
      return { task_id: home.task.task_id, line_id: lineId };
    }
    // "Prepare and dispense it" on a sent order: the words that ask are the pharmacist's own, and acting on a task takes it.
    const asked = orderAsked(text);
    const orders = open.filter((x) => x.d.task_kind === "dispense" && x.d.subject_id && (!target || !(target.admission_id || target.patient_id) || x.l.task.admission_id === target.admission_id || x.l.task.patient_id === target.patient_id));
    if (asked && orders.length === 1) {
      const { l, d } = orders[0]!;
      const lineId = this.ruledLine(l, owner, text, spokenAt, source, "order");
      if (!d.acknowledged_at && !this.attempts(l.task, ACK_KIND, d.delegation_id).live) this.ruleAct(l, lineId, ACK_KIND, { delegation_id: d.delegation_id, title: d.title, evidence: `transcript:${lineId}` });
      this.append(l, "delegation.state", { key: d.key, asked, asked_line: lineId });
      this.enqueue(l, async () => this.advanceOrder(l, d.key));
      this.settle(l, "order_line");
      return { task_id: l.task.task_id, line_id: lineId };
    }
    const all = open.filter((x) => x.d.task_kind === "registration" && x.d.registration && !x.d.record_id);
    // With several arrivals waiting, the words go to the one the desk has open.
    const here = all.filter((x) => target && ((target.patient_id && x.l.task.patient_id === target.patient_id) || (target.admission_id && x.l.task.admission_id === target.admission_id)));
    const reg = here.length ? here : all;
    const phone = phoneSaid(text);
    const consent = consentSaid(text);
    if (!reg.length || (!phone && !consent)) return null;
    if (reg.length > 1) {
      const l = reg.at(-1)!.l;
      const lineId = this.ruledLine(l, owner, text, spokenAt, source, "registration");
      this.ask(l, lineId, `${reg.length} registrations are waiting. Open the patient you are registering, then say it again.`);
      this.settle(l, "registration_ambiguous");
      return { task_id: l.task.task_id, line_id: lineId };
    }
    const { l, d } = reg[0]!;
    const lineId = this.ruledLine(l, owner, text, spokenAt, source, "registration");
    this.append(l, "delegation.details", { key: d.key, ...(phone ? { phone } : {}), ...(consent ? { consent_line: lineId } : {}) });
    this.registerWhenReady(l, d, lineId);
    this.settle(l, "registration_details");
    return { task_id: l.task.task_id, line_id: lineId };
  }

  // The desk's agent completes the record only with the name, a phone and the patient's consent said at the desk; otherwise it says what is missing.
  private registerWhenReady(l: Live, d: EmrDelegation, lineId: string): void {
    const r = d.registration!;
    const parts = r.name ? nameParts(r.name) : null;
    const needs = registrationNeeds(r);
    if (!parts) { this.note(l, "The name on this registration is not a full name, so I have not registered it; say the patient's full name."); return; }
    if (needs.length) { this.note(l, `Still needed before I register: ${needs.map((n) => (n === "phone" ? "a phone number" : "the patient's consent, said by you")).join(" and ")}.`); return; }
    const tried = this.attempts(l.task, REGISTER_KIND, d.delegation_id);
    if (tried.live || tried.tries >= 2 || !l.task.patient_id) return;
    this.ruleAct(l, lineId, REGISTER_KIND, { delegation_id: d.delegation_id, patient_id: l.task.patient_id, ...parts, phone: r.phone, evidence: `transcript:${r.consent_line}` });
  }

  // A task handed to this owner opens the owner's task for that patient with no read, and the agent tells its human on the bell at once.
  private receive(owner: string, d: DelegationRead, at: string): void {
    const ctx: EmrContext = { admission_id: d.admission_id ?? "", patient_id: d.patient_id, visit_id: d.visit_id, label: d.title, facts: {}, keywords: [] };
    const l = this.taskFor(owner, ctx) ?? this.openTask(owner, ctx, { entry: "delegation" });
    const reg = d.kind === "registration" ? { ...registrationFrom(d.instruction), consent_line: null } : null;
    const lineId = `rec-${d.id}`;
    this.append(l, "delegation.received", { delegation: { ...this.newDelegation(d.id, lineId, d.kind, d.title, null, d.due_at, "none", { registration: reg, subject_id: d.subject_id }), delegation_id: d.id, side: "assignee", action_id: null, assigned_at: at, acknowledged_at: d.acknowledged_at, escalated_at: d.escalated_at } });
    const needs = reg ? registrationNeeds(reg) : [];
    const id = this.ruleAct(l, lineId, NUDGE_KIND, { delegation_id: d.id, title: d.title, needs, nudge_key: `nudge:${needs.length ? [...needs].sort().join("+") : "new"}` });
    if (!id) this.note(l, `New task for you: ${d.title}. Say accepted ${d.title.toLowerCase()} to take it.`);
    this.o.onSubject?.(owner, d.admission_id ? { admission_id: d.admission_id } : { patient_id: d.patient_id }, "delegation");
  }

  // Each poll: new tasks handed to an owner are received; tasks an owner handed on are read again, closed when the record shows them done and escalated once when overdue.
  private async pollDelegations(at: string): Promise<void> {
    const port = this.o.port;
    if (!port.delegations || !port.delegation) return;
    const owners = new Set([...(port.delegationOwners?.() ?? []), ...[...this.live.values()].map((l) => l.task.owner)]);
    for (const owner of owners) {
      if (this.stopped) return;
      const side = port.delegationSide?.(owner) ?? "none";
      const prov: Provenance = { owner, evidence: "watch:delegations", spoken_at: at };
      const mine = () => [...this.live.values()].filter((l) => l.task.owner === owner);
      if (side === "assignee" || side === "both") {
        let rows: DelegationRead[] = [];
        try { rows = await port.delegations(owner, "assignee", prov); } catch (e) { this.log(`delegations ${owner}: ${e instanceof Error ? e.message : String(e)}`); }
        const known = new Set(mine().flatMap((l) => l.task.delegations.filter((d) => d.side === "assignee").map((d) => d.delegation_id)));
        // The list carries no instruction, so each new task is read whole before it is received.
        for (const d of rows.filter((r) => !known.has(r.id) && r.state !== "completed" && r.state !== "cancelled")) {
          let whole: DelegationRead | null = null;
          try { whole = await port.delegation(owner, d.id, prov); } catch { whole = null; }
          if (!this.stopped) this.receive(owner, whole ?? d, at);
        }
        for (const l of mine().filter((x) => !CLOSED_TASK.has(x.task.state))) {
          for (const d of l.task.delegations.filter((x) => x.side === "assignee" && x.task_kind === "dispense" && x.asked && !x.record_id)) await this.advanceOrder(l, d.key);
        }
      }
      if (side !== "delegator" && side !== "both") continue;
      // A task handed on for this owner that no open task follows, such as one made before a restart or by another serve, is followed from here.
      let handed: DelegationRead[] = [];
      try { handed = await port.delegations(owner, "delegator", prov); } catch { handed = []; }
      const followed = new Set(mine().flatMap((l) => l.task.delegations.filter((d) => d.side === "delegator").map((d) => d.delegation_id)));
      const since = this.startedAt - 2 * 60_000;
      for (const r of handed.filter((x) => !followed.has(x.id) && x.state !== "completed" && x.state !== "cancelled" && !!x.created_at && Date.parse(x.created_at) >= since)) {
        const ctx: EmrContext = { admission_id: r.admission_id ?? "", patient_id: r.patient_id, visit_id: r.visit_id, label: r.title, facts: {}, keywords: [] };
        const l = this.taskFor(owner, ctx) ?? this.openTask(owner, ctx, { entry: "delegation" });
        this.append(l, "delegation.made", { delegation: { ...this.newDelegation(r.id, `rec-${r.id}`, r.kind, r.title, null, r.due_at, "none", { subject_id: r.subject_id }), delegation_id: r.id, action_id: null, assigned_at: at, acknowledged_at: r.acknowledged_at } });
        this.note(l, `Following a task handed on for you: ${r.title}. I will tell you when the record shows it done.`);
      }
      for (const l of mine().filter((x) => !CLOSED_TASK.has(x.task.state))) {
        for (const d of l.task.delegations.filter((x) => x.side === "delegator" && x.delegation_id && !x.completed_at)) {
          let r: DelegationRead | null = null;
          try { r = await port.delegation(owner, d.delegation_id!, prov); } catch { continue; }
          if (!r || this.stopped) continue;
          // A prepared order is a milestone the delegating clinician sees, with what it still waits on.
          if (r.subject_prepared && !d.prepared_seen) {
            this.append(l, "delegation.state", { key: d.key, prepared_seen: true });
            this.note(l, `Prepared by the pharmacy: ${d.title}.${r.awaiting_payment ? " It waits for payment before it is dispensed." : ""} Not done yet; I am watching the record.`);
          }
          if (r.acknowledged_at && !d.acknowledged_at) {
            this.append(l, "delegation.state", { key: d.key, acknowledged_at: r.acknowledged_at });
            this.note(l, `Accepted by the ${d.team ? `${d.team.replace(/_/g, " ")} team` : "team"}: ${d.title}. Not done yet; I am watching the record.`);
          }
          const done = this.attempts(l.task, COMPLETE_KIND, d.delegation_id);
          const esc = this.attempts(l.task, ESCALATE_KIND, d.delegation_id);
          if (r.record.status === "verified" && r.record.record_id) {
            if (!done.live && done.tries < 2) this.ruleAct(l, d.line_id, COMPLETE_KIND, { delegation_id: d.delegation_id, title: d.title, found_record_id: r.record.record_id, evidence: `transcript:${d.line_id}` });
          } else if (r.overdue && !r.escalated_at && !d.escalated_at && !esc.live && esc.tries < 2) {
            this.ruleAct(l, d.line_id, ESCALATE_KIND, { delegation_id: d.delegation_id, title: d.title });
          }
        }
      }
    }
  }

  // A sent order the pharmacist asked for moves one step per fresh read: the review once the consultation is finished, then the dispense when it was asked for.
  private async advanceOrder(l: Live, key: string): Promise<void> {
    const t = l.task;
    const d = t.delegations.find((x) => x.key === key);
    const port = this.o.port;
    if (!d || !d.delegation_id || !d.subject_id || !d.asked || d.record_id || !port.delegation || this.stopped) return;
    let r: DelegationRead | null = null;
    try { r = await port.delegation(t.owner, d.delegation_id, { owner: t.owner, evidence: "watch:delegations", spoken_at: this.wall().toISOString() }); } catch { return; }
    if (!r || r.record.status === "verified") return;
    const line = d.asked_line ?? d.line_id;
    const args = { delegation_id: d.delegation_id, prescription_id: d.subject_id, title: d.title, evidence: `transcript:${line}` };
    if (!r.subject_prepared) {
      if (r.consult_finished === false) {
        if (d.waiting !== "consultation") { this.append(l, "delegation.state", { key, waiting: "consultation" }); this.note(l, `Held: ${d.title}. The pharmacy reviews it once the doctor finishes the consultation; I will do it then.`); this.settle(l, "order_waiting"); }
        return;
      }
      const prep = this.attempts(t, PREPARE_KIND, d.delegation_id);
      if (!prep.live && prep.tries < 2) this.ruleAct(l, line, PREPARE_KIND, args);
      return;
    }
    if (d.asked !== "dispense") return;
    // Dispensing waits for the line to be ready at the counter; a line waiting for payment is held, never tried.
    if (r.subject_ready === false) {
      const why = r.awaiting_payment ? "payment" : "counter";
      if (d.waiting !== why) {
        this.append(l, "delegation.state", { key, waiting: why });
        this.note(l, `Held: ${d.title} is prepared and ${why === "payment" ? "waits for its payment" : "is not at the counter yet"}. I will dispense it when the record shows it ready.`);
        this.settle(l, "order_waiting");
      }
      return;
    }
    const disp = this.attempts(t, DISPENSE_KIND, d.delegation_id);
    if (!disp.live && disp.tries < 2) this.ruleAct(l, line, DISPENSE_KIND, args);
  }

  // What each verified delegation write means for the task, said once in the owner's strip.
  private afterDelegation(l: Live, a: EmrAction, recordId: string): void {
    const t = l.task;
    const did = String(a.args["delegation_id"] ?? "");
    const d = a.kind === DELEGATE_KIND ? t.delegations.find((x) => x.key === a.action_id) : t.delegations.find((x) => x.delegation_id === did);
    const now = this.wall().toISOString();
    const team = String(d?.team ?? a.args["team"] ?? "").replace(/_/g, " ");
    if (!d) return;
    switch (a.kind) {
      case DELEGATE_KIND:
        this.append(l, "delegation.state", { key: d.key, delegation_id: recordId, assigned_at: now });
        this.note(l, `Handed to the ${team} team: ${d.title}. I will follow it in the record and tell you when it is done.`);
        break;
      case ACK_KIND:
        this.append(l, "delegation.state", { key: d.key, acknowledged_at: now });
        this.note(l, `Accepted: ${d.title}. Accepting is not doing it; the team that asked is told when the record shows it done.`);
        break;
      case NUDGE_KIND: {
        const needs = (a.args["needs"] as string[] | undefined) ?? [];
        const ask = needs.length ? ` Needed: ${needs.map((n) => (n === "phone" ? "a phone number" : "the patient's consent")).join(" and ")}.` : "";
        this.note(l, `New task for you: ${d.title}${d.due_at ? `, due ${d.due_at.slice(11, 16)} UTC` : ""}.${ask} Say accepted ${d.title.toLowerCase()} to take it.`);
        break;
      }
      case COMPLETE_KIND: {
        const found = String(a.args["found_record_id"]);
        this.append(l, "delegation.state", { key: d.key, completed_at: now, record_id: found });
        this.note(l, `Done: ${d.title}. The record shows it (record ${found}).`);
        if (d.obligation_id) this.append(l, "identity.closed", { obligation_id: d.obligation_id, record_id: found });
        break;
      }
      case ESCALATE_KIND:
        this.append(l, "delegation.state", { key: d.key, escalated_at: now });
        this.note(l, `Overdue: ${d.title}. The bell rang for the team and for you.`);
        break;
      case WARD_REVIEW_KIND:
        this.append(l, "delegation.state", { key: d.key, ward_review: "requested" });
        this.note(l, `Asked the ${team} clinic for a ward review now that the patient is on a bed (request ${recordId}).`);
        break;
      case PREPARE_KIND:
        this.append(l, "delegation.state", { key: d.key, waiting: null });
        this.note(l, `Prepared: ${d.title}. The pharmacist's review is recorded${d.asked === "dispense" ? "; dispensing next" : ""}.`);
        if (d.asked === "dispense") this.enqueue(l, async () => this.advanceOrder(l, d.key));
        break;
      case DISPENSE_KIND:
        this.append(l, "delegation.state", { key: d.key, record_id: recordId });
        this.note(l, `Dispensed: ${d.title} (record ${recordId}). The doctor's agent is told when it reads the record.`);
        break;
      case REGISTER_KIND:
        this.append(l, "delegation.state", { key: d.key, record_id: recordId });
        this.note(l, `Registered at the desk: record ${recordId} now carries the name and phone.`);
        break;
      default: break;
    }
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
