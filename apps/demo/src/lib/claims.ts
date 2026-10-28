import { join } from "node:path";
import { readJson } from "./paths.js";

export const CLAIM_STATUSES = ["green", "amber", "red", "not_measured"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type WordingKey = "pass" | "partial" | "fail" | "not_measured";

export type RegistryClaim = {
  claim_id: string; question: string;
  demo_surface: { step: string; component: string };
  evaluation_view: { tab: string; table: string };
  wording: Record<WordingKey, string>;
};
export type StatusEntry = { claim_id: string; status: ClaimStatus; values: Record<string, unknown>; measured_at: string | null };
export type ClaimView = {
  id: string; question: string; status: ClaimStatus; wording: string; missing: string[];
  surfaces: string[]; component: string; tab: string; table: string; measured_at: string | null;
};
export type ClaimsModel = { claims: ClaimView[]; generated_at: string; commit: string };

export const WORDING_FOR: Record<ClaimStatus, WordingKey> = { green: "pass", amber: "partial", red: "fail", not_measured: "not_measured" };

// Fills {name} slots from the measured values and reports any slot that had no value.
export function fillWording(template: string, values: Record<string, unknown>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{([a-z0-9_]+)\}/g, (_, k: string) => {
    const v = values[k];
    if (v === undefined || v === null || (typeof v === "object")) { missing.push(k); return `[${k} missing]`; }
    return String(v);
  });
  return { text, missing };
}

function fail(msg: string): never { throw new Error(`claims: ${msg}`); }

// Joins the registry with the measured status file; the UI shows claim wording from nowhere else.
export function buildClaims(registryRaw: unknown, statusRaw: unknown): ClaimsModel {
  const reg = registryRaw as { claims?: RegistryClaim[] };
  const st = statusRaw as { claims?: StatusEntry[]; generated_at?: string; commit?: string };
  if (!Array.isArray(reg.claims)) fail("registry has no claims list");
  if (!Array.isArray(st.claims)) fail("status file has no claims list");
  const byId = new Map(st.claims.map((s) => [s.claim_id, s]));
  if (byId.size !== reg.claims.length) fail(`status file has ${byId.size} entries, registry has ${reg.claims.length}`);
  const claims = reg.claims.map((c): ClaimView => {
    const s = byId.get(c.claim_id) ?? fail(`no status for ${c.claim_id}`);
    if (!CLAIM_STATUSES.includes(s.status)) fail(`unknown status ${String(s.status)} for ${c.claim_id}`);
    const { text, missing } = fillWording(c.wording[WORDING_FOR[s.status]], s.values ?? {});
    return {
      id: c.claim_id, question: c.question, status: s.status, wording: text, missing,
      surfaces: c.demo_surface.step.split(",").map((x) => x.trim()), component: c.demo_surface.component,
      tab: c.evaluation_view.tab, table: c.evaluation_view.table, measured_at: s.measured_at
    };
  });
  return { claims, generated_at: st.generated_at ?? "", commit: st.commit ?? "" };
}

export function loadClaims(root: string): ClaimsModel {
  return buildClaims(readJson(join(root, "evaluation", "claims.json")), readJson(join(root, "evaluation", "claims.status.json")));
}

// Claims placed on one surface by the registry: a step number, "results" or "footer".
export function claimsOn(model: ClaimsModel, surface: string): ClaimView[] {
  return model.claims.filter((c) => c.surfaces.includes(surface));
}

export const STATUS_LABEL: Record<ClaimStatus, string> = { green: "Pass", amber: "Partial", red: "Fail", not_measured: "Not measured" };
