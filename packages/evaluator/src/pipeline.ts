import {
  WorkflowChangeProposal, WorkflowDefinition, definitionHash, fencesHash, hashJson, permissionsHash,
  type RunResult, type WorkflowDefinition as WD
} from "@hey-pisgah/contracts";
import { loadPool, type CaseFile, type Manifest } from "@hey-pisgah/cases";
import { loadV1, worldRules } from "@hey-pisgah/hospital";
import { effectiveParams, eventLogHash, externalSubLogHash, rulesHashFor, runDefinition, type ExternalSchedule } from "@hey-pisgah/simulator";
import { openStream, readStream } from "@hey-pisgah/store";
import { applyOperations, evalCondition, inScope, type Facts, type Issue } from "@hey-pisgah/workflow";
import { runAcceptance, type AcId, type AcReport, type VersionContext } from "./acceptance/checks.js";
import { acceptanceHash } from "./acceptance/hash.js";
import { loadManifests } from "./data.js";

export type ValidationCase = { file: CaseFile; manifest: Manifest };

// The 15 dev cases, plus the 2 variation cases once requirement r2 is in force.
export function loadValidationCases(opts: { r2Effective: boolean }): ValidationCase[] {
  const pools: ("dev" | "variation")[] = opts.r2Effective ? ["dev", "variation"] : ["dev"];
  return pools.flatMap((pool) => {
    const manifests = loadManifests(pool);
    return loadPool(pool).map((file) => {
      const manifest = manifests.get(file.case_id);
      if (!manifest) throw new Error(`no manifest for ${file.case_id}`);
      return { file, manifest };
    });
  });
}

const world = worldRules();
// The rules hash every run must carry: the simulator's parameters and the hospital world rules together.
export const expectedRulesHash = (s: ExternalSchedule): string => hashJson({ sim: rulesHashFor(effectiveParams(s.params)), world: world.rules_hash });

// Both arms of one case share a run id, so identical behaviour gives an identical event log hash.
const runIdFor = (caseId: string) => `run-${hashJson({ case_id: caseId, purpose: "validation" }).slice(0, 8)}`;
export const runCase = (def: WD, s: ExternalSchedule): RunResult => runDefinition(def, s, { world, run_id: runIdFor(s.case_id) });

// Builds the definition a proposal describes: its operations on the base, its scope, and the base as fallback.
export function proposalDefinition(base: WD, p: WorkflowChangeProposal, caseFacts: readonly Facts[]): { ok: true; def: WD; warnings: Issue[] } | { ok: false; errors: Issue[] } {
  if (p.base_version !== base.version) return { ok: false, errors: [{ code: "unknown_id", op_index: null, message: `base version ${p.base_version} is not ${base.version}` }] };
  const r = applyOperations(base, p.ops, { caseFacts });
  if (!r.ok) return { ok: false, errors: r.errors };
  const scoped = p.scope.condition;
  if (scoped && caseFacts.length >= 2 && caseFacts.filter((f) => evalCondition(scoped, f)).length === 1) {
    return { ok: false, errors: [{ code: "single_case_condition", op_index: null, message: "the scope condition holds for exactly one case in the pool" }] };
  }
  const def = { ...structuredClone(r.definition), version: base.version + 1, parent_version: base.version, status: "proposed" as const, scope: structuredClone(p.scope), fallback_version: base.version };
  def.definition_hash = definitionHash(def);
  const parsed = WorkflowDefinition.safeParse(def);
  if (!parsed.success) return { ok: false, errors: [{ code: "invalid_definition", op_index: null, message: parsed.error.issues.map((i) => i.message).join("; ") }] };
  return { ok: true, def: parsed.data as WD, warnings: r.warnings };
}

type Arm = { pass: boolean; failing: AcId[]; outcome: RunResult["outcome"] };
export type CaseRow = {
  case_id: string; seen: boolean; in_scope: boolean;
  base: Arm; proposal: Arm;
  delta: { post_signoff_wait_min: number | null; bed_release_delay_min: number | null; rework_min: number | null; unnecessary_docs: number | null };
  identical_log: boolean;
};
export type Gate = { pass: boolean; no_regression: boolean; prohibited_attempts: number; exception_check: boolean; fences_intact: boolean };
export type ValidationReport = {
  proposal_id: string | null; proposal_hash: string; base_version: number;
  status: "dev_validated" | "dev_failed" | "invalid";
  stage_failed: "schema" | "static" | "matched_runs" | null;
  errors: Issue[] | string[]; warnings: Issue[]; repairs: number;
  hashes: { base: string; proposal: string | null; rules: string | null; acceptance: string };
  gate: Gate | null; cases: CaseRow[];
  summary: { cases: number; base_pass: number; proposal_pass: number; out_of_scope: number; median_wait_delta: number | null } | null;
};

export type RepairHook = (raw: unknown, issues: string[], attempt: number) => unknown | Promise<unknown>;
export type PipelineOptions = { base?: WD; cases?: ValidationCase[]; caseFacts?: readonly Facts[]; repair?: RepairHook; r2Effective?: boolean };

// Hashes whatever arrived, after a JSON round trip, so a malformed proposal still gets a stable id.
const rawHash = (raw: unknown): string => hashJson(JSON.parse(JSON.stringify(raw ?? null)) as unknown);
const median = (xs: number[]): number | null => { if (!xs.length) return null; const y = [...xs].sort((a, b) => a - b); return y[Math.floor((y.length - 1) / 2)]!; };
const diff = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || b === null || b === undefined ? null : b - a);
const metrics = (r: RunResult) => (r.outcome === "ok" ? r.metrics : null);
const arm = (r: RunResult, a: AcReport): Arm => ({ pass: a.pass, failing: a.failing, outcome: r.outcome });

// The dev gate: no case passes on base and fails on the proposal, zero prohibited attempts, out-of-scope logs identical, fences intact; improvement is not required.
export function devGate(rows: readonly CaseRow[], x: { def: WD; base: WD; aborted: boolean; prohibited: number }): Gate {
  const g = {
    no_regression: rows.every((r) => !(r.base.pass && !r.proposal.pass)),
    prohibited_attempts: x.prohibited,
    exception_check: rows.filter((r) => !r.in_scope).every((r) => r.identical_log),
    fences_intact: fencesHash(x.def) === fencesHash(x.base) && permissionsHash(x.def) === permissionsHash(x.base) && !x.aborted
  };
  return { ...g, pass: g.no_regression && g.prohibited_attempts === 0 && g.exception_check && g.fences_intact };
}

// Validates one proposal on dev data: schema with repair, static rules, matched runs, acceptance checks and the dev gate.
export async function validateProposal(raw: unknown, opts: PipelineOptions = {}): Promise<ValidationReport> {
  const base = opts.base ?? loadV1();
  const baseHash = definitionHash(base);
  const accHash = acceptanceHash();
  const cases = opts.cases ?? loadValidationCases({ r2Effective: opts.r2Effective ?? false });
  const caseFacts = opts.caseFacts ?? loadPool("discovery").map((c) => c.schedule.facts as Facts);
  const empty = (status: ValidationReport["status"], stage: ValidationReport["stage_failed"], errors: ValidationReport["errors"], repairs: number, id: string | null, warnings: Issue[] = []): ValidationReport => ({
    proposal_id: id, proposal_hash: rawHash(raw), base_version: base.version, status, stage_failed: stage, errors, warnings, repairs,
    hashes: { base: baseHash, proposal: null, rules: null, acceptance: accHash }, gate: null, cases: [], summary: null
  });

  let current = raw;
  let parsed = WorkflowChangeProposal.safeParse(current);
  let repairs = 0;
  while (!parsed.success && opts.repair && repairs < 2) {
    repairs += 1;
    current = await opts.repair(current, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`), repairs);
    parsed = WorkflowChangeProposal.safeParse(current);
  }
  if (!parsed.success) return empty("invalid", "schema", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`), repairs, null);
  const p = parsed.data;
  raw = current;

  const built = proposalDefinition(base, p, caseFacts);
  if (!built.ok) return empty("invalid", "static", built.errors, repairs, p.proposal_id);
  const def = built.def;
  const defHash = definitionHash(def);
  const seen = new Set(p.viewed_case_ids);

  const rows: CaseRow[] = [];
  const problems: string[] = [];
  let prohibited = 0;
  let aborted = false;
  for (const c of cases) {
    const s = c.file.schedule;
    const facts = s.facts as Facts;
    const excepted = p.known_exceptions.some((k) => evalCondition(k.condition, facts));
    const scoped = inScope(def, facts);
    const ran = scoped ? def : base;
    const b = runCase(base, s);
    const q = runCase(ran, s);
    const rules = expectedRulesHash(s);
    for (const r of [b, q]) {
      if (r.rules_hash !== rules) problems.push(`${c.file.case_id}: rules hash differs from the world rules`);
      if (r.schedule_hash !== c.file.schedule_hash) problems.push(`${c.file.case_id}: schedule hash changed`);
    }
    if (b.outcome === "ok" && q.outcome === "ok" && externalSubLogHash(b.events) !== externalSubLogHash(q.events)) problems.push(`${c.file.case_id}: external sub-log differs`);
    const baseCtx: VersionContext = { status: "adopted", version_hash: baseHash, in_scope: true, fallback_hash: null, adopted_at_min: null };
    const propCtx: VersionContext = { status: "under_validation", version_hash: defHash, in_scope: scoped, fallback_hash: baseHash, adopted_at_min: null };
    const common = { manifest: c.manifest, requirement_version: c.manifest.requirement_version, schedule: s };
    const ab = runAcceptance({ ...common, run: b, definition: base, version: baseCtx });
    const aq = runAcceptance({ ...common, run: q, definition: ran, version: propCtx });
    const mb = metrics(b), mq = metrics(q);
    if (q.outcome !== "ok") aborted = true;
    prohibited += mq ? mq.prohibited_attempted : 1;
    rows.push({
      case_id: c.file.case_id, seen: seen.has(c.file.case_id), in_scope: scoped && !excepted,
      base: arm(b, ab), proposal: arm(q, aq),
      delta: {
        post_signoff_wait_min: diff(mb?.post_signoff_wait_min, mq?.post_signoff_wait_min),
        bed_release_delay_min: diff(mb?.bed_release_delay_min, mq?.bed_release_delay_min),
        rework_min: diff(mb?.rework_min, mq?.rework_min),
        unnecessary_docs: diff(mb?.unnecessary_docs, mq?.unnecessary_docs)
      },
      identical_log: b.outcome === "ok" && q.outcome === "ok" && eventLogHash(b.events) === eventLogHash(q.events)
    });
  }
  if (problems.length) return { ...empty("invalid", "matched_runs", problems, repairs, p.proposal_id, built.warnings), hashes: { base: baseHash, proposal: defHash, rules: null, acceptance: accHash } };

  const gate = devGate(rows, { def, base, aborted, prohibited });
  const waits = rows.map((r) => r.delta.post_signoff_wait_min).filter((x): x is number => x !== null);
  return {
    proposal_id: p.proposal_id, proposal_hash: rawHash(raw), base_version: base.version,
    status: gate.pass ? "dev_validated" : "dev_failed", stage_failed: null, errors: [], warnings: built.warnings, repairs,
    hashes: { base: baseHash, proposal: defHash, rules: cases[0] ? expectedRulesHash(cases[0].file.schedule) : null, acceptance: accHash },
    gate, cases: rows,
    summary: { cases: rows.length, base_pass: rows.filter((r) => r.base.pass).length, proposal_pass: rows.filter((r) => r.proposal.pass).length, out_of_scope: rows.filter((r) => !r.in_scope).length, median_wait_delta: median(waits) }
  };
}

export const PROPOSALS_STREAM = "learning/proposals";
export const VALIDATIONS_STREAM = "learning/validations";

// Reads proposal.submitted records, validates each proposal not yet validated and appends validation.completed records.
export async function runValidationStream(storeRoot: string, opts: PipelineOptions & { proposals?: string; validations?: string } = {}): Promise<ValidationReport[]> {
  const proposals = readStream(storeRoot, opts.proposals ?? PROPOSALS_STREAM).filter((e) => e.record_type === "proposal.submitted");
  const out = openStream(storeRoot, opts.validations ?? VALIDATIONS_STREAM, { writer: true });
  try {
    const done = new Set(out.records().filter((e) => e.record_type === "validation.completed").map((e) => (e.payload as { proposal_ref?: { seq?: number } }).proposal_ref?.seq));
    const reports: ValidationReport[] = [];
    for (const e of proposals) {
      if (done.has(e.seq)) continue;
      const report = await validateProposal(e.payload, opts);
      out.append("validation.completed", { proposal_ref: { stream_id: e.stream_id, seq: e.seq }, report }, { recorded_at: 0, occurred_at: 0 });
      reports.push(report);
    }
    return reports;
  } finally {
    out.close();
  }
}

// The fields claims C-06 reads from evaluation/results/validation.json.
export function validationSummary(reports: readonly ValidationReport[]): Record<string, unknown> {
  const best = reports.find((r) => r.status === "dev_validated") ?? reports.at(-1) ?? null;
  return {
    proposals_validated: reports.length,
    dev_gate_pass: best?.gate?.pass ?? false,
    exception_check_pass: best?.gate?.exception_check ?? false,
    fences_unchanged: best?.gate?.fences_intact ?? false,
    proposal_id: best?.proposal_id ?? null,
    cases: best?.summary?.cases ?? 0
  };
}
