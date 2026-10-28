import type { z } from "zod";
import type { Effort, LedgerRow } from "@hey-pisgah/contracts";
import { ModelError } from "./errors.js";

export type ProviderId = LedgerRow["provider"];
export type EffortLevel = z.infer<typeof Effort>;

export type Route = {
  provider: ProviderId;
  models: readonly string[];
  baseURL: (keys: Record<string, string>) => string | null;
  apiKey: (keys: Record<string, string>) => string | null;
  // Which route enforces a json_schema on the server; none is verified as enforcing today.
  schemaEnforcement: "none";
  hostedMode: (model: string) => LedgerRow["hosted_mode"];
  // Spark Open strengths per effort from Meta's prompting guide; null where the route serves another model.
  strength: (model: string, effort: EffortLevel) => number | null;
  affinityHeader: string | null;
  toolChoiceAutoOnly: boolean;
};

export const SPARK_OPEN_STRENGTH: Record<EffortLevel, number> = { low: 8, medium: 32, high: 256, xhigh: 512 };
const sparkStrength = (_m: string, e: EffortLevel) => SPARK_OPEN_STRENGTH[e];
const need = (v: string | undefined) => (v && v.length > 0 ? v : null);

export const ROUTES: Record<ProviderId, Route> = {
  modal: {
    provider: "modal",
    models: ["meta-models/Muse-Spark-Open-816B-A42B"],
    baseURL: (k) => need(k.MODAL_ENDPOINT_URL),
    apiKey: (k) => (need(k.MODAL_PROXY_TOKEN_ID) && need(k.MODAL_PROXY_TOKEN_SECRET) ? `${k.MODAL_PROXY_TOKEN_ID}.${k.MODAL_PROXY_TOKEN_SECRET}` : null),
    schemaEnforcement: "none",
    hostedMode: () => null,
    strength: sparkStrength,
    affinityHeader: "Modal-Routing-Affinity-Key",
    toolChoiceAutoOnly: false
  },
  baseten: {
    provider: "baseten",
    models: ["meta-models/muse-spark-open"],
    baseURL: () => "https://inference.baseten.co/v1",
    apiKey: (k) => need(k.BASETEN_API_KEY),
    schemaEnforcement: "none",
    hostedMode: () => null,
    strength: sparkStrength,
    affinityHeader: null,
    toolChoiceAutoOnly: false
  },
  fireworks: {
    provider: "fireworks",
    models: ["accounts/fireworks/models/muse-spark-open"],
    baseURL: () => "https://api.fireworks.ai/inference/v1",
    apiKey: (k) => need(k.FIREWORKS_API_KEY),
    schemaEnforcement: "none",
    hostedMode: () => null,
    strength: sparkStrength,
    affinityHeader: null,
    toolChoiceAutoOnly: false
  },
  meta: {
    provider: "meta",
    models: ["muse-spark-1.3", "muse-spark-1.3-contributor"],
    baseURL: () => "https://api.meta.ai/v1",
    apiKey: (k) => need(k.MODEL_API_KEY),
    schemaEnforcement: "none",
    hostedMode: (m) => (m.endsWith("-contributor") ? "contributor" : "standard"),
    strength: () => null,
    affinityHeader: null,
    toolChoiceAutoOnly: true
  }
};

export function routeFor(provider: string, model: string): Route {
  const r = (ROUTES as Record<string, Route | undefined>)[provider];
  if (!r) throw new ModelError("unknown_provider", "no such route", { provider });
  if (!r.models.includes(model)) throw new ModelError("unknown_model", "model is not served on this route", { provider, model });
  return r;
}

export type Usage = { prompt_tokens: number; completion_tokens: number; reasoning_tokens: number | null; cached_tokens: number | null };

const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);

// Modal reports reasoning at the top level and no cache on chat; Meta nests both; other routes try both shapes.
export function parseUsage(provider: ProviderId, u: unknown): Usage {
  const o = (u ?? {}) as Record<string, any>;
  const base = { prompt_tokens: int(o.prompt_tokens) ?? 0, completion_tokens: int(o.completion_tokens) ?? 0 };
  if (provider === "modal") return { ...base, reasoning_tokens: int(o.reasoning_tokens), cached_tokens: null };
  if (provider === "meta") return { ...base, reasoning_tokens: int(o.completion_tokens_details?.reasoning_tokens), cached_tokens: int(o.prompt_tokens_details?.cached_tokens) };
  return {
    ...base,
    reasoning_tokens: int(o.completion_tokens_details?.reasoning_tokens) ?? int(o.reasoning_tokens),
    cached_tokens: int(o.prompt_tokens_details?.cached_tokens) ?? int(o.cached_tokens)
  };
}
