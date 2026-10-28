export type EvalTab = { slug: string; name: string; holds: string };

// The ten evaluation view tabs, in the order the plan lists them.
export const EVAL_TABS: readonly EvalTab[] = [
  { slug: "baselines", name: "Baselines", holds: "Primary table, paired results against A1, the ladder and the sweep." },
  { slug: "reserved-run", name: "Reserved run", holds: "RUN.json and 25 per-case traces with expected outcomes, prohibited actions and final states." },
  { slug: "decision-points", name: "Decision points", holds: "Acting, waiting, asking and refusing at each decision point (FR-1)." },
  { slug: "truthful-completion", name: "Truthful completion", holds: "The agreement matrix between the agent's done and the independent verifier (FR-5)." },
  { slug: "reliability", name: "Reliability", holds: "Omissions, duplicates, incorrect effects and inconsistent outcomes over reruns (FR-4)." },
  { slug: "prediction-checks", name: "Prediction checks", holds: "Every prediction with its outcome, including inconclusive and contradicted, against the A4 and random baselines." },
  { slug: "costs", name: "Costs and instrumentation", holds: "Every model call: provider, model, effort, tokens, cached tokens, latency, repairs and cost, by phase and arm." },
  { slug: "commitments", name: "Commitments and contamination", holds: "Every commitment revision with its reason, and every reclassified case." },
  { slug: "failures", name: "Failures and limitations", holds: "Every red and amber claim, every failed case and the simulator's published assumptions." },
  { slug: "variation", name: "Variation", holds: "A0, A1, A2 blind, A2a and A1 corrected on Ward B." }
];

// Maps a registry tab name to its tab; "Costs" in the registry is the "Costs and instrumentation" tab.
export function tabFor(name: string): EvalTab | null {
  const n = name.trim().toLowerCase();
  return EVAL_TABS.find((t) => t.name.toLowerCase() === n) ?? EVAL_TABS.find((t) => t.name.toLowerCase().startsWith(n)) ?? null;
}

export function evidenceHref(claimId: string, tabName: string): string {
  const t = tabFor(tabName);
  return `/evaluation?tab=${t ? t.slug : EVAL_TABS[0]!.slug}#claim-${claimId}`;
}
