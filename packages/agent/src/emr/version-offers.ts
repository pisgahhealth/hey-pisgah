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
// An offer the newest adopted version would make here that its scope keeps from this patient, with the reason the strip and the record show.
export type WithheldOffer = { key: string; version: number; in_force: number; step_id: string; document_id: string; stage: string; when: WatchCondition[]; kind: string; reason: string };
export type VersionRules = { version: number; definition_hash: string; parent_version: number | null; readings: TriggerReading[]; offers: VersionOffer[]; lines: string[]; withheld?: WithheldOffer[]; ward_id?: string };
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

// The workflow events a version may trigger on, by name, so a reading can say which EMR event stands for each.
export const TRIGGER_EVENTS: Record<string, string> = { st01: "round entry", st02: "take-home order", st05: "clinical sign-off", st07: "summary final", st13: "financial clearance", st15: "take-home hand-over", st16: "departure" };

export type DeployStatus = "deployable" | "not_agent_work" | "no_trigger" | "no_trigger_counterpart" | "no_document_counterpart" | "no_owner";
export type DeployReading = { step_id: string; trigger: string | null; event: string | null; status: DeployStatus; reason: string; owners: string[] };
// Whether this EMR can carry a version's change at all, before any patient: every changed step needs a watched trigger point, a work kind that prepares it and an owner whose agent holds that kind.
export type DeployCheck = { version: number; parent_version: number | null; changed: DeployReading[]; deployable: boolean; reason: string };

export function deployCheck(def: WD, parent: WD | null, c: Counterparts, owners: readonly { id: string; kinds: readonly string[] }[]): DeployCheck {
  const changed = [...changedSteps(def, parent)].sort().map((stepId): DeployReading => {
    const step = def.steps.find((s) => s.step_id === stepId);
    const t = def.triggers.find((x) => x.target.step === stepId) ?? null;
    const trigger = t ? describePredicate(t.when) : null;
    const event = t && "after" in t.when ? TRIGGER_EVENTS[t.when.after.step] ?? null : null;
    const base = { step_id: stepId, trigger, event, owners: [] as string[] };
    const ref = step?.document_ref ?? null;
    if (!step || step.action_kind !== "prepare_document" || !ref || !step.actor_roles.includes("agent")) return { ...base, status: "not_agent_work", reason: `${stepId} is ${step?.action_kind ?? "unknown"} by ${step?.actor_roles.join(" or ") ?? "nobody"}; no agent can carry this change in the EMR` };
    if (!t) return { ...base, status: "no_trigger", reason: `version ${def.version} leaves ${stepId} with no trigger, so no agent offer can carry it` };
    if (!watchesFor(t.when, c)) return { ...base, status: "no_trigger_counterpart", reason: `no watched fact in this EMR shows ${trigger}${event ? ` (the ${event})` : ""}` };
    const doc = c.documents[docKey(ref.document_id, ref.stage)];
    if (!doc) return { ...base, status: "no_document_counterpart", reason: `no work kind in this EMR prepares the ${ref.document_id} ${ref.stage}` };
    const holders = owners.filter((o) => o.kinds.includes(doc.kind)).map((o) => o.id);
    if (!holders.length) return { ...base, status: "no_owner", reason: `no owner's agent holds ${doc.kind}` };
    return { ...base, owners: holders, status: "deployable", reason: `${doc.kind} offered ${trigger}${event ? ` (the ${event})` : ""}` };
  });
  const blocked = changed.filter((r) => r.status !== "deployable");
  const deployable = changed.length > 0 && blocked.length === 0;
  const reason = !changed.length ? `version ${def.version} changes no step against its parent` : deployable ? `every changed step has a watched trigger point, a work kind and an owner` : blocked.map((r) => `${r.step_id}: ${r.reason}`).join("; ");
  return { version: def.version, parent_version: parent?.version ?? null, changed, deployable, reason };
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

// The adopted version, its parent and the requirement data, wired for one EMR runtime; the encounter's own watched facts choose the version in force.
export type Encounter = Readonly<Record<string, string | null>>;
export type VersionWiring = {
  rulesFor(owner: string, kinds: readonly string[], encounter?: Encounter): VersionRules | null;
  check(o: VersionOffer, encounter?: Encounter): OfferCheck;
};
export type VersionPick = { def: WD; parent: WD | null };

// Why a version's scope keeps it from this patient, in the record's own terms.
export function scopeReason(def: WD, inForce: WD, now: RequirementsNow): string {
  const wards = def.scope.wards === "all" ? "every ward" : `ward${def.scope.wards.length === 1 ? "" : "s"} ${def.scope.wards.join(", ")}`;
  const wardOk = def.scope.wards === "all" || def.scope.wards.includes(now.ward_id);
  return wardOk ? `version ${def.version} applies on ${wards} only when its condition holds, and it does not hold for this patient, so version ${inForce.version} is in force`
    : `version ${def.version} is adopted for ${wards} and this patient is on ward ${now.ward_id}, so version ${inForce.version} is in force`;
}

// requirements may return null while the record has not named the patient's ward, and then nothing is read or offered; resolve picks the version per encounter, and newest is the adopted version whose withheld offers are recorded.
export function versionWiring(o: { def: WD; parent: WD | null; counterparts: Counterparts; requirements: (encounter?: Encounter) => RequirementsNow | null; checks?: readonly RequirementCheck[]; resolve?: (facts: Facts) => VersionPick; newest?: VersionPick }): VersionWiring {
  const pick = (now: RequirementsNow): VersionPick => (o.resolve ? o.resolve(now.facts) : { def: o.def, parent: o.parent });
  return {
    rulesFor: (_owner, kinds, encounter) => {
      const now = o.requirements(encounter);
      if (!now) return null;
      const p = pick(now);
      const r = readVersion(p.def, p.parent, o.counterparts, now.facts);
      const newest = o.newest ?? { def: o.def, parent: o.parent };
      const withheld: WithheldOffer[] = newest.def.version === p.def.version ? [] : readVersion(newest.def, newest.parent, o.counterparts, now.facts).offers
        .filter((x) => x.changed && kinds.includes(x.kind))
        .map((x) => ({ key: `withheld:${x.key}`, version: x.version, in_force: p.def.version, step_id: x.step_id, document_id: x.document_id, stage: x.stage, when: x.when, kind: x.kind, reason: scopeReason(newest.def, p.def, now) }));
      return { ...r, offers: r.offers.filter((x) => kinds.includes(x.kind)), withheld, ward_id: now.ward_id };
    },
    check: (offer, encounter) => {
      const now = o.requirements(encounter);
      if (!now) return { ok: false, requirement_version: "unknown", failures: [], revision_ops: [], conflict: "Not offered: the record does not name this patient's ward yet." };
      return checkOffer(pick(now).def, offer, now, o.checks);
    }
  };
}

// The replayed registry for per-encounter resolution, and the newest adopted version with its parent; each logged version must rebuild to its hash.
export function adoptedRegistry(storeRoot: string): { resolve: (facts: Facts) => VersionPick; newest: VersionPick; log: ReturnType<VersionDesk["records"]> } {
  const desk = new VersionDesk(storeRoot, Registry.load([loadV1()]));
  try {
    const reg = desk.registry;
    const withParent = (def: WD): VersionPick => ({ def, parent: def.parent_version === null ? null : reg.get(def.parent_version) });
    const top = reg.adoptedVersions().at(-1) ?? reg.get(1);
    return { resolve: (facts) => withParent(reg.current(facts)), newest: withParent(top), log: desk.records() };
  } finally {
    desk.close();
  }
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
