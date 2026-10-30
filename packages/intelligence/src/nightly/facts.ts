import { departmentOf, type DayEvent, type NightSources } from "./sources.js";

// A recorded fact: one computed figure, the sentence built from it by rule, and the events it was computed from.
export type Fact = { fact_id: string; department: string; name: FactName; value: number; text: string; refs: string[]; computed: string };
export const FACT_NAMES = ["records_proved", "records_unverified", "writes_refused", "questions_asked", "questions_answered", "instructions_refused", "signoff_to_cleared_median_min"] as const;
export type FactName = (typeof FACT_NAMES)[number];

const COUNTED: Record<Exclude<FactName, "signoff_to_cleared_median_min">, { kind: string; by: "agent" | "person"; text: (d: string, n: number, c: number) => string; computed: string }> = {
  records_proved: { kind: "record.proved", by: "agent", text: (d, n, c) => `The ${d}'s agent proved ${n} records by a fresh read across ${c} journeys.`, computed: "count of record.proved events by the department's agent" },
  records_unverified: { kind: "record.unverified", by: "agent", text: (d, n, c) => `The ${d}'s agent wrote ${n} records that no read the EMR offers could show, across ${c} journeys.`, computed: "count of record.unverified events by the department's agent" },
  writes_refused: { kind: "write.refused", by: "agent", text: (d, n, c) => `The EMR refused ${n} writes from the ${d}'s agent across ${c} journeys.`, computed: "count of write.refused events by the department's agent" },
  questions_asked: { kind: "question.asked", by: "agent", text: (d, n, c) => `The ${d}'s agent asked ${n} questions across ${c} journeys.`, computed: "count of question.asked events by the department's agent" },
  questions_answered: { kind: "question.answered", by: "person", text: (d, n, c) => `The ${d} answered ${n} questions across ${c} journeys.`, computed: "count of question.answered events by the department's people" },
  instructions_refused: { kind: "instruction.refused", by: "agent", text: (d, n, c) => `The ${d}'s agent left ${n} instructions that were not its to do, across ${c} journeys.`, computed: "count of instruction.refused events by the department's agent" }
};
const MAX_REFS = 8;
const words = (d: string) => d.replace(/_/g, " ");
const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

// Every fact the day's events support, computed by rule; the same function checks a memo's figures, so a memo cannot carry a figure this does not reproduce.
export function computeFacts(s: NightSources): Fact[] {
  const out: Fact[] = [];
  const all = s.cases.flatMap((c) => c.events);
  const depts = [...new Set(all.map((e) => departmentOf(e)).filter((d): d is string => !!d))].sort();
  for (const d of depts) {
    for (const [name, spec] of Object.entries(COUNTED) as [keyof typeof COUNTED, (typeof COUNTED)[keyof typeof COUNTED]][]) {
      const hits = all.filter((e) => e.kind === spec.kind && departmentOf(e) === d && (spec.by === "agent" ? e.actor_role === "agent" : e.actor_role !== "agent"));
      if (!hits.length) continue;
      const cases = new Set(hits.map((e) => e.case_id)).size;
      out.push({ fact_id: `f-${d}-${name}`, department: d, name, value: hits.length, text: spec.text(words(d), hits.length, cases), refs: hits.slice(0, MAX_REFS).map((e) => e.event_id), computed: spec.computed });
    }
  }
  // The ward's own figure: minutes from the clinical sign-off seen to the patient cleared, per journey, as a median.
  const spans: { min: number; refs: string[] }[] = [];
  for (const c of s.cases) {
    const at = (step: string) => c.events.find((e: DayEvent) => e.kind === "step.observed" && e.subject === step);
    const a = at("st05"), b = at("st13");
    if (a && b && b.occurred_at >= a.occurred_at) spans.push({ min: b.occurred_at - a.occurred_at, refs: [a.event_id, b.event_id] });
  }
  const m = median(spans.map((x) => x.min));
  if (m !== null) out.push({ fact_id: "f-ward-signoff_to_cleared_median_min", department: "ward", name: "signoff_to_cleared_median_min", value: m, text: `From the clinical sign-off to the patient cleared took a median of ${m} minutes over ${spans.length} journeys.`, refs: spans.flatMap((x) => x.refs).slice(0, MAX_REFS), computed: "median of minutes from the sign-off seen to the clearance seen, per journey" });
  return out;
}
