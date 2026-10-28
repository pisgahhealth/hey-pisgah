import { canonical, type ConditionExpr, type EventPredicate, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { loadV1, loadWardRequirements, wardRequiresList, type WardRequirementSet } from "@hey-pisgah/hospital";
import { Registry, evalCondition, type Facts } from "@hey-pisgah/workflow";
import { VersionDesk } from "../versions.js";
import { bindingFailures, checksInForce, loadRequirementChecks, revisionOps, type CheckFailure, type RequirementCheck } from "../monitor.js";

// A watched fact and the value that shows a workflow step or event has happened in this EMR.
export type WatchCondition = { fact: string; equals: string };
// How one EMR shows the workflow: watched facts for steps and events, and the owner's work kind that prepares a document stage.
export type Counterparts = {
  steps: Record<string, WatchCondition>;
  events: Record<string, WatchCondition>;
  documents: Record<string, { kind: string; ask: string }>;
};
export type TriggerStatus = "offer" | "not_applicable" | "no_counterpart" | "not_agent_work";
export type TriggerReading = {
  step_id: string; document_id: string | null; stage: string | null; changed: boolean;
  status: TriggerStatus; reason: string; when: WatchCondition[]; kind: string | null; unmet: { fact: string; wanted: string; is: string | null }[];
};
export type VersionOffer = { key: string; version: number; step_id: string; document_id: string; stage: string; when: WatchCondition[]; kind: string; ask: string; changed: boolean };
export type VersionRules = { version: number; definition_hash: string; parent_version: number | null; readings: TriggerReading[]; offers: VersionOffer[]; lines: string[] };
// The ward requirement data the monitor reads at each offer.
export type RequirementsNow = { ward_id: string; requirement_version: string; facts: Facts };
export type OfferCheck =
  | { ok: true; requirement_version: string }
  | { ok: false; requirement_version: string; failures: CheckFailure[]; revision_ops: ReturnType<typeof revisionOps>; conflict: string };

const docKey = (documentId: string, stage: string) => `${documentId}.${stage}`;

// Every watch a trigger's predicate needs, or null when one leaf has no counterpart or the predicate offers a choice.
function watchesFor(p: EventPredicate, c: Counterparts): WatchCondition[] | null {
  if ("after" in p) return c.steps[p.after.step] ? [c.steps[p.after.step]!] : null;
  if ("on" in p) return c.events[p.on] ? [c.events[p.on]!] : null;
  if ("all_of" in p) {
    const parts = p.all_of.map((x) => watchesFor(x, c));
    return parts.every((x) => x !== null) ? parts.flat() as WatchCondition[] : null;
  }
  return null;
}

const describePredicate = (p: EventPredicate): string =>
  "after" in p ? `after ${p.after.step}` : "on" in p ? `on ${p.on}` : "all_of" in p ? p.all_of.map(describePredicate).join(" and ") : p.any_of.map(describePredicate).join(" or ");

// The atoms of a condition that fail on these facts, so a reading can say what the patient lacks.
function unmetAtoms(c: ConditionExpr, facts: Facts): { fact: string; wanted: string; is: string | null }[] {
  if (evalCondition(c, facts)) return [];
  if ("fact" in c) {
    const v = facts[c.fact];
    return [{ fact: c.fact, wanted: "eq" in c ? c.eq : c.in.join(" or "), is: v === undefined ? null : Array.isArray(v) ? v.join(",") : String(v) }];
  }
  if ("not" in c) return [{ fact: "not", wanted: canonical(c.not), is: "holds" }];
  if ("all" in c) return c.all.flatMap((x) => unmetAtoms(x, facts));
  return c.any.flatMap((x) => unmetAtoms(x, facts));
}

// Steps whose trigger, or an edge into them, differs from the parent version.
export function changedSteps(def: WD, parent: WD | null): Set<string> {
  if (!parent) return new Set();
  const out = new Set<string>();
  const trig = (d: WD) => new Map(d.triggers.map((t) => [t.target.step, canonical(t)]));
  const [a, b] = [trig(parent), trig(def)];
  for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) out.add(k);
  const edges = (d: WD) => new Map(d.edges.map((e) => [e.edge_id, e]));
  const [ea, eb] = [edges(parent), edges(def)];
  for (const id of new Set([...ea.keys(), ...eb.keys()])) {
    const x = ea.get(id), y = eb.get(id);
    if (x && y && canonical(x) === canonical(y)) continue;
    for (const e of [x, y]) if (e) out.add(e.to.step);
  }
  return out;
}

const word = (v: string) => v.replace(/_/g, "-");

// The version's triggers read as watches and offers for this EMR: an offer needs agent work, a met condition, a watched trigger point and a work kind that prepares the stage.
export function readVersion(def: WD, parent: WD | null, c: Counterparts, facts: Facts): VersionRules {
  const changed = changedSteps(def, parent);
  const readings: TriggerReading[] = def.triggers.map((t) => {
    const step = def.steps.find((s) => s.step_id === t.target.step);
    const ref = step?.document_ref ?? null;
    const base = { step_id: t.target.step, document_id: ref?.document_id ?? null, stage: ref?.stage ?? null, changed: changed.has(t.target.step), when: [] as WatchCondition[], kind: null as string | null, unmet: [] as TriggerReading["unmet"] };
    if (!step || step.action_kind !== "prepare_document" || !ref || !step.actor_roles.includes("agent")) {
      return { ...base, status: "not_agent_work" as const, reason: `${t.target.step} is ${step?.action_kind ?? "unknown"} by ${step?.actor_roles.join(" or ") ?? "nobody"}, not a preparation the agent may do` };
    }
    const conds = [step.required_when, t.condition].filter((x): x is ConditionExpr => x !== null);
    const unmet = conds.flatMap((x) => unmetAtoms(x, facts));
    if (unmet.length) {
      return { ...base, unmet, status: "not_applicable" as const, reason: `${ref.document_id} ${ref.stage} applies when ${unmet.map((u) => `${u.fact} is ${u.wanted}`).join(" and ")}; this patient has ${unmet.map((u) => `${u.fact} ${u.is ?? "unknown"}`).join(", ")}` };
    }
    const when = watchesFor(t.when, c);
    if (!when) return { ...base, status: "no_counterpart" as const, reason: `no watched fact in this EMR shows ${describePredicate(t.when)}` };
    const doc = c.documents[docKey(ref.document_id, ref.stage)];
    if (!doc) return { ...base, when, status: "no_counterpart" as const, reason: `no work kind in this EMR prepares the ${ref.document_id} ${ref.stage}` };
    return { ...base, when, kind: doc.kind, status: "offer" as const, reason: `offer ${doc.kind} when ${when.map((w) => `${w.fact} is ${w.equals}`).join(" and ")}` };
  });
  const offers: VersionOffer[] = readings.filter((r) => r.status === "offer").map((r) => ({
    key: `v${def.version}:${r.step_id}:${r.when.map((w) => `${w.fact}=${w.equals}`).join("&")}:${r.kind}`,
    version: def.version, step_id: r.step_id, document_id: r.document_id!, stage: r.stage!, when: r.when, kind: r.kind!, ask: c.documents[docKey(r.document_id!, r.stage!)]!.ask, changed: r.changed
  }));
  return { version: def.version, definition_hash: def.definition_hash, parent_version: parent?.version ?? null, readings, offers, lines: changeLines(def.version, readings) };
}

// What the version's change means for this patient, said once; a change with nothing to offer says so instead of inventing an offer.
function changeLines(version: number, readings: readonly TriggerReading[]): string[] {
  const ch = readings.filter((r) => r.changed);
  if (!ch.length) return [];
  if (ch.some((r) => r.status === "offer")) return [];
  const lines: string[] = [];
  const na = ch.filter((r) => r.status === "not_applicable");
  if (na.length === ch.length) {
    const payer = na.flatMap((r) => r.unmet).find((u) => u.fact === "payer_type" && u.is);
    lines.push(payer ? `Nothing to offer under version ${version} for a ${word(payer.is!)} patient.` : `Nothing to offer under version ${version} for this patient.`);
  } else {
    lines.push(`Nothing to offer under version ${version}: ${ch.map((r) => r.reason).join("; ")}.`);
  }
  return lines;
}

// Facts the version reads, with ward_requires from the requirement set in force.
export function caseFacts(req: { ward_id: string; requirement_version: string; facts: Record<string, string> }, set?: WardRequirementSet): Facts {
  const s = set ?? loadWardRequirements(req.requirement_version as "r1" | "r2");
  return { ...req.facts, ward_id: req.ward_id, ward_requires: wardRequiresList(s, req.ward_id, req.facts) };
}

// The monitor on one offer: the requirement data read now, against the version the offer comes from; a failed check blocks the offer and names the conflict.
export function checkOffer(def: WD, o: VersionOffer, now: RequirementsNow, checks: readonly RequirementCheck[] = loadRequirementChecks()): OfferCheck {
  const inForce = checksInForce(checks, now.ward_id, now.requirement_version, now.facts);
  const failures = bindingFailures(def, o.document_id, o.stage, inForce);
  if (!failures.length) return { ok: true, requirement_version: now.requirement_version };
  const f = failures[0]!;
  const conflict = `Not offered: version ${o.version} prepares the ${o.document_id.replace(/_/g, " ")} ${o.stage} with ${f.section_id.replace(/_/g, " ")} from ${f.found?.record_kind.replace(/_/g, " ") ?? "nothing"}, but ward ${now.ward_id} requirements ${now.requirement_version} want it from ${f.expected.record_kind.replace(/_/g, " ")}. Conflict raised for a person to decide.`;
  return { ok: false, requirement_version: now.requirement_version, failures, revision_ops: revisionOps(failures), conflict };
}

// The adopted version, its parent and the requirement data, wired for one EMR runtime.
export type VersionWiring = {
  rulesFor(owner: string, kinds: readonly string[]): VersionRules | null;
  check(o: VersionOffer): OfferCheck;
};

export function versionWiring(o: { def: WD; parent: WD | null; counterparts: Counterparts; requirements: () => RequirementsNow; checks?: readonly RequirementCheck[] }): VersionWiring {
  return {
    rulesFor: (_owner, kinds) => {
      const r = readVersion(o.def, o.parent, o.counterparts, o.requirements().facts);
      return { ...r, offers: r.offers.filter((x) => kinds.includes(x.kind)) };
    },
    check: (offer) => checkOffer(o.def, offer, o.requirements(), o.checks)
  };
}

// The version in force for these facts after replaying a store's version log; each logged version must rebuild to its hash.
export function adoptedVersion(storeRoot: string, facts: Facts): { def: WD; parent: WD | null; log: ReturnType<VersionDesk["records"]> } {
  const desk = new VersionDesk(storeRoot, Registry.load([loadV1()]));
  try {
    const def = desk.registry.current(facts);
    return { def, parent: def.parent_version === null ? null : desk.registry.get(def.parent_version), log: desk.records() };
  } finally {
    desk.close();
  }
}
