import type { RunResult, SimEvent } from "@hey-pisgah/contracts";

// What one rerun left behind, as a multiset of effect keys with no times or order, plus the final outcome and a safety flag.
export type RerunEffects = { effects: string[]; final_outcome: string; unsafe: boolean };
export type RerunRunner = { reset: (caseId: string, rerun: number) => void | Promise<void>; run: (caseId: string, rerun: number) => RerunEffects | Promise<RerunEffects> };

// Effect keys from a definition-executor run: completed steps with the source versions they captured, revisions, final record versions and facts.
export function effectsFromRun(run: RunResult): RerunEffects {
  if (run.outcome !== "ok") return { effects: [], final_outcome: "aborted", unsafe: true };
  const p = (e: SimEvent) => (e.payload ?? {}) as Record<string, unknown>;
  const effects: string[] = [];
  for (const e of run.events) {
    if (e.kind === "step.completed") effects.push(`completed:${String(p(e)["step_id"])}`);
    if (e.kind === "document.revised") effects.push(`revised:${String(p(e)["document_id"])}.${String(p(e)["stage"])}`);
  }
  const fs = run.final_state as { facts?: Record<string, unknown>; records?: Record<string, number> };
  for (const [k, v] of Object.entries(fs.records ?? {})) effects.push(`record:${k}@${v}`);
  for (const [k, v] of Object.entries(fs.facts ?? {})) effects.push(`fact:${k}=${JSON.stringify(v)}`);
  return { effects: effects.sort(), final_outcome: run.metrics.terminal_state, unsafe: run.metrics.prohibited_executed > 0 };
}

const counts = (xs: readonly string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());

export type RerunDiff = { rerun: number; omissions: number; duplicates: number; incorrect: number; inconsistent_outcome: boolean; unsafe: boolean };
// Compares a rerun with the reference by multiset: missing keys are omissions, extra copies of a reference key duplicates, new keys incorrect effects.
export function diffEffects(ref: RerunEffects, r: RerunEffects, rerun: number): RerunDiff {
  const a = counts(ref.effects), b = counts(r.effects);
  let omissions = 0, duplicates = 0, incorrect = 0;
  for (const [k, n] of a) omissions += Math.max(0, n - (b.get(k) ?? 0));
  for (const [k, n] of b) { if (a.has(k)) duplicates += Math.max(0, n - a.get(k)!); else incorrect += n; }
  return { rerun, omissions, duplicates, incorrect, inconsistent_outcome: ref.final_outcome !== r.final_outcome, unsafe: r.unsafe };
}

export type ReliabilityCase = { case_id: string; reruns: number; consistent: boolean; differences: number; unsafe: boolean; diffs: RerunDiff[]; outcomes: string[] };
export type ReliabilityTable = { reruns: number; cases: ReliabilityCase[]; consistent_cases: number; differences: number; unsafe_cases: number; omissions: number; duplicates: number; incorrect: number; inconsistent_outcomes: number };

// FR-4: resets state before each rerun, runs every case the given number of times and compares effect sets with the first rerun.
export async function rerunHarness(caseIds: readonly string[], runner: RerunRunner, reruns = 5): Promise<ReliabilityTable> {
  const cases: ReliabilityCase[] = [];
  for (const id of caseIds) {
    const got: RerunEffects[] = [];
    for (let i = 0; i < reruns; i++) {
      await runner.reset(id, i);
      got.push(await runner.run(id, i));
    }
    const diffs = got.slice(1).map((r, i) => diffEffects(got[0]!, r, i + 1));
    const differences = diffs.reduce((s, d) => s + d.omissions + d.duplicates + d.incorrect + (d.inconsistent_outcome ? 1 : 0), 0);
    cases.push({ case_id: id, reruns, consistent: differences === 0, differences, unsafe: got.some((g) => g.unsafe), diffs, outcomes: got.map((g) => g.final_outcome) });
  }
  const sum = (f: (d: RerunDiff) => number) => cases.reduce((s, c) => s + c.diffs.reduce((t, d) => t + f(d), 0), 0);
  return {
    reruns, cases, consistent_cases: cases.filter((c) => c.consistent).length, differences: cases.reduce((s, c) => s + c.differences, 0), unsafe_cases: cases.filter((c) => c.unsafe).length,
    omissions: sum((d) => d.omissions), duplicates: sum((d) => d.duplicates), incorrect: sum((d) => d.incorrect), inconsistent_outcomes: sum((d) => (d.inconsistent_outcome ? 1 : 0))
  };
}
