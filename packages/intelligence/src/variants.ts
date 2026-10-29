import { CaseFile, generateCase, loadPool, type CaseSpec, type Manifest } from "@hey-pisgah/cases";
import { SOFT_EDGE_NOTE, WorkflowDefinition, sha256, type Operation, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { loadV1, stampHashes, worldRules } from "@hey-pisgah/hospital";
import { eventLogHash, runDefinition, scheduleHash } from "@hey-pisgah/simulator";
import { DiscoveryPool } from "./pool.js";

export type VariantId = "single" | "pair" | "triple";
export type ValidationCase = { file: CaseFile; manifest: Manifest };
export type Variant = {
  id: VariantId;
  planted: Operation[];
  planted_steps: string[];
  base: WD;
  pool: DiscoveryPool;
  // Null means the evaluator's committed dev cases.
  validation: ValidationCase[] | null;
  seed_rule: string;
};

// The seed rule for generated variant pools: the committed rule's prefix, the variant, the pool and the index.
export const VARIANT_SEED_RULE = "hey-pisgah|seed-rule-1|variant";
export const variantSeed = (id: VariantId, pool: "discovery" | "validation", i: number): string => sha256(`${VARIANT_SEED_RULE}|${id}|${pool}|${i}`);

const c = (family: CaseSpec["family"], ward: CaseSpec["ward"], payer: CaseSpec["payer"] = "self_pay"): CaseSpec => ({ family, ward, payer });

// Pools for the generated variants: the single variant leans on insured patients, the triple on any payer.
const SPECS: Record<"single" | "triple", { discovery: CaseSpec[]; validation: CaseSpec[] }> = {
  single: {
    discovery: [c("F5", "A", "hmo"), c("F5", "A", "hmo"), c("F5", "B", "hmo"), c("F2", "A", "hmo"), c("F6", "A", "hmo"), c("F9", "A", "hmo"), c("F7", "A", "hmo"), c("F3", "B", "hmo"), c("F2", "B", "hmo"), c("F6", "A"), c("F8", "C", "corporate"), c("F4", "C")],
    validation: [c("F5", "A", "hmo"), c("F2", "A", "hmo"), c("F6", "B", "hmo"), c("F9", "A", "hmo"), c("F7", "B", "hmo"), c("F3", "A", "hmo"), c("F5", "B", "hmo"), c("F2", "A"), c("F4", "A"), c("F8", "A")]
  },
  triple: {
    discovery: [c("F2", "A"), c("F2", "B"), c("F6", "A"), c("F9", "A"), c("F7", "A"), c("F3", "B"), c("F4", "C"), c("F5", "A", "hmo"), c("F8", "C", "corporate"), c("F6", "B"), c("F9", "B"), c("F2", "A")],
    validation: [c("F2", "A"), c("F6", "A"), c("F9", "A"), c("F7", "B"), c("F3", "A"), c("F4", "A"), c("F5", "A", "hmo"), c("F2", "B"), c("F6", "B"), c("F9", "B")]
  }
};

const soft = (edge_id: string, from: string, to: string, gate: "start" | "complete" = "start") => ({ edge_id, from: { step: from }, to: { step: to }, gate, kind: "soft" as const, origin: "ward_procedure" as const, immutable: false, note: SOFT_EDGE_NOTE });

// The single variant: the claim cover is drafted only after the cashier's receipt, by one soft edge and no trigger.
function singleBase(): WD {
  const d = structuredClone(loadV1());
  d.triggers = d.triggers.filter((t) => t.target.step !== "st09a");
  d.edges = d.edges.map((e) => (e.edge_id === "e06" ? { ...e, from: { step: "st12a" } } : e));
  return WorkflowDefinition.parse(stampHashes(d)) as WD;
}

// The triple variant: the patient leaves only once the deposit is refunded, and the clerk prepares the voucher after clearance, held by an edge and a trigger on the draft and an edge on the final.
function tripleBase(): WD {
  const d = structuredClone(loadV1());
  d.edges = d.edges.map((e) => (e.edge_id === "e07" ? { ...e, from: { step: "st13" } } : e));
  d.edges.push(soft("e28", "st13", "st17b"));
  const fence = d.edges.find((e) => e.kind === "fence")!;
  d.edges.push({ ...structuredClone(fence), edge_id: "e29", from: { step: "st17c" }, to: { step: "st16" }, gate: "start" });
  d.triggers = d.triggers.map((t) => (t.target.step === "st17a" ? { ...t, when: { after: { step: "st13" } } } : t));
  d.documents = d.documents.map((x) => (x.document_id === "refund_voucher" ? { ...x, preparable_by: ["accounts_clerk"] } : x));
  return WorkflowDefinition.parse(stampHashes(d)) as WD;
}

// Generates one variant pool from the seed rule; discovery cases carry a history run by staff on the variant's definition.
function generated(id: "single" | "triple", base: WD, pool: "discovery" | "validation"): ValidationCase[] {
  const world = worldRules();
  return SPECS[id][pool].map((spec, i) => {
    const gen = generateCase(spec.family, variantSeed(id, pool, i), spec.ward, spec.payer, { pool: pool === "discovery" ? "discovery" : "dev" });
    const schedule = structuredClone(gen.schedule);
    if (id === "triple") Object.assign(schedule.service_min, { "prepare_document|refund_voucher|draft|1": 10, "prepare_document|refund_voucher|final|1": 30 });
    let history: CaseFile["history"] = null;
    if (pool === "discovery") {
      const r = runDefinition(base, schedule, { executor: "historical", use_agent: false, world });
      if (r.outcome !== "ok") throw new Error(`variant history aborted for ${schedule.case_id}`);
      history = { executor: "historical", version_hash: r.version_hash, rules_hash: r.rules_hash, events_hash: eventLogHash(r.events), events: r.events };
    }
    const hash = scheduleHash(schedule);
    const file = CaseFile.parse({ case_id: gen.manifest.case_id, schedule_hash: hash, schedule, initial_state: gen.initial_state, infra_fault: null, history });
    return { file, manifest: { ...gen.manifest, schedule_hash: hash } };
  });
}

const cache = new Map<VariantId, Variant>();

// One simulator variant: its definition, its discovery pool, its validation cases and its planted answer.
export function loadVariant(id: VariantId): Variant {
  const hit = cache.get(id);
  if (hit) return hit;
  let v: Variant;
  if (id === "pair") {
    v = { id, planted: [{ op: "remove_soft_edge", edge_id: "e04" }, { op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st02" } } }] as Operation[], planted_steps: ["st06"], base: loadV1(), pool: new DiscoveryPool(loadPool("discovery")), validation: null, seed_rule: "committed pools (seed-rule-1)" };
  } else if (id === "single") {
    const base = singleBase();
    v = { id, planted: [{ op: "remove_soft_edge", edge_id: "e06" }] as Operation[], planted_steps: ["st09a"], base, pool: new DiscoveryPool(generated(id, base, "discovery").map((x) => x.file)), validation: generated(id, base, "validation"), seed_rule: `sha256("${VARIANT_SEED_RULE}|single|" + pool + "|" + i)` };
  } else {
    const base = tripleBase();
    v = { id, planted: [{ op: "remove_soft_edge", edge_id: "e07" }, { op: "set_prep_trigger", target: { step: "st17a" }, when: { after: { step: "st02" } } }, { op: "remove_soft_edge", edge_id: "e28" }] as Operation[], planted_steps: ["st17a", "st17b"], base, pool: new DiscoveryPool(generated(id, base, "discovery").map((x) => x.file)), validation: generated(id, base, "validation"), seed_rule: `sha256("${VARIANT_SEED_RULE}|triple|" + pool + "|" + i)` };
  }
  cache.set(id, v);
  return v;
}

export const VARIANTS: readonly VariantId[] = ["single", "pair", "triple"];
