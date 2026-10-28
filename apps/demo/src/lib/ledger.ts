export type LedgerRow = {
  response_id: string | null; provider: string; model: string; mode: "live" | "replay" | "mock"; effort: string | null;
  cost_usd: number; latency_ms: number; task_state: string | null; prompt_tokens: number; completion_tokens: number; run_id: string;
};
export type RunMode = "live" | "replay" | "mock";
export type FooterModel = {
  mode: RunMode | null; provider: string | null; model: string | null; effort: string | null; calls: number; usd: number;
  p50_ms: number | null; run_id: string | null; request_ids: string[]; calls_while_waiting: number;
};

export function p50(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// Sums the ledger rows of one run into the footer's figures; every number comes from a row, none is typed by hand.
export function summarizeLedger(rows: readonly LedgerRow[], fallbackMode: RunMode | null): FooterModel {
  const modes = new Set(rows.map((r) => r.mode));
  const mode: RunMode | null = modes.size === 1 ? [...modes][0]! : modes.has("live") ? "live" : rows.length ? rows[0]!.mode : fallbackMode;
  const one = <K extends keyof LedgerRow>(k: K): string | null => {
    const vals = [...new Set(rows.map((r) => String(r[k] ?? "")))].filter(Boolean);
    return vals.length ? vals.join(", ") : null;
  };
  return {
    mode, provider: one("provider"), model: one("model"), effort: one("effort"), calls: rows.length,
    usd: rows.reduce((a, r) => a + (Number(r.cost_usd) || 0), 0), p50_ms: p50(rows.map((r) => Number(r.latency_ms) || 0)),
    run_id: rows[0]?.run_id ?? null, request_ids: rows.map((r) => r.response_id).filter((x): x is string => !!x),
    calls_while_waiting: rows.filter((r) => r.task_state === "waiting").length
  };
}

export function modelShort(model: string | null): string {
  if (!model) return "no model";
  return model.split("/").pop() ?? model;
}
