import { computeFacts } from "./facts.js";
import { composeMemo, type Investigation, type Memo } from "./memo.js";
import type { MemoRepair } from "./publish.js";
import type { NightSources } from "./sources.js";
import type { CheckFailure } from "./verify.js";

// Codes a repair from the records can answer by dropping the statement or rebuilding from the computed facts and the open work.
const STATEMENT_CODES = new Set<CheckFailure["code"]>(["invented_figure", "uncited", "unlabelled", "unsupported_fact"]);

// The one bounded repair, from the records and with no model: rebuild the memo from the computed facts and open work, leaving out every cause or change that failed; it never adds a statement.
export function repairFromRecords(s: NightSources, inv: readonly Investigation[], now: Date, dropped: { memo_id: string; finding_id: string; code: string; detail: string }[] = []): MemoRepair {
  return async (m: Memo, failures: readonly CheckFailure[]): Promise<Memo> => {
    const r = s.recipients.find((x) => x.id === m.recipient_id);
    if (!r) return m;
    const bad = new Set(failures.filter((f) => STATEMENT_CODES.has(f.code)).map((f) => f.item));
    for (const f of failures) if (bad.has(f.item) && f.item.match(/^(sc|pc)-/)) dropped.push({ memo_id: m.memo_id, finding_id: f.item, code: f.code, detail: f.detail });
    const kept = inv.map((i) => ({ ...i, causes: i.causes.filter((c) => !bad.has(c.finding_id)), changes: i.changes.filter((c) => !bad.has(c.finding_id)) }));
    return composeMemo(s, r, computeFacts(s), kept, now);
  };
}
