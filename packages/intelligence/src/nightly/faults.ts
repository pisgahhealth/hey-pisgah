import type { Memo } from "./memo.js";
import { heldTransport, memoPublisher, sendOnVerdict } from "./publish.js";
import type { NightSources } from "./sources.js";
import { verifyMemo } from "./verify.js";

// A name no real record carries, planted when the day has no patient label of its own.
const PLANTED_NAME = "Zz Planted Name";

// The faults the publication path must refuse, built from this run's own memos; a fault that needs a part no memo has is listed as not applicable, never as passed.
export async function plantedFaults(s: NightSources, memos: readonly Memo[], now: Date): Promise<{ tried: number; refused: number; cases: Record<string, string>; not_applicable: string[] }> {
  const withFacts = memos.find((m) => m.facts.length > 0) ?? null;
  const withItems = memos.find((m) => m.unfinished.length > 0) ?? null;
  const any = withFacts ?? withItems ?? memos[0] ?? null;
  const cases: Record<string, string> = {};
  const notApplicable: string[] = [];
  const publish = async (src: NightSources, m: Memo) => (await memoPublisher({ sources: src, transport: heldTransport(), now: () => now }).publish(m)).verdict.status;
  if (withFacts) {
    const f0 = withFacts.facts[0]!;
    cases["invented_figure"] = await publish(s, { ...withFacts, facts: withFacts.facts.map((f) => (f === f0 ? { ...f, value: f.value + 7 } : f)) });
  } else notApplicable.push("invented_figure");
  if (withItems) {
    const alter = (f: (i: Memo["unfinished"][number]) => Memo["unfinished"][number]): Memo => {
      const unfinished = withItems.unfinished.map((i, k) => (k === 0 ? f(i) : i));
      return { ...withItems, unfinished, urgent: withItems.urgent.map((u) => unfinished.find((i) => i.item_id === u.item_id) ?? u) };
    };
    cases["false_completion"] = await publish(s, alter((i) => ({ ...i, state: "done" as const })));
    // The item's id and state stay the record's; only what it asks, where it goes or when it is due is changed.
    cases["altered_description"] = await publish(s, alter((i) => ({ ...i, title: `${i.title} (changed)` })));
    cases["altered_destination"] = await publish(s, alter((i) => ({ ...i, department: i.department === "nurse" ? "doctor" : "nurse" })));
    cases["altered_due_date"] = await publish(s, alter((i) => ({ ...i, due_at: i.due_at ? new Date(Date.parse(i.due_at) + 86_400_000).toISOString() : now.toISOString() })));
  } else notApplicable.push("false_completion", "altered_description", "altered_destination", "altered_due_date");
  if (any) {
    const name = s.labels[0] ?? PLANTED_NAME;
    const src = s.labels.length ? s : { ...s, labels: [PLANTED_NAME] };
    cases["patient_name"] = await publish(src, { ...any, preview: `${any.preview} ${name}` });
    const v = verifyMemo(any, s);
    cases["changed_after_verification"] = (await sendOnVerdict({ ...any, preview: `${any.preview} ` }, v, heldTransport())).reason;
    cases["checker_error"] = (await memoPublisher({ sources: s, transport: heldTransport(), check: () => { throw new Error("checker failed"); } }).publish(any)).verdict.status;
  } else notApplicable.push("patient_name", "changed_after_verification", "checker_error");
  const refused = Object.values(cases).filter((x) => x !== "verified" && x !== "delivered").length;
  return { tried: Object.keys(cases).length, refused, cases, not_applicable: notApplicable };
}
