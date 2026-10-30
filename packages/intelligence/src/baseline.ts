import { sha256, type Operation, type RunResult, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import type { CaseFile } from "@hey-pisgah/cases";
import { worldRules } from "@hey-pisgah/hospital";
import { runDefinition } from "@hey-pisgah/simulator";
import type { Facts } from "@hey-pisgah/workflow";
import { derivedStatistics, stepTimes } from "./stats.js";
import { OP_KINDS, evaluateCell, scopedOperations, type SweepCell } from "./sweep.js";
import type { PoolCase } from "./pool.js";

type Ok = Extract<RunResult, { outcome: "ok" }>;
export type BaselineOrder = "committed" | "shuffled";
export type BaselineResult = { order: BaselineOrder; budget: number; simulations: number; cells: number; singles: number; top: SweepCell[]; reference_sum: number; found_at: number | null; found: SweepCell | null; cases: string[]; scope: string[] };

// The cases with the longest recorded wait from the clinical sign-off to departure, as the search's matched cases.
export function longestWaitCases(cases: readonly PoolCase[], n = 6): string[] {
  const wait = (c: PoolCase) => { const t = stepTimes(c.events); const a = t.get("st05")?.done, b = t.get("st16")?.done; return a !== undefined && b !== undefined ? b - a : -1; };
  return [...cases].filter((c) => c.file).sort((x, y) => wait(y) - wait(x) || x.case_id.localeCompare(y.case_id)).slice(0, n).map((c) => c.case_id);
}

// Combinations of the singles by size, in index order and lazily.
function* combos(n: number, maxSize: number): Generator<number[]> {
  for (let size = 1; size <= maxSize; size++) {
    const idx = Array.from({ length: size }, (_, i) => i);
    if (size > n) return;
    for (;;) {
      yield [...idx];
      let i = size - 1;
      while (i >= 0 && idx[i] === n - size + i) i--;
      if (i < 0) break;
      idx[i]! += 1;
      for (let j = i + 1; j < size; j++) idx[j] = idx[j - 1]! + 1;
    }
  }
}

// A constrained search with no model: every single, pair and triple of the scoped operations, run on matched cases until the simulation budget is spent; found means a cell reproduces the planted change's per-case waits.
export function searchBaseline(o: { base: WD; cases: readonly PoolCase[]; files: (id: string) => CaseFile | null; caseFacts: readonly Facts[]; budget: number; order: BaselineOrder; reference: readonly Operation[]; topK?: number; maxSize?: number }): BaselineResult {
  const world = worldRules();
  const ids = longestWaitCases(o.cases);
  const files = ids.map((id) => o.files(id)!);
  const ranking = derivedStatistics(o.base, o.cases, o.topK ?? 5).ranking as { from: string | null; to: string }[];
  const scope = [...new Set(ranking.flatMap((r) => [r.from, r.to]).filter((x): x is string => x !== null))].sort();
  const wards = [...new Set(o.caseFacts.map((f) => String(f["ward_id"])))];
  const scoped = scopedOperations(o.base, new Set(scope), OP_KINDS, wards);
  // The shuffled order permutes the singles by a seeded hash, so the same lazy enumeration visits other combinations first.
  const singles = o.order === "committed" ? scoped : scoped.map((op) => ({ op, k: sha256(`baseline-shuffle|${JSON.stringify(op)}`) })).sort((a, b) => (a.k < b.k ? -1 : 1)).map((x) => x.op);
  const controls = files.map((f, k) => runDefinition(o.base, f.schedule, { world, run_id: `run-${String(k).padStart(4, "0")}ba5e` }) as Ok);
  const ref = evaluateCell(o.base, o.reference, files, controls, { caseFacts: o.caseFacts, world });
  const refSum = ref?.sum_wait_delta ?? 0;
  let sims = files.length;
  let cells = 0;
  const top: SweepCell[] = [];
  let found: SweepCell | null = null;
  let foundAt: number | null = null;
  for (const c of combos(singles.length, o.maxSize ?? 3)) {
    if (sims + files.length > o.budget) break;
    const cell = evaluateCell(o.base, c.map((i) => singles[i]!), files, controls, { caseFacts: o.caseFacts, world });
    if (!cell) continue;
    cells += 1;
    if (!cell.static_noop) sims += files.length;
    if (!cell.static_noop && cell.sum_wait_delta < 0) { top.push(cell); top.sort((a, b) => a.sum_wait_delta - b.sum_wait_delta || a.size - b.size); if (top.length > 20) top.pop(); }
    if (!found && ref && refSum < 0 && cell.per_case.every((d, k) => d === ref.per_case[k])) { found = cell; foundAt = sims; }
  }
  return { order: o.order, budget: o.budget, simulations: sims, cells, singles: singles.length, top, reference_sum: refSum, found_at: foundAt, found, cases: ids, scope };
}
