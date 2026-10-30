import { openStream, type Stream } from "@hey-pisgah/store";
import { shortHash } from "../ids.js";
import { CADENCE_WORDS, cadenceSaid } from "./work.js";

// The clinician's remembered preferences, one stream for every owner, outside any one task so a fresh encounter reads them.
export const PREFERENCES_STREAM = "learning/preferences";

// The fields a preference may fill, each for one kind of work; a preference only fills a value the clinician did not say.
export const PREF_FIELDS = { care_plan_cadence: "add_care_plan_item", note_type: "record_note" } as const;
export type PrefField = keyof typeof PREF_FIELDS;
export const SCOPE_KINDS = ["patient", "me", "ward", "everyone"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];
export type PrefScope = { kind: "patient"; patient_id: string } | { kind: "me" } | { kind: "ward"; ward: string } | { kind: "everyone" };
export type PrefSource = { kind: "correction" | "from_now_on" | "external"; owner: string; task_id: string | null; line_id: string | null; quote: string; at: string };
export type Preference = {
  pref_id: string; owner: string; field: PrefField; item_kind: string | null; value: string;
  state: "candidate" | "active" | "declined"; scope: PrefScope | null; source: PrefSource;
  // Where it arose, so a one-word "patient" or "ward" knows which patient or ward it means.
  origin: { patient_id: string | null; ward: string | null };
  decided: { by: string; at: string; via: "word" | "strip" | "added"; line_id: string | null } | null;
};
// What a rule says, read by rule from the words: which field, for which kind of care-plan item, and the value.
export type RuleReading = { field: PrefField; item_kind: string | null; value: string };
// Where a piece of work is being done, for choosing which preferences apply.
export type PrefAt = { owner: string; patient_id: string | null; ward: string | null; field: PrefField; item_kind: string | null };
export type PrefChoice = { applied: Preference | null; withheld: { pref: Preference; reason: string }[] };

export class PreferenceError extends Error {
  constructor(readonly code: "unknown_preference" | "not_yours" | "already_decided" | "no_ward" | "no_patient" | "unreadable_rule", message: string) { super(message); }
}

export const FROM_NOW_ON = /^\W*(?:(?:hey\s+)?pisgah[,.!]?\s*)?(?:and\s+)?(?:from now on|going forward|in future|from today)\b/i;
const NOTE_WORDS: Record<string, RegExp> = { ward_round: /\bward[- ]round\b/, progress: /\bprogress\b/, nursing: /\bnursing\b/ };
const ITEM_WORDS: Record<string, RegExp> = {
  observation: /\b(obs|observations?|vitals|vital signs)\b/, medication: /\b(medications?|medicines?|drugs?|doses?)\b/,
  diet: /\b(diet|feeds?|feeding|fluids?)\b/, nursing: /\b(turns?|turning|pressure care|nursing care|wound care)\b/
};

// Reads a rule from words, by rule and with no model: a care-plan cadence for one kind of item, or the type of note; anything else is not a rule this memory keeps.
export function readRule(text: string): RuleReading | null {
  const low = text.toLowerCase().replace(/[’']/g, "'");
  const cadences = Object.keys(CADENCE_WORDS).filter((code) => cadenceSaid(code, low));
  const items = Object.entries(ITEM_WORDS).filter(([, re]) => re.test(low)).map(([k]) => k);
  const notes = Object.entries(NOTE_WORDS).filter(([, re]) => re.test(low)).map(([k]) => k);
  const isNote = /\bnotes?\b/.test(low);
  if (isNote && notes.length === 1 && !cadences.length) return { field: "note_type", item_kind: null, value: notes[0]! };
  if (cadences.length === 1 && items.length === 1) return { field: "care_plan_cadence", item_kind: items[0]!, value: cadences[0]! };
  return null;
}

const CADENCE_SAY: Record<string, string> = { OD: "once daily", BD: "twice daily", TDS: "three times a day", QID: "four times a day", q2h: "two hourly", q4h: "four hourly", q6h: "six hourly", q8h: "eight hourly", q12h: "twelve hourly", STAT: "stat", PRN: "as needed" };
// A plain description for the strip, built from the fields and never from model text.
export function describePref(p: Pick<Preference, "field" | "item_kind" | "value">): string {
  if (p.field === "note_type") return `notes as ${p.value.replace(/_/g, " ")} notes`;
  return `${p.item_kind ?? "care-plan"} items ${CADENCE_SAY[p.value] ?? p.value} (${p.value})`;
}
export function describeScope(s: PrefScope | null): string {
  if (!s) return "no scope chosen";
  return s.kind === "patient" ? "this patient only" : s.kind === "me" ? "your patients" : s.kind === "ward" ? `ward ${s.ward}` : "everyone";
}
export function describeSource(s: PrefSource, viewer: string | null = null): string {
  const said = s.quote ? ` "${s.quote.slice(0, 80)}"` : "";
  const mine = viewer === null || viewer === s.owner;
  if (s.kind === "external") return `a hospital rule added as text${said}`;
  return s.kind === "correction" ? `${mine ? "your" : "a colleague's"} correction${said}` : `${mine ? "you" : "a colleague"} said${said}`;
}

// A ward name as compared: lower case, letters and digits only.
export const wardKey = (w: string | null | undefined): string | null => {
  const k = (w ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return k || null;
};

// The one-word scope answer, or null when the words are not one.
export function scopeAnswer(text: string): ScopeKind | "no" | null {
  const t = text.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.split(" ").length > 5) return null;
  if (/^(?:no|nope|none|leave it|just (?:this|that) (?:one|entry)|only (?:this|that) (?:one|entry))$/.test(t)) return "no";
  if (/^(?:(?:just|only) )?(?:for )?(?:this|the) patient(?: only)?$|^patient(?: only)?$|^(?:just|only) (?:this|her|him)$/.test(t)) return "patient";
  if (/^(?:(?:just|only) )?(?:for )?(?:me|mine|myself|my patients)(?: only)?$/.test(t)) return "me";
  if (/^(?:(?:for )?(?:my|the|this) )?ward$/.test(t)) return "ward";
  if (/^(?:for )?(?:everyone|everybody|all of us|the whole hospital|all)$/.test(t)) return "everyone";
  return null;
}

// External rules outrank a clinician's own defaults; within each, the narrower scope wins.
const RANK: Record<ScopeKind, number> = { patient: 0, me: 1, ward: 2, everyone: 3 };
const rank = (p: Preference) => (p.source.kind === "external" ? 0 : 10) + RANK[p.scope!.kind];

// Which preference fills this field here, and every other one this owner may see with why it was not used.
export function choosePreference(prefs: readonly Preference[], at: PrefAt): PrefChoice {
  const same = prefs.filter((p) => p.field === at.field && (p.field !== "care_plan_cadence" || p.item_kind === at.item_kind));
  const here = wardKey(at.ward);
  const withheld: PrefChoice["withheld"] = [];
  const fits: Preference[] = [];
  for (const p of same) {
    const mine = p.owner === at.owner;
    if (p.state === "declined") continue;
    if (p.state === "candidate") { if (mine) withheld.push({ pref: p, reason: "no scope was chosen for it, so it stayed with the entry it came from" }); continue; }
    const s = p.scope!;
    if (s.kind === "patient") {
      if (!mine) continue;
      if (at.patient_id && s.patient_id === at.patient_id) fits.push(p); else withheld.push({ pref: p, reason: "its scope is another patient" });
    } else if (s.kind === "me") {
      if (mine) fits.push(p);
    } else if (s.kind === "ward") {
      if (here && wardKey(s.ward) === here) fits.push(p); else withheld.push({ pref: p, reason: here ? `its scope is ward ${s.ward} and this patient is on ${at.ward}` : `its scope is ward ${s.ward} and this patient's ward is not known` });
    } else fits.push(p);
  }
  fits.sort((a, b) => rank(a) - rank(b) || (a.decided!.at < b.decided!.at ? 1 : -1));
  const [applied, ...rest] = fits;
  for (const p of rest) if (p.value !== applied!.value) withheld.push({ pref: p, reason: `${describeSource(applied!.source, at.owner)} (${describeScope(applied!.scope)}) came first` });
  return { applied: applied ?? null, withheld };
}

const Z = { recorded_at: 0, occurred_at: 0 };

// The memory itself: candidates, scope decisions and external rules on one append-only stream, folded in memory.
export class PreferenceMemory {
  private readonly s: Stream;
  private readonly prefs = new Map<string, Preference>();

  constructor(storeRoot: string, private readonly now: () => Date = () => new Date()) {
    this.s = openStream(storeRoot, PREFERENCES_STREAM, { writer: true });
    for (const e of this.s.records()) this.fold(e.record_type, e.payload as Record<string, unknown>);
  }
  close(): void { this.s.close(); }

  private fold(type: string, x: Record<string, unknown>): void {
    if (type === "preference.candidate" || type === "preference.added") { const p = x["preference"] as Preference; this.prefs.set(p.pref_id, structuredClone(p)); return; }
    const p = this.prefs.get(String(x["pref_id"]));
    if (!p) return;
    if (type === "preference.scoped") { p.state = "active"; p.scope = x["scope"] as PrefScope; p.decided = x["decided"] as Preference["decided"]; }
    if (type === "preference.declined") { p.state = "declined"; p.decided = x["decided"] as Preference["decided"]; }
  }
  private append(type: string, payload: Record<string, unknown>): void {
    this.s.append(type, payload, Z);
    this.fold(type, payload);
  }

  get(id: string): Preference | null { const p = this.prefs.get(id); return p ? structuredClone(p) : null; }
  all(): Preference[] { return [...this.prefs.values()].map((p) => structuredClone(p)); }
  // What one owner may see: their own, and any rule shared with a ward or everyone.
  visibleTo(owner: string): Preference[] { return this.all().filter((p) => p.owner === owner || (p.state === "active" && (p.scope?.kind === "ward" || p.scope?.kind === "everyone"))); }
  choose(at: PrefAt): PrefChoice { return choosePreference(this.all(), at); }

  // A correction or a "from now on" becomes a candidate only; it fills nothing until its owner picks a scope.
  candidate(c: { owner: string; reading: RuleReading; source: Omit<PrefSource, "at" | "owner">; patient_id: string | null; ward: string | null }): Preference {
    const at = this.now().toISOString();
    const p: Preference = {
      pref_id: `pf-${shortHash(c.owner, c.reading.field, c.reading.item_kind ?? "", c.reading.value, c.source.line_id ?? "", this.prefs.size + 1)}`,
      owner: c.owner, field: c.reading.field, item_kind: c.reading.item_kind, value: c.reading.value, state: "candidate", scope: null,
      source: { ...c.source, owner: c.owner, quote: c.source.quote.slice(0, 300), at }, origin: { patient_id: c.patient_id, ward: c.ward }, decided: null
    };
    this.append("preference.candidate", { preference: p });
    return structuredClone(p);
  }

  // The owner's scope decision, by one word or on the strip; "no" declines it, and nobody else may decide for them.
  decide(id: string, by: string, answer: ScopeKind | "no", via: "word" | "strip", lineId: string | null = null): Preference {
    const p = this.prefs.get(id);
    if (!p) throw new PreferenceError("unknown_preference", "no such preference");
    if (p.owner !== by) throw new PreferenceError("not_yours", "only the clinician whose preference it is may choose its scope");
    if (p.state !== "candidate") throw new PreferenceError("already_decided", `the preference is already ${p.state}`);
    const decided = { by, at: this.now().toISOString(), via, line_id: lineId };
    if (answer === "no") { this.append("preference.declined", { pref_id: id, decided }); return this.get(id)!; }
    const scope = this.scopeFrom(answer, p.origin);
    this.append("preference.scoped", { pref_id: id, scope, decided });
    return this.get(id)!;
  }

  // A rule given as text by a person, under the scope they name; it is active at once because the person chose its scope.
  external(e: { by: string; text: string; scope: Exclude<ScopeKind, "patient">; ward?: string | null }): Preference {
    const reading = readRule(e.text);
    if (!reading) throw new PreferenceError("unreadable_rule", "the text names no care-plan cadence for one kind of item and no note type");
    const at = this.now().toISOString();
    const scope = this.scopeFrom(e.scope, { patient_id: null, ward: e.ward ?? null });
    const p: Preference = {
      pref_id: `pf-${shortHash(e.by, "external", e.text, this.prefs.size + 1)}`, owner: e.by, field: reading.field, item_kind: reading.item_kind, value: reading.value,
      state: "active", scope, source: { kind: "external", owner: e.by, task_id: null, line_id: null, quote: e.text.slice(0, 300), at }, origin: { patient_id: null, ward: e.ward ?? null },
      decided: { by: e.by, at, via: "added", line_id: null }
    };
    this.append("preference.added", { preference: p });
    return structuredClone(p);
  }

  private scopeFrom(kind: ScopeKind, origin: Preference["origin"]): PrefScope {
    if (kind === "patient") { if (!origin.patient_id) throw new PreferenceError("no_patient", "no patient is known for this preference"); return { kind, patient_id: origin.patient_id }; }
    if (kind === "ward") { if (!wardKey(origin.ward)) throw new PreferenceError("no_ward", "no ward is known for this preference"); return { kind, ward: origin.ward! }; }
    return { kind };
  }
}
