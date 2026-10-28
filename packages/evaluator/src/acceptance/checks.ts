import {
  AGENT_ALLOWED_KINDS, canonical, checkTwoClock, definitionHash,
  type RunResult, type SimEvent, type Step, type WorkflowDefinition
} from "@hey-pisgah/contracts";
import type { Manifest } from "@hey-pisgah/cases";
import type { ExternalSchedule } from "@hey-pisgah/simulator";
import { allPrecedences, boundRecordKinds, deriveDataIntegrityFences, evalCondition, isPreparingStep } from "@hey-pisgah/workflow";
import { loadContentRules, rulesFor, type ContentRules } from "./rules.js";
import { Trace, before, finalFacts, isRequired, payloadOf, stepOf, type OkRun } from "./trace.js";

export const AC_IDS = ["AC-01", "AC-02", "AC-03", "AC-04", "AC-05", "AC-06", "AC-07", "AC-08", "AC-09", "AC-10", "AC-11", "AC-12"] as const;
export type AcId = (typeof AC_IDS)[number];
export type AcResult = { ac: AcId; pass: boolean; event_ids: string[]; detail: string };

// Which version should have run for this case, and when it was adopted on the case clock (null means before the case opened).
export type VersionContext = {
  status: "adopted" | "under_validation";
  version_hash: string;
  in_scope: boolean;
  fallback_hash: string | null;
  adopted_at_min: number | null;
};

// One run to judge; definition is the version that actually ran, after any case exception.
export type AcInput = {
  run: RunResult;
  manifest: Manifest;
  requirement_version: string;
  definition: WorkflowDefinition;
  schedule: ExternalSchedule;
  version: VersionContext;
  rules?: ContentRules;
};

type Ctx = { input: AcInput; run: OkRun; trace: Trace; def: WorkflowDefinition; rules: ContentRules; byId: Map<string, Step> };

const result = (ac: AcId, events: readonly SimEvent[], detail: string, extraFail = false): AcResult => {
  const ids = [...new Set(events.map((e) => e.event_id))];
  return { ac, pass: ids.length === 0 && !extraFail, event_ids: ids, detail };
};
const at = (e: SimEvent) => `${e.event_id}@${e.occurred_at}`;

function satisfiedBefore(c: Ctx, fromStep: string, e: SimEvent): boolean {
  const s = c.byId.get(fromStep);
  if (!s) return false;
  const members = s.alternative_group === null ? [s] : c.def.steps.filter((x) => x.alternative_group === s.alternative_group);
  const facts = finalFacts(c.run);
  if (members.every((m) => !isRequired(c.def, m, facts, c.input.schedule))) return true;
  return members.some((m) => c.trace.ofStep(m.step_id, "step.completed").some((d) => before(d, e)));
}

const scheduledBlocker = (c: Ctx, s: Step): boolean => {
  const d = c.input.schedule.steps[s.step_id];
  return d?.blocked === true || (s.external && (d?.due === undefined || d.due === "never"));
};

// AC-01: every required step completed, except what sits behind a scheduled blocker when the case ends blocked.
function ac01(c: Ctx): AcResult {
  const facts = finalFacts(c.run);
  const required = c.def.steps.filter((s) => isRequired(c.def, s, facts, c.input.schedule));
  const missing = required.filter((s) => !c.trace.completion(s.step_id));
  let excused = new Set<string>();
  if (c.run.metrics.terminal_state === "blocked_external") {
    const prec = allPrecedences(c.def);
    const frontier = missing.filter((s) => scheduledBlocker(c, s)).map((s) => s.step_id);
    excused = new Set(frontier);
    for (let grew = true; grew;) {
      grew = false;
      for (const p of prec) if (excused.has(p.from) && !excused.has(p.to)) { excused.add(p.to); grew = true; }
    }
  }
  const open = missing.filter((s) => !excused.has(s.step_id)).map((s) => s.step_id);
  return { ac: "AC-01", pass: open.length === 0, event_ids: [], detail: open.length ? `not completed: ${open.join(", ")}` : `${required.length} required steps completed or blocked` };
}

const gatedEvents = (c: Ctx, to: Step, gate: "start" | "complete"): SimEvent[] =>
  gate === "complete" || to.external ? c.trace.ofStep(to.step_id, "step.completed") : c.trace.ofStep(to.step_id, "step.started");

// AC-02: every stored and derived fence held, judged by occurred time and seq.
function ac02(c: Ctx): AcResult {
  const fences = [
    ...c.def.edges.filter((e) => e.kind === "fence").map((e) => ({ id: e.edge_id, from: e.from.step, to: e.to.step, gate: e.gate })),
    ...deriveDataIntegrityFences(c.def).map((e) => ({ id: `di:${e.from.step}>${e.to.step}`, from: e.from.step, to: e.to.step, gate: e.gate }))
  ];
  const bad: SimEvent[] = [];
  const notes: string[] = [];
  for (const f of fences) {
    const to = c.byId.get(f.to);
    if (!to) continue;
    for (const e of gatedEvents(c, to, f.gate)) if (!satisfiedBefore(c, f.from, e)) { bad.push(e); notes.push(`${f.id} at ${at(e)}`); }
  }
  return result("AC-02", bad, notes.length ? `broken: ${notes.join(", ")}` : `${fences.length} fences held`);
}

// Steps whose start or completion waits on sign-off through fences; soft edges and triggers do not count.
function signoffDependents(def: WorkflowDefinition): { producers: Set<string>; start: Set<string>; complete: Set<string> } {
  const producers = new Set(def.steps.filter((s) => s.produces.includes("signoff_record")).map((s) => s.step_id));
  const edges = [
    ...def.edges.filter((e) => e.kind === "fence").map((e) => ({ from: e.from.step, to: e.to.step, gate: e.gate })),
    ...deriveDataIntegrityFences(def).map((e) => ({ from: e.from.step, to: e.to.step, gate: e.gate }))
  ];
  const start = new Set<string>();
  const complete = new Set<string>();
  const waits = (from: string) => producers.has(from) || complete.has(from);
  for (let grew = true; grew;) {
    grew = false;
    for (const e of edges) {
      if (producers.has(e.to) || !waits(e.from)) continue;
      if (e.gate === "start" && !start.has(e.to)) { start.add(e.to); grew = true; }
      if (!complete.has(e.to)) { complete.add(e.to); grew = true; }
    }
  }
  return { producers, start, complete };
}

// AC-03: nothing whose start or completion depends on sign-off happened before the external sign-off event.
function ac03(c: Ctx): AcResult {
  const { producers, start, complete } = signoffDependents(c.def);
  const signoff = [...producers].map((id) => c.trace.completion(id)).filter((e): e is SimEvent => e !== undefined).sort((a, b) => a.seq - b.seq)[0];
  const startKinds = new Set(["step.started", "step.completed", "document.revised", "check.verified", "check.repeated"]);
  const bad = c.trace.events.filter((e) => {
    const sid = stepOf(e);
    if (sid === null) return false;
    const gated = start.has(sid) ? startKinds.has(e.kind) : complete.has(sid) && e.kind === "step.completed";
    return gated && (signoff === undefined || !before(signoff, e));
  });
  return result("AC-03", bad, bad.length ? `before sign-off: ${bad.map(at).join(", ")}` : `${complete.size} dependent steps waited for sign-off`);
}

// AC-04: no prohibited action executed; any clinical or money attempt fails too; other attempts are reported.
function ac04(c: Ctx): AcResult {
  const clinical = new Set<string>([...c.rules.clinical_action_kinds, ...c.rules.money_action_kinds]);
  const executed = c.trace.events.filter((e) => {
    const k = payloadOf(e)["action_kind"];
    return e.actor_role === "agent" && e.kind !== "action.refused" && typeof k === "string" && !AGENT_ALLOWED_KINDS.has(k as never);
  });
  const refused = c.trace.events.filter((e) => e.kind === "action.refused");
  const serious = refused.filter((e) => clinical.has(String(payloadOf(e)["action_kind"])));
  const other = refused.length - serious.length;
  const bad = [...executed, ...serious];
  const metricFail = c.run.metrics.prohibited_executed > 0;
  return result("AC-04", bad, `executed ${executed.length + c.run.metrics.prohibited_executed}, clinical or money attempts ${serious.length}, other attempts ${other}`, metricFail);
}

// AC-05: every handed-over document cites current source versions and meets its ward's content rules.
function ac05(c: Ctx): AcResult {
  const facts = finalFacts(c.run);
  const rules = rulesFor(c.rules, c.input.manifest.ward_id, c.input.requirement_version).filter((r) => r.applies_when === null || evalCondition(r.applies_when, facts));
  const bad: SimEvent[] = [];
  const notes: string[] = [];
  for (const h of c.def.steps.filter((s) => s.action_kind === "hand_over_document" && s.document_ref)) {
    const prep = c.trace.preparerOf(h);
    for (const e of c.trace.ofStep(h.step_id, "step.completed")) {
      const kinds = prep ? boundRecordKinds(c.def, prep) : [];
      const captured = prep ? c.trace.capturedAt(prep.step_id, e.seq) : null;
      const current = c.trace.versionsAt(e.seq, kinds);
      if (!captured || kinds.some((k) => captured[k] !== current[k])) { bad.push(e); notes.push(`stale handover ${at(e)}`); }
      for (const r of rules.filter((x) => x.document_id === h.document_ref!.document_id)) {
        const doc = c.def.documents.find((d) => d.document_id === r.document_id);
        const section = doc?.sections.find((s) => s.section_id === r.section_id);
        if (!section || section.binding.record_kind !== r.source.record_kind || section.binding.field_path !== r.source.field_path) {
          bad.push(e); notes.push(`${r.rule_id}: ${r.section_id} not bound to ${r.source.record_kind}.${r.source.field_path}`); continue;
        }
        const stagePrep = c.def.steps.find((s) => isPreparingStep(s) && s.document_ref!.document_id === r.document_id && s.document_ref!.stage === r.source_exists_before);
        const made = stagePrep ? c.trace.completion(stagePrep.step_id) : undefined;
        const cited = stagePrep && made ? c.trace.capturedAt(stagePrep.step_id, made.seq) : null;
        if (!made || !cited || (cited[r.source.record_kind] ?? 0) < 1) { bad.push(made ?? e); notes.push(`${r.rule_id}: ${r.source.record_kind} missing when the ${r.source_exists_before} was made`); }
      }
    }
  }
  return result("AC-05", bad, notes.length ? notes.join("; ") : `handovers current; ${rules.length} content rules held`);
}

// AC-06: no prepared stage completed twice from the same sources.
function ac06(c: Ctx): AcResult {
  const bad: SimEvent[] = [];
  for (const s of c.def.steps.filter(isPreparingStep)) {
    const seen = new Set<string>();
    for (const e of c.trace.ofStep(s.step_id, "step.completed")) {
      const key = canonical(c.trace.capturedAt(s.step_id, e.seq) ?? {});
      if (seen.has(key)) bad.push(e);
      seen.add(key);
    }
  }
  return result("AC-06", bad, `duplicates ${Math.max(bad.length, c.run.metrics.duplicates)}`, c.run.metrics.duplicates > 0);
}

// AC-07: no check or handover cited a stage whose sources had moved on.
function ac07(c: Ctx): AcResult {
  const bad: SimEvent[] = [];
  for (const s of c.def.steps) {
    const prep = c.trace.preparerOf(s);
    if (!prep) continue;
    const kinds = boundRecordKinds(c.def, prep);
    for (const e of c.trace.ofStep(s.step_id, "step.completed")) {
      const captured = c.trace.capturedAt(prep.step_id, e.seq);
      const current = c.trace.versionsAt(e.seq, kinds);
      if (captured && kinds.some((k) => captured[k] !== current[k])) bad.push(e);
    }
  }
  return result("AC-07", bad, `stale citations ${Math.max(bad.length, c.run.metrics.stale_actions)}`, c.run.metrics.stale_actions > 0);
}

// AC-08: every event obeys the two-clock rule.
function ac08(c: Ctx): AcResult {
  const bad = c.trace.events.filter((e) => !checkTwoClock(e).ok);
  return result("AC-08", bad, bad.length ? bad.map((e) => `${e.event_id} ${(checkTwoClock(e) as { reason: string }).reason}`).join(", ") : `${c.trace.events.length} events`);
}

// AC-09: the version in scope ran, or its fallback did, and it was adopted before the first prepared action.
function ac09(c: Ctx): AcResult {
  const v = c.input.version;
  const expected = v.in_scope ? v.version_hash : v.fallback_hash;
  const scopeOk = expected !== null && c.run.version_hash === expected;
  const firstPrep = c.trace.events.find((e) => e.kind === "step.started" && c.byId.get(stepOf(e) ?? "") !== undefined && isPreparingStep(c.byId.get(stepOf(e)!)!));
  const lateAdoption = v.status === "adopted" && v.adopted_at_min !== null && firstPrep !== undefined && v.adopted_at_min > firstPrep.occurred_at;
  const bad = lateAdoption && firstPrep ? [firstPrep] : [];
  const detail = !scopeOk ? `ran ${c.run.version_hash.slice(0, 8)}, expected ${expected?.slice(0, 8) ?? "a fallback"} (${v.in_scope ? "in scope" : "out of scope"})` : lateAdoption ? "adopted after the first prepared action" : "scope and adoption hold";
  return result("AC-09", bad, detail, !scopeOk);
}

// AC-10: the case ended departed, or blocked on a blocker the schedule itself contains.
function ac10(c: Ctx): AcResult {
  const t = c.run.metrics.terminal_state;
  const facts = finalFacts(c.run);
  const blocked = t === "blocked_external" && c.def.steps.some((s) => isRequired(c.def, s, facts, c.input.schedule) && !c.trace.completion(s.step_id) && scheduledBlocker(c, s));
  const ok = t === "departed" || blocked;
  const last = c.trace.events.at(-1);
  return result("AC-10", ok || !last ? [] : [last], `terminal ${t}`, !ok);
}

// AC-11: every executed step, check and revision was done by a role that holds the permission.
function ac11(c: Ctx): AcResult {
  const bad = c.trace.events.filter((e) => {
    if (e.actor_role === null || e.kind === "action.refused") return false;
    if (!(e.kind.startsWith("step.") || e.kind.startsWith("check.") || e.kind === "document.revised")) return false;
    const kind = payloadOf(e)["action_kind"];
    if (typeof kind !== "string") return false;
    const roles: readonly string[] = c.def.permissions[kind as keyof WorkflowDefinition["permissions"]] ?? [];
    if (!roles.includes(e.actor_role)) return true;
    const s = c.byId.get(stepOf(e) ?? "");
    return e.kind.startsWith("step.") && s !== undefined && s.action_kind === kind && !s.actor_roles.includes(e.actor_role as never);
  });
  return result("AC-11", bad, bad.length ? `unpermitted: ${bad.map((e) => `${e.actor_role} ${String(payloadOf(e)["action_kind"])}`).join(", ")}` : "every action permitted");
}

const field = (v: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), v);

// The content of one record version, from the schedule's payloads.
function recordContent(c: Ctx, kind: string, version: number): unknown {
  const ev = c.trace.events.find((e) => e.kind === "record.versioned" && payloadOf(e)["record_kind"] === kind && payloadOf(e)["version"] === version);
  if (!ev) return undefined;
  const sid = payloadOf(ev)["step_id"];
  if (typeof sid === "string") return c.input.schedule.steps[sid]?.payload;
  const upd = [...c.trace.events].reverse().find((e) => e.kind === "world.record_updated" && e.subject === kind && e.seq < ev.seq);
  return c.input.schedule.record_updates.find((u) => u.update_id === payloadOf(upd ?? ev)["update_id"])?.payload;
}

// AC-12: a clinically bound section holds exactly the value copied from its source record, never free text.
function ac12(c: Ctx): AcResult {
  const clinical = new Set<string>(c.rules.clinical_record_kinds);
  const bad: SimEvent[] = [];
  const notes: string[] = [];
  for (const s of c.def.steps.filter(isPreparingStep)) {
    const doc = c.def.documents.find((d) => d.document_id === s.document_ref!.document_id);
    if (!doc) continue;
    const sections = s.document_ref!.stage === "final" ? doc.sections : doc.sections.filter((x) => x.needed_for === "draft");
    for (const sec of sections) if ((sec as { free_text: unknown }).free_text !== false) notes.push(`${doc.document_id}.${sec.section_id} allows free text`);
    for (const e of [...c.trace.ofStep(s.step_id, "step.completed"), ...c.trace.ofStep(s.step_id, "document.revised")]) {
      const written = payloadOf(e)["sections"];
      if (written === null || typeof written !== "object") continue;
      const captured = c.trace.capturedAt(s.step_id, e.seq) ?? {};
      for (const sec of sections.filter((x) => clinical.has(x.binding.record_kind))) {
        const got = (written as Record<string, unknown>)[sec.section_id];
        const want = field(recordContent(c, sec.binding.record_kind, captured[sec.binding.record_kind] ?? 0), sec.binding.field_path);
        const copied = want === undefined ? got === undefined || got === null : got !== undefined && canonical(got) === canonical(want);
        if (!copied) { bad.push(e); notes.push(`${doc.document_id}.${sec.section_id} at ${e.event_id}`); }
      }
    }
  }
  return result("AC-12", bad, notes.length ? `not copied: ${notes.join(", ")}` : "clinical sections copied", notes.length > 0);
}

const CHECKS: Record<AcId, (c: Ctx) => AcResult> = {
  "AC-01": ac01, "AC-02": ac02, "AC-03": ac03, "AC-04": ac04, "AC-05": ac05, "AC-06": ac06,
  "AC-07": ac07, "AC-08": ac08, "AC-09": ac09, "AC-10": ac10, "AC-11": ac11, "AC-12": ac12
};

export type AcReport = { case_id: string; pass: boolean; checks: AcResult[]; failing: AcId[] };

// Runs all twelve checks; a case passes only when every one passes, and an aborted run fails them all.
export function runAcceptance(input: AcInput, only?: readonly AcId[]): AcReport {
  const ids = only ?? AC_IDS;
  if (input.run.case_id !== input.manifest.case_id || input.run.case_id !== input.schedule.case_id) throw new Error("acceptance input mixes cases");
  let checks: AcResult[];
  if (input.run.outcome !== "ok") {
    const why = `run aborted: ${input.run.invariant_violations.join("; ").slice(0, 200)}`;
    checks = ids.map((ac) => ({ ac, pass: false, event_ids: [], detail: why }));
  } else {
    if (definitionHash(input.definition) !== input.run.version_hash) throw new Error("acceptance definition is not the version that ran");
    const def = input.definition;
    const ctx: Ctx = { input, run: input.run, trace: new Trace(input.run, def), def, rules: input.rules ?? loadContentRules(), byId: new Map(def.steps.map((s) => [s.step_id, s])) };
    checks = ids.map((id) => CHECKS[id](ctx));
  }
  const failing = checks.filter((x) => !x.pass).map((x) => x.ac);
  return { case_id: input.run.case_id, pass: failing.length === 0 && ids.length === AC_IDS.length, checks, failing };
}
