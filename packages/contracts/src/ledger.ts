import { z } from "zod";
import { RunId, TaskId } from "./ids.js";
import { TaskState } from "./runtime.js";

// Draft (v0): one row per model call; the only source for cost, latency and attribution figures.
export const Provider = z.enum(["modal", "baseten", "fireworks", "meta"]);
export const Effort = z.enum(["low", "medium", "high", "xhigh"]);

export const LedgerRow = z.object({
  at_wall: z.string().datetime(),
  provider: Provider,
  model: z.string(),
  mode: z.enum(["live", "replay", "mock"]),
  hosted_mode: z.enum(["standard", "contributor"]).nullable(),
  effort: Effort,
  effective_strength: z.number().int().nullable(),
  response_id: z.string().nullable(),
  prompt_tokens: z.number().int().min(0),
  completion_tokens: z.number().int().min(0),
  reasoning_tokens: z.number().int().min(0).nullable(),
  cached_tokens: z.number().int().min(0).nullable(),
  latency_ms: z.number().int().min(0),
  repairs: z.number().int().min(0),
  cost_usd: z.number().min(0),
  purpose: z.string(),
  run_id: RunId.nullable(),
  task_id: TaskId.nullable(),
  task_state: TaskState.nullable(),
  thread: z.enum(["main", "side"]),
  affinity_key: z.string().nullable()
});
export type LedgerRow = z.infer<typeof LedgerRow>;

// List prices per million tokens on every Spark Open route and hosted Standard, checked 27 Oct 2026.
export const PRICE_PER_MTOK = { input: 1.25, cached_input: 0.15, output: 4.25 } as const;

export function estimateCostUsd(r: Pick<LedgerRow, "prompt_tokens" | "completion_tokens" | "cached_tokens">): number {
  const cached = r.cached_tokens ?? 0;
  const uncached = Math.max(0, r.prompt_tokens - cached);
  return (uncached * PRICE_PER_MTOK.input + cached * PRICE_PER_MTOK.cached_input + r.completion_tokens * PRICE_PER_MTOK.output) / 1_000_000;
}
