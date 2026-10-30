import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { EmrId, TASK_KINDS } from "@hey-pisgah/agent";

// The door's route table, header names and target ids live in a private profile file, so this public package names none of them.
export const DEFAULT_PROFILE_PATH = join(homedir(), ".hey-pisgah-door.json");

const HeaderName = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/);
const PathTpl = z.string().regex(/^[a-z0-9_{}-]+(\/[a-z0-9_{}-]+)*$/);
const Dotted = z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/);
// A list path where "a[].b" flattens each element's b.
const ListPath = z.string().regex(/^[A-Za-z0-9_]+((\.|\[\]\.|,)[A-Za-z0-9_]+)*$/);
const Words = z.array(z.string().min(1).max(40)).min(1).max(12);

// One door read: a path template and query values, each "$name" filled from the subject or the work's arguments.
const ReadSpec = z.strictObject({ path: PathTpl, query: z.record(z.string(), z.string()).optional() });
// A fresh read that proves a write: optionally pick one element of a list, then every check must hold.
const ProofSpec = ReadSpec.extend({
  find: z.strictObject({ list: ListPath, where: z.record(z.string(), z.string()) }).optional(),
  // A check is "$name" (equal), "@nonnull", "@startswith:$name" or "@contains:$name".
  checks: z.record(z.string(), z.string()).refine((c) => Object.keys(c).length > 0, "a proof needs a check")
});
// A read before a write that picks values for it, such as the first free slot of a day.
const BeforeSpec = ReadSpec.extend({ list: z.string().regex(/^[A-Za-z0-9_]+((\.|\[\]\.|,)[A-Za-z0-9_]+)*$/), where: z.record(z.string(), z.json()), field: Dotted, split: z.string().max(2).optional(), vars: z.array(z.string().regex(/^[a-z_]+$/)).min(1) });
const WriteOp = z.strictObject({
  method: z.literal("POST"), path: PathTpl, body: z.record(z.string(), z.json()),
  // Where the record id is in the answer; store names the event; positive names a count that must be above zero.
  ack: z.strictObject({ id_path: Dotted.optional(), writes_path: Dotted.optional(), primary_store: z.string().optional(), store: z.string().min(1), positive: Dotted.optional(),
    // Other records the answer names, by store, such as the arrival opened with a new patient.
    also: z.record(z.string().regex(/^[a-z_]{1,40}$/), Dotted).optional() }),
  before: z.array(BeforeSpec).max(3).optional(),
  proof: ProofSpec.optional(),
  // Why no read can show this write; the agent then reports it sent but not verified.
  unverifiable: z.string().min(1).max(200).optional()
}).refine((w) => !!w.proof !== !!w.unverifiable, "a write needs a proof or a reason it cannot have one");
// A kind that only reads: the answer is rendered into a report or a draft from "{alias.path}" and "{alias.list[].field}" placeholders.
const ReadOnlyOp = z.strictObject({ reads: z.record(z.string(), ReadSpec), report: z.string().max(2000).optional(), draft: z.string().max(4000).optional(), store: z.string().min(1) });
// A watched fact is the value at its path, or with present set, that word when any value along the path (lists read with "[].") is set and not false.
const Fact = z.strictObject({ path: z.string().regex(/^[A-Za-z0-9_]+((\.|\[\]\.)[A-Za-z0-9_]+)*$/), label: z.string().min(1).max(60), present: z.string().regex(/^[a-z_]{1,30}$/).optional() });
export const OwnerSpec = z.strictObject({
  id: z.string().min(1).max(80), label: z.string().min(1).max(80), kinds: z.array(z.string().min(1)).min(1),
  watches: z.array(z.string()).default([]), inbox: z.boolean().default(false),
  // The admission read this owner's role may make, when it is not the common one.
  context: ReadSpec.extend({ label: Dotted, facts: z.record(z.string(), Dotted).default({}) }).optional(),
  offers: z.array(z.strictObject({ fact: z.string().min(1), equals: z.string().min(1), kind: z.string().min(1), ask: z.string().min(1).max(300) })).default([]),
  // The page this owner sees a kind of work on, when it is not the kind's usual page.
  screens: z.record(z.string(), z.enum(["triage", "doctor_workspace", "admissions", "reception_identity"])).default({}),
  // Which side of a delegation this owner's agent follows: tasks handed to it, tasks it handed on, or both.
  delegation: z.enum(["none", "assignee", "delegator", "both"]).default("none")
});
export type OwnerSpec = z.infer<typeof OwnerSpec>;

// A team an owner's agent may hand work to: the words that name it, the kind of task, the fixed title, and who takes it in the EMR.
const TeamSpec = z.strictObject({
  words: Words, task_kind: z.enum(TASK_KINDS), title: z.string().min(1).max(120), label: z.string().min(1).max(80), role: z.string().regex(/^[a-z_]{1,30}$/),
  clinic_id: EmrId.optional(), ward_id: EmrId.optional(), unit_facility_id: EmrId.optional(), person_id: EmrId.optional(),
  escalate_after_minutes: z.number().int().min(0).max(10_080).optional()
});
export const DelegationsSpec = z.strictObject({
  list: ReadSpec.extend({ list_path: Dotted }), one: ReadSpec, teams: z.record(z.string().regex(/^[a-z_]{1,30}$/), TeamSpec).default({}),
  // Kinds whose verified write is handed on to a team, with the table of the record the write made.
  handoffs: z.record(z.string().min(1).max(40), z.strictObject({ team: z.string().regex(/^[a-z_]{1,30}$/), subject_table: z.string().regex(/^[a-z_]{1,40}$/) })).default({})
});

const WatchCond = z.strictObject({ fact: z.string().min(1).max(80), equals: z.string().min(1).max(80) });
// How the workflow reads in this EMR (watched facts for steps and events, work kinds for document stages), the ward and requirement version it stands for, and the patient facts no door read shows.
export const VersionsSpec = z.strictObject({
  ward_id: z.string().regex(/^[A-Z][A-Za-z0-9_]*$/),
  requirement_version: z.enum(["r1", "r2"]),
  facts: z.record(z.string(), z.string()),
  facts_source: z.string().min(1).max(200),
  steps: z.record(z.string(), WatchCond).default({}),
  events: z.record(z.string(), WatchCond).default({}),
  documents: z.record(z.string(), z.strictObject({ kind: z.string().min(1), ask: z.string().min(1).max(300) })).default({}),
  // The watched fact naming the patient's ward and the workflow ward each EMR ward stands for; with these the ward comes from the record, not from ward_id.
  ward_fact: z.string().min(1).max(80).optional(),
  wards: z.record(z.string().min(1).max(120), z.string().regex(/^[A-Z][A-Za-z0-9_]*$/)).optional()
});
export type VersionsSpec = z.infer<typeof VersionsSpec>;

export const DoorProfile = z.strictObject({
  base_url: z.url(),
  timeout_ms: z.number().int().min(1000).max(900_000).default(300_000),
  headers: z.strictObject({ on_behalf_of: HeaderName, origin: HeaderName, evidence: HeaderName, spoken_at: HeaderName, idempotency: HeaderName, replayed: HeaderName, authorisation: HeaderName.optional(), confirmation: HeaderName.optional(), authorisation_batch: HeaderName.optional(), read_back_digest: HeaderName.optional() }),
  origin_value: z.string().regex(/^[a-z][a-z_]{0,39}$/),
  // Paths the port never calls, whatever asks; checked before the allowlist.
  deny: z.array(z.string().regex(/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/)).min(1),
  // Paths refused only when called exactly, for a route whose longer siblings are allowed.
  deny_exact: z.array(z.string().regex(/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/)).default([]),
  // Paths called only with the owner's matched confirmation line, such as a clinical discharge; anything else is refused before the network.
  confirm: z.array(z.string().regex(/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/)).default([]),
  // Kinds sent only with the owner's matched instruction and a later matched confirmation, on a path other work shares.
  confirm_kinds: z.array(z.string().regex(/^[a-z_]{1,40}$/)).default([]),
  ops: z.strictObject({
    read_admission: z.strictObject({ method: z.literal("GET"), path: PathTpl, label: Dotted, facts: z.record(z.string(), Dotted), proof: z.record(z.string(), Dotted) }),
    write_observation: z.strictObject({ method: z.literal("POST"), path: PathTpl, body: z.record(z.string(), z.json()), writes_path: Dotted, primary_store: z.string().min(1) }),
    // The current inpatients the owner may see, so a caller can pick a live admission rather than a stored id.
    census: z.strictObject({ method: z.literal("GET"), path: PathTpl, list_path: Dotted, admission_path: Dotted, label_path: Dotted }).optional(),
    // The context for a patient who is not admitted yet: one list read, matched on the patient.
    patient_context: ReadSpec.extend({ list_path: Dotted, match: Dotted, label: Dotted, visit: Dotted, facts: z.record(z.string(), Dotted).default({}) }).optional(),
    // Where the hospital matches a segment's voiceprint, and where it reads back the batch awaiting countersign.
    speaker: z.strictObject({ path: PathTpl }).optional(),
    read_back: ReadSpec.optional(),
    // The discharge paperwork the hospital fills from the record, and where each part of it sits in the answer.
    paperwork: ReadSpec.extend({
      digest: Dotted, diagnosis: Dotted, medicines: Dotted, medicine_name: Dotted, medicine_dispensed: Dotted,
      exceptions: Dotted, exception_text: Dotted, tests: Dotted, test_resulted: Dotted, unsigned: Dotted.optional(),
      // Tests still without a result at discharge, which the hospital discloses on the paperwork, and the sentence it gives each.
      pending: Dotted.optional(), pending_text: Dotted.optional()
    }).optional()
  }),
  // The tests and medicines an owner may order by voice: the words that name each, the hospital's own name or id, and whether a medicine is controlled.
  orders: z.strictObject({
    tests: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), z.strictObject({ words: Words, name: z.string().min(1).max(200) })).default({}),
    drugs: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), z.strictObject({ words: Words, id: EmrId, controlled: z.boolean().default(false) })).default({})
  }).optional(),
  // The other kinds of work, each a write with its proof or a read-only report.
  work: z.record(z.string(), z.union([WriteOp, ReadOnlyOp])).default({}),
  owners: z.array(OwnerSpec).default([]),
  watches: z.record(z.string(), ReadSpec.extend({ facts: z.record(z.string(), Fact) })).default({}),
  inbox: ReadSpec.extend({ list_path: Dotted, id: Dotted, subject: Dotted, at: Dotted, detail: ReadSpec.extend({ patient: Dotted }).optional() }).optional(),
  page_targets: z.record(z.string(), z.strictObject({ words: Words, vars: z.record(z.string(), z.string()) })).default({}),
  // The hospital's own name for each value of a variable, such as the consent purposes the agent heard; a value with no name here is not sent.
  // The clinicians whose verbal orders each receiving owner may take: the words that name them and the hospital's id; the hospital still checks every one.
  verbal_issuers: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), z.strictObject({ words: Words, id: EmrId, label: z.string().min(1).max(60), receivers: z.array(z.string()).min(1) })).default({}),
  value_maps: z.record(z.string().regex(/^[a-z_]{1,40}$/), z.record(z.string(), z.string().min(1).max(80))).default({}),
  clinics: z.record(z.string(), z.strictObject({ words: Words, id: EmrId })).default({}),
  // Wards the owner may name for an admission or a bed, with the ward's class.
  wards: z.record(z.string(), z.strictObject({ words: Words, id: EmrId, class: z.string().regex(/^[a-z_]{1,30}$/) })).default({}),
  // Where each spoken section of the clerking note is kept in the EMR's encounter details.
  clerking: z.strictObject({ sections: z.record(z.string(), z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,60}$/)) }).optional(),
  // Watched facts whose change means a result came back, per owner id.
  result_facts: z.record(z.string(), z.array(z.string().min(1).max(80))).default({}),
  // The orders on a visit by record id, with the test's name and its state, and the states that mean the result is back.
  result_orders: ReadSpec.extend({ list: Dotted, id: Dotted, test: Dotted, state: Dotted, states: z.array(z.string().regex(/^[A-Za-z_]{1,40}$/)).min(1).max(20) }).optional(),
  targets: z.strictObject({ admission_by_patient: z.record(EmrId, EmrId), episode_by_admission: z.record(EmrId, EmrId) }),
  vocabulary: z.array(z.string().min(1).max(60)).max(60).default([]),
  // Staff names for the recognition hints; when absent, the owners' own labels are used.
  staff_hints: z.array(z.string().min(1).max(30)).max(60).optional(),
  // Only the sandbox integration test reads this block.
  sandbox: z.record(z.string(), z.json()).optional(),
  versions: VersionsSpec.optional(),
  // The delegation reads and the teams owners may hand work to.
  delegations: DelegationsSpec.optional(),
  // Where a checked nightly memo is delivered, and the owner whose agent sends it, with how that sender is disclosed.
  // The memo route, and the route that takes each urgent item, or a withheld memo's open work, as a task alert of its own.
  memos: z.strictObject({ path: PathTpl, alerts_path: PathTpl.optional(), sender: z.string().min(1).max(80), sender_label: z.string().min(1).max(200) }).optional(),
  // Where each page the strip can operate lives in the EMR.
  pages: z.partialRecord(z.enum(["triage", "doctor_workspace", "admissions", "reception_identity"]), z.string().regex(/^\/[a-z0-9/_-]*$/)).default({})
});
export type DoorProfile = z.infer<typeof DoorProfile>;

const TITLE = /^(dr|doctor|nurse|matron|sister|mr|mrs|ms|prof)\.?\s+/i;
// The staff names the serve sends as hints: the profile's own list, or each owner's label and that label without its title.
export function staffHintsOf(p: { staff_hints?: readonly string[] | undefined; owners: readonly { label: string }[] }): string[] {
  if (p.staff_hints) return [...p.staff_hints];
  return [...new Set(p.owners.flatMap((o) => [o.label, o.label.replace(TITLE, "")]).map((x) => x.trim()).filter((x) => x && x.length <= 30))];
}

export function profilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env["HEY_PISGAH_DOOR_PROFILE"] || DEFAULT_PROFILE_PATH;
}

export function loadProfile(path = profilePath()): DoorProfile {
  if (!existsSync(path)) throw new Error("no door profile; set HEY_PISGAH_DOOR_PROFILE to a private profile file");
  return DoorProfile.parse(JSON.parse(readFileSync(path, "utf8")));
}

// Reads a dotted path such as "a.b.0.c" out of a JSON value.
export function pick(v: unknown, path: string): unknown {
  let cur: unknown = v;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

// Fills a body template: a string that is exactly "$name" takes that value, and its key is dropped when the value is absent.
export function fillTemplate(tpl: unknown, vars: Record<string, unknown>): unknown {
  if (typeof tpl === "string" && /^\$[a-z_][a-z0-9_]*$/.test(tpl)) return vars[tpl.slice(1)];
  if (Array.isArray(tpl)) return tpl.map((x) => fillTemplate(x, vars)).filter((x) => x !== undefined);
  if (tpl && typeof tpl === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(tpl)) { const y = fillTemplate(x, vars); if (y !== undefined) out[k] = y; }
    return out;
  }
  return tpl;
}

// Fills "{name}" segments of a path template; every value must be an id, so nothing can step out of the route.
export function fillPath(tpl: string, vars: Record<string, string | undefined>): string {
  return tpl.replace(/\{([a-z_]+)\}/g, (_m, k: string) => {
    const v = vars[k];
    if (v === undefined || !EmrId.safeParse(v).success) throw new Error(`path value ${k} is not an id`);
    return v;
  });
}

// A path template as a whole-path pattern, with each "{name}" matching one id.
export function pathPattern(tpl: string): RegExp {
  const esc = tpl.split(/\{[a-z_]+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${esc.join("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")}$`);
}
