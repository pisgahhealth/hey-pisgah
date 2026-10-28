import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";
import { LedgerRow, estimateCostUsd, type Effort as EffortSchema } from "@hey-pisgah/contracts";

export type Effort = z.infer<typeof EffortSchema>;

// Strengths per effort from Meta's Spark Open prompting guide.
export const STRENGTH: Record<Effort, number> = { low: 8, medium: 32, high: 256, xhigh: 512 };

export type Usage = { prompt_tokens: number; completion_tokens: number; reasoning_tokens: number | null; cached_tokens: number | null };

const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);

// Reads both usage shapes: Modal puts reasoning_tokens at the top, Meta nests it under completion_tokens_details.
export function readUsage(u: unknown): Usage {
  const o = (u ?? {}) as Record<string, any>;
  return {
    prompt_tokens: int(o.prompt_tokens) ?? 0,
    completion_tokens: int(o.completion_tokens) ?? 0,
    reasoning_tokens: int(o.reasoning_tokens) ?? int(o.completion_tokens_details?.reasoning_tokens),
    cached_tokens: int(o.prompt_tokens_details?.cached_tokens) ?? int(o.cached_tokens)
  };
}

// Describes a JSON value as its key tree with leaf types, so docs show shape without content.
export function shapeOf(v: unknown, depth = 0): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (typeof v === "object" && depth < 5) return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
  return typeof v;
}

export type RowInput = {
  provider: LedgerRow["provider"]; model: string; hosted_mode: LedgerRow["hosted_mode"]; effort: Effort;
  effective_strength: number | null; response_id: string | null; usage: Usage; latency_ms: number;
  purpose: string; run_id: string; affinity_key: string | null; extra_cost_usd?: number;
};

export function buildRow(r: RowInput, at = new Date()): LedgerRow {
  return LedgerRow.parse({
    at_wall: at.toISOString(), provider: r.provider, model: r.model, mode: "live", hosted_mode: r.hosted_mode,
    effort: r.effort, effective_strength: r.effective_strength, response_id: r.response_id,
    ...r.usage, latency_ms: Math.max(0, Math.round(r.latency_ms)), repairs: 0,
    cost_usd: estimateCostUsd(r.usage) + (r.extra_cost_usd ?? 0), purpose: r.purpose, run_id: r.run_id,
    task_id: null, task_state: null, thread: "main", affinity_key: r.affinity_key
  });
}

export class BudgetHit extends Error {}

// Append-only probe ledger whose call and dollar caps count every row ever written to the file.
export class ProbeLedger {
  rows: LedgerRow[] = [];
  private reserved = 0;
  constructor(readonly path: string, readonly maxCalls: number, readonly maxUsd: number) {
    if (existsSync(path)) this.rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => LedgerRow.parse(JSON.parse(l)));
  }
  get spent(): number { return this.rows.reduce((s, r) => s + r.cost_usd, 0); }
  reserve(): void {
    if (this.rows.length + this.reserved >= this.maxCalls) throw new BudgetHit(`call cap ${this.maxCalls} reached`);
    if (this.spent >= this.maxUsd) throw new BudgetHit(`budget $${this.maxUsd} reached`);
    this.reserved += 1;
  }
  append(row: LedgerRow): void {
    this.reserved = Math.max(0, this.reserved - 1);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(row) + "\n");
    this.rows.push(row);
  }
}

export function p50(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] ?? null;
}
