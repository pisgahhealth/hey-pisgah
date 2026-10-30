import { computeFacts } from "./facts.js";
import { isUrgent, payloadHash, type Memo } from "./memo.js";
import { sourcesHash, type NightSources } from "./sources.js";

export type CheckCode =
  | "stale_sources" | "unsupported_fact" | "invented_figure" | "unlabelled" | "uncited" | "false_completion" | "unknown_item" | "missing_open_item"
  | "missing_urgent" | "patient_name" | "unauthorised_encounter" | "preview_leak";
export type CheckFailure = { item: string; code: CheckCode; detail: string };
// Three outcomes kept apart: verified, unsupported or incomplete with the failures, and a checker that broke, which is never a pass.
export type Verdict =
  | { status: "verified"; payload_hash: string; sources_hash: string; failures: []; checked_at: string }
  | { status: "unsupported_or_incomplete"; payload_hash: string; sources_hash: string; failures: CheckFailure[]; checked_at: string }
  | { status: "verifier_error"; payload_hash: string | null; sources_hash: string | null; failures: []; error: string; checked_at: string };

const numbers = (t: string) => (t.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

// The deterministic checks a memo must pass before it is published, against the exact payload and the source version it was built from.
export function checkMemo(m: Memo, s: NightSources): CheckFailure[] {
  const f: CheckFailure[] = [];
  if (m.sources_hash !== sourcesHash(s)) f.push({ item: m.memo_id, code: "stale_sources", detail: "the memo was built from another version of the day's records" });
  const truth = new Map(computeFacts(s).map((x) => [x.fact_id, x]));
  const events = new Set(s.cases.flatMap((c) => c.events.map((e) => e.event_id)));
  for (const x of m.facts) {
    const t = truth.get(x.fact_id);
    if (!t) { f.push({ item: x.fact_id, code: "unsupported_fact", detail: "no computed fact has this id" }); continue; }
    if (x.value !== t.value || x.text !== t.text) f.push({ item: x.fact_id, code: "invented_figure", detail: `the records give ${t.value}, the memo says ${x.value}` });
    if (!x.refs.length || x.refs.some((r) => !events.has(r))) f.push({ item: x.fact_id, code: "unsupported_fact", detail: "a fact must cite events that exist in the day's records" });
  }
  const facts = new Map(m.facts.map((x) => [x.fact_id, x]));
  for (const c of [...m.suspected_causes, ...m.proposed_changes]) {
    const want = "scope" in c ? "proposed change" : "suspected cause";
    if (c.label !== want) f.push({ item: c.finding_id, code: "unlabelled", detail: `this statement must be labelled ${want}` });
    const cited = c.cites.map((id) => facts.get(id));
    if (!c.cites.length || cited.some((x) => !x)) { f.push({ item: c.finding_id, code: "uncited", detail: "it must cite facts that are in this memo" }); continue; }
    // A number in a cause or a change must be one of the figures it cites, so no figure is made up in prose.
    const allowed = new Set(cited.flatMap((x) => [x!.value, ...numbers(x!.text)]));
    const bad = numbers(c.text).filter((n) => !allowed.has(n));
    if (bad.length) f.push({ item: c.finding_id, code: "invented_figure", detail: `${bad.join(", ")} is not a figure of the facts it cites` });
  }
  const open = new Map(s.open.map((i) => [i.item_id, i]));
  const recipient = s.recipients.find((r) => r.id === m.recipient_id);
  const now = new Date(m.day.length > 10 ? m.day : `${m.day}T23:59:59.000Z`);
  for (const i of m.unfinished) {
    const src = open.get(i.item_id);
    if (!src) { f.push({ item: i.item_id, code: "unknown_item", detail: "no open item in the records has this id" }); continue; }
    if (src.state === "done") f.push({ item: i.item_id, code: "false_completion", detail: "the records show this done, the memo lists it open" });
    const want = isUrgent(src, now) && src.state !== "failed" ? "overdue" : src.state;
    if (i.state !== want) f.push({ item: i.item_id, code: i.state === "done" ? "false_completion" : "unknown_item", detail: `the records show ${want}, the memo says ${i.state}` });
    if (i.encounter !== null && !(recipient?.authorised.includes(i.encounter) && i.encounter === src.encounter)) f.push({ item: i.item_id, code: "unauthorised_encounter", detail: "the encounter is named to a recipient the record does not authorise for it" });
  }
  // Completeness against the records, not against the memo's own list: every open item this recipient should see is there.
  if (recipient) {
    for (const src of s.open.filter((i) => i.state !== "done" && (i.owner === recipient.id || (recipient.incoming && i.department === recipient.department)))) {
      if (!m.unfinished.some((i) => i.item_id === src.item_id)) f.push({ item: src.item_id, code: "missing_open_item", detail: "the records show this open for the recipient and the memo leaves it out" });
      if (isUrgent(src, now) && !m.urgent.some((i) => i.item_id === src.item_id)) f.push({ item: src.item_id, code: "missing_urgent", detail: "an overdue or failed item must be surfaced as urgent" });
    }
  }
  for (const i of m.urgent) if (!m.unfinished.some((u) => u.item_id === i.item_id && u.state === i.state)) f.push({ item: i.item_id, code: "unknown_item", detail: "an urgent item must be one of the unfinished items" });
  // No patient name anywhere in the payload; names are shown only inside the EMR, from the encounter id, to someone authorised.
  const text = strings(m).join("\n").toLowerCase();
  for (const name of s.labels.filter((l) => l.trim().length >= 3)) if (text.includes(name.toLowerCase())) f.push({ item: m.memo_id, code: "patient_name", detail: "a patient's name is in the memo" });
  const pv = m.preview.toLowerCase();
  if (s.open.some((i) => pv.includes(i.encounter.toLowerCase())) || s.labels.some((l) => l.trim().length >= 3 && pv.includes(l.toLowerCase())) || /[0-9a-f]{8}-[0-9a-f]{4}/.test(pv)) f.push({ item: m.memo_id, code: "preview_leak", detail: "the preview names a patient or an encounter" });
  return f;
}

// The checker in the publication path; an exception is a verifier error, never a pass and never a disproved claim.
export function verifyMemo(m: Memo, s: NightSources, check: (m: Memo, s: NightSources) => CheckFailure[] = checkMemo, now: () => Date = () => new Date()): Verdict {
  const checked_at = now().toISOString();
  try {
    const failures = check(m, s);
    const base = { payload_hash: payloadHash(m), sources_hash: sourcesHash(s), checked_at };
    return failures.length ? { status: "unsupported_or_incomplete", ...base, failures } : { status: "verified", ...base, failures: [] };
  } catch (e) {
    return { status: "verifier_error", payload_hash: null, sources_hash: null, failures: [], error: e instanceof Error ? e.message.slice(0, 300) : "checker failed", checked_at };
  }
}
