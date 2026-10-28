import { checkTwoClock, type RunResult, type WorkflowDefinition } from "@hey-pisgah/contracts";
import { loadHandCase, loadV1, worldRules } from "@hey-pisgah/hospital";
import { runHistorical } from "@hey-pisgah/hospital/historical";
import { runDefinition, type ExternalSchedule } from "@hey-pisgah/simulator";
import { applyOperations } from "@hey-pisgah/workflow";
import type { Family, Manifest } from "./types.js";

// Generator assertions G1 to G6 as numbers; the evaluator calls these on reserved cases through its sealed command.
export type Checked = { schedule: ExternalSchedule; manifest: Manifest; texts: unknown };

const v1 = loadV1();
const world = worldRules();
const hand = loadHandCase();
const apply = (ops: unknown[]): WorkflowDefinition => {
  const r = applyOperations(v1, ops);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join("; "));
  return r.definition;
};
export const LEARNED = apply(hand.g2.ops);
export const LEARNED_AFTER_ORDER = apply(hand.g2.after_order_ops);
const ok = (r: RunResult): Extract<RunResult, { outcome: "ok" }> => {
  if (r.outcome !== "ok") throw new Error(`run aborted for ${r.case_id}: ${r.invariant_violations.join("; ")}`);
  return r;
};
export const runV1 = (s: ExternalSchedule) => ok(runDefinition(v1, s, { world }));
export const runLearned = (s: ExternalSchedule, def: WorkflowDefinition = LEARNED) => ok(runDefinition(def, s, { world }));
const wait = (r: Extract<RunResult, { outcome: "ok" }>) => {
  if (r.metrics.post_signoff_wait_min === null) throw new Error(`no departure for ${r.case_id}`);
  return r.metrics.post_signoff_wait_min;
};
const quantile = (xs: number[], q: number): number => { const y = [...xs].sort((a, b) => a - b); return y[Math.floor(q * (y.length - 1))] ?? NaN; };
const median = (xs: number[]) => quantile(xs, 0.5);
const spread = (xs: number[]) => ({ n: xs.length, min: Math.min(...xs), median: median(xs), max: Math.max(...xs) });

// The upper edge of a normal occurred-clock wait: the base value's 100 minutes plus a 20 minute grace.
export const NORMAL_WAIT_MAX = 120;

// G1: late entry looks like a delay only on the recorded clock; measured on v1 by the definition executor at departure's recorded time.
export function g1(cases: Checked[]) {
  const rows = cases.map((c) => {
    const r = runV1(c.schedule);
    const so = r.step_times["st05"]!.completed_occ!;
    return { case_id: c.manifest.case_id, family: c.manifest.family, occurred: wait(r), recorded: r.step_times["st16"]!.completed_rec! - so };
  });
  const p90 = quantile(rows.filter((r) => r.family !== "F3").map((r) => r.recorded), 0.9);
  const f3 = rows.filter((r) => r.family === "F3");
  return { non_f3_p90: p90, f3, pass: f3.length > 0 && f3.every((r) => r.occurred <= NORMAL_WAIT_MAX && r.recorded > p90) };
}

// G2: the learned pair (soft edge removed, draft triggered on the round entry) on the definition executor with the agent preparing.
export function g2(cases: Checked[]) {
  const by: Partial<Record<Family, number[]>> = {};
  const byOrder: Partial<Record<Family, number[]>> = {};
  for (const c of cases) {
    const base = wait(runV1(c.schedule));
    (by[c.manifest.family] ??= []).push(base - wait(runLearned(c.schedule)));
    (byOrder[c.manifest.family] ??= []).push(base - wait(runLearned(c.schedule, LEARNED_AFTER_ORDER)));
  }
  const fams = Object.keys(by) as Family[];
  const f1 = by.F1 ?? [];
  const others = (["F2", "F3", "F4", "F5"] as Family[]).flatMap((f) => by[f] ?? []);
  return {
    cut_by_family: Object.fromEntries(fams.map((f) => [f, spread(by[f]!)])),
    cut_by_family_after_order: Object.fromEntries(fams.map((f) => [f, spread(byOrder[f]!)])),
    pass: f1.length > 0 && f1.every((x) => x >= 60) && others.every((x) => x < 10)
  };
}

const EARLY_NURSE: Record<string, string> = { A: "n_a2", B: "n_b2", C: "n_c2" };

// G3: comparing early-drafting histories with late-document histories overstates what early drafting itself buys in the same worlds.
export function g3(cases: Checked[]) {
  const hist = (s: ExternalSchedule) => wait(ok(runHistorical(s)));
  const f1 = cases.filter((c) => c.manifest.family === "F1");
  const f7 = cases.filter((c) => c.manifest.family === "F7");
  if (f1.length === 0 || f7.length === 0) return { applicable: false as const };
  const f1h = f1.map((c) => hist(c.schedule));
  const naive = median(f1h) - median(f7.map((c) => hist(c.schedule)));
  const matched = median(f1.map((c, i) => f1h[i]! - hist({ ...c.schedule, actors: { ...c.schedule.actors, nurse: EARLY_NURSE[c.manifest.ward_id]! } })));
  const g2F1 = median(f1.map((c) => wait(runV1(c.schedule)) - wait(runLearned(c.schedule))));
  return { applicable: true as const, naive, matched_habit_effect: matched, overstatement: naive - matched, g2_f1_median_cut: g2F1, pass: naive - matched >= 15 };
}

// The deny list plus the generator's own vocabulary; no fixture string may contain any of them.
export const DENY: readonly RegExp[] = [
  /before[\s_-]*sign[\s_-]*off/i, /\bearlier\b/i, /\bin[\s_-]+advance\b/i, /\bparallel\b/i, /\bdraft[\s_-]+first\b/i, /early[\s_-]*summary/i,
  /pre[\s_-]*signoff/i, /prep[\s_-]*in[\s_-]*advance/i, /reasoning[\s_-]+strength/i, /\bbottleneck/i, /\bdelay[\s_-]+cause/i, /\broot[\s_-]+cause/i,
  /\bfix(es|ed|ing)?\b/i, /\bimprovement/i, /\bF(?:[1-9]|1[0-2]|V)\b/
];
export const GENERATOR_VOCAB: readonly RegExp[] = [
  /famil(y|ies)/i, /\btrap/i, /canary/i, /manifest/i, /\bseed/i, /oracle/i, /confound/i, /injection/i, /overlay/i, /\bvariant/i,
  /should[\s_-]*apply/i, /acceptable/i, /\bhint/i, /\bcause/i, /calibrat/i, /\b[GT][1-6]\b/, /\bdp\d{2}\b/, /reserved/i, /early[\s_-]*draft/i, /late[\s_-]*doc/i
];

export function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out); }
  return out;
}

// G4: no free text or key in a case carries a family name, a denied term or generator vocabulary.
export function g4(cases: Checked[]) {
  const hits: string[] = [];
  for (const c of cases) for (const s of strings(c.texts)) for (const w of [...DENY, ...GENERATOR_VOCAB]) if (w.test(s)) hits.push(`${c.manifest.case_id}: ${w.source} in "${s.slice(0, 60)}"`);
  return { hits, pass: hits.length === 0 };
}

// G5: every event in v1, learned and historical runs obeys the two-clock rule.
export function g5(cases: Checked[]) {
  let events = 0;
  const bad: string[] = [];
  for (const c of cases) for (const r of [runV1(c.schedule), runLearned(c.schedule), ok(runHistorical(c.schedule))]) {
    for (const e of r.events) { events += 1; const t = checkTwoClock(e); if (!t.ok) bad.push(`${c.manifest.case_id} ${r.executor} seq ${e.seq} ${t.reason}`); }
  }
  return { events, violations: bad, pass: bad.length === 0 };
}
