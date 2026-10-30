import { canonical, sha256 } from "@hey-pisgah/contracts";
import type { Fact } from "./facts.js";
import { itemIsFor, sourcesHash, type NightSources, type OpenItem, type Recipient } from "./sources.js";

// A suspected cause or a proposed change as one investigator put it, with the facts it cites and what the critic round said.
export type Finding = { finding_id: string; department: string; text: string; cites: string[]; critic: { by: string; verdict: "holds" | "challenged"; reason: string } | null };
export type Proposed = Finding & { scope: "department" | "ward" | "hospital" };
export type Investigation = { department: string; causes: Finding[]; changes: Proposed[]; nothing_warrants_change: boolean; model: string | null; calls: number; cost_usd: number };
// One unfinished item in a memo; the encounter is named only to a recipient the record authorises for it, and the name itself is shown only inside the EMR.
export type MemoItem = { item_id: string; kind: string; title: string; state: OpenItem["state"]; due_at: string | null; refs: string[]; encounter: string | null; department: string };
export type Memo = {
  memo_id: string; recipient_id: string; day: string; sources_hash: string;
  facts: Fact[];
  suspected_causes: (Finding & { label: "suspected cause" })[];
  proposed_changes: (Proposed & { label: "proposed change" })[];
  unfinished: MemoItem[]; urgent: MemoItem[];
  nothing_warrants_change: boolean;
  // The bell's preview: counts only, no patient, no encounter.
  preview: string;
};

export const isUrgent = (i: OpenItem, now: Date): boolean => i.state === "failed" || i.state === "overdue" || (i.due_at !== null && i.state !== "done" && Date.parse(i.due_at) < now.getTime());

// Builds one recipient's memo from the computed facts, the investigations and the open work; nothing here calls a model.
export function composeMemo(s: NightSources, r: Recipient, facts: readonly Fact[], inv: readonly Investigation[], now: Date): Memo {
  // A clinician sees their own department's facts and the ward's; department summaries stay aggregate.
  const mine = facts.filter((f) => f.department === r.department || f.department === "ward");
  const ids = new Set(mine.map((f) => f.fact_id));
  const relevant = inv.filter((i) => i.department === r.department);
  const cites = (f: Finding) => f.cites.every((c) => ids.has(c));
  const items: MemoItem[] = s.open.filter((i) => i.state !== "done" && itemIsFor(r, i))
    .map((i) => ({ item_id: i.item_id, kind: i.kind, title: i.title, state: isUrgent(i, now) && i.state !== "failed" ? "overdue" : i.state, due_at: i.due_at, refs: i.refs, encounter: r.authorised.includes(i.encounter) ? i.encounter : null, department: i.department }));
  const causes = relevant.flatMap((i) => i.causes).filter(cites).map((c) => ({ ...c, label: "suspected cause" as const }));
  const changes = relevant.flatMap((i) => i.changes).filter(cites).map((c) => ({ ...c, label: "proposed change" as const }));
  const urgent = items.filter((i) => i.state === "overdue" || i.state === "failed");
  const body = { recipient_id: r.id, day: s.day, sources_hash: sourcesHash(s), facts: mine, suspected_causes: causes, proposed_changes: changes, unfinished: items, urgent, nothing_warrants_change: changes.length === 0 };
  return { memo_id: `m-${sha256(canonical(body)).slice(0, 8)}`, ...body, preview: previewOf(items.length, urgent.length, mine.length) };
}

export const previewOf = (open: number, urgent: number, facts: number): string =>
  `Night memo: ${facts} recorded facts, ${open} unfinished item${open === 1 ? "" : "s"} for you${urgent ? `, ${urgent} urgent` : ""}.`;

// The exact payload a verdict covers; any change to it after the check makes the verdict stale.
export const payloadHash = (m: Memo): string => sha256(canonical(m));
