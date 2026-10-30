import { WorkflowChangeProposal, type Clocks, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { openStream, readStream, type Stream } from "@hey-pisgah/store";
import { Registry, RegistryError, type PersonApprover } from "@hey-pisgah/workflow";

export const VERSIONS_STREAM = "learning/versions";
export const PROPOSALS_STREAM = "learning/proposals";
export const VALIDATIONS_STREAM = "learning/validations";

// Whoever asks for a standing change; only a person in the ward manager role may make one.
export type Requester = { kind: string; staff_id: string; role: string; display_name: string };
export type ProposalRef = { task_id: string; proposal_id: string };

export class VersionError extends Error {
  constructor(readonly code: "requires_person" | "unknown_proposal" | "not_validated" | "hash_mismatch" | "bad_transition" | "unknown_version", message: string) {
    super(message);
  }
}

const person = (r: Requester): PersonApprover | null =>
  r.kind === "person" && r.role === "ward_manager" ? { kind: "person", staff_id: r.staff_id, role: "ward_manager", display_name: r.display_name } : null;

// The append-only version log: every adoption, suspension and revert by a person, replayed into the registry on start.
export class VersionDesk {
  private readonly log: Stream;
  private refused = 0;

  constructor(private readonly storeRoot: string, readonly registry: Registry) {
    this.log = openStream(storeRoot, VERSIONS_STREAM, { writer: true });
    for (const e of this.log.records()) this.replay(e.record_type, e.payload as Record<string, unknown>);
  }

  close(): void { this.log.close(); }
  refusedCount(): number { return this.refused; }
  records(): { record_type: string; seq: number; wall_at: string; payload: unknown }[] {
    return this.log.records().filter((e) => e.record_type.startsWith("version.")).map((e) => ({ record_type: e.record_type, seq: e.seq, wall_at: e.wall_at, payload: e.payload }));
  }

  private replay(type: string, x: Record<string, unknown>): void {
    const at = x["at"] as Clocks;
    if (type === "version.created") {
      const r = this.registry.propose(Number(x["base_version"]), x["ops"] as unknown[], x["meta"] as Parameters<Registry["propose"]>[2], { scope: x["scope"] as WD["scope"], fallback: Number(x["base_version"]) });
      if (!r.version || r.version.definition_hash !== x["definition_hash"]) throw new VersionError("hash_mismatch", "a logged version no longer rebuilds to its hash");
      this.registry.setValidation(r.version.version, "dev_validated");
    } else if (type === "version.adopted") this.registry.adopt(Number(x["version"]), x["approver"] as PersonApprover, at);
    else if (type === "version.suspended") this.registry.suspend(Number(x["version"]), x["by"] as PersonApprover, String(x["reason"]), at);
    else if (type === "version.reverted") this.registry.revert(Number(x["version"]), x["by"] as PersonApprover, String(x["reason"]), at);
    else if (type === "version.change_refused") this.refused += 1;
  }

  private gate(action: string, by: Requester, target: Record<string, unknown>): PersonApprover {
    const p = person(by);
    if (p) return p;
    this.refused += 1;
    this.log.append("version.change_refused", { action, reason: "requires_person", by: { kind: by.kind, staff_id: by.staff_id, role: by.role }, ...target }, { recorded_at: 0, occurred_at: 0 });
    throw new VersionError("requires_person", `${action} is a person's decision; ${by.kind} ${by.role} may not ${action}`);
  }

  // A person adopts a proposal the evaluator validated on dev; the version is rebuilt here and must match the validated hash.
  adopt(proposalId: string, by: Requester, atMinute = 0, wallAt = new Date().toISOString()): WD {
    const approver = this.gate("adopt", by, { proposal_id: proposalId });
    const sub = readStream(this.storeRoot, PROPOSALS_STREAM).filter((e) => e.record_type === "proposal.submitted" && (e.payload as { proposal_id?: string }).proposal_id === proposalId).at(-1);
    if (!sub) throw new VersionError("unknown_proposal", `no submitted proposal ${proposalId}`);
    const p = WorkflowChangeProposal.parse(sub.payload);
    const prior = this.records().find((r) => r.record_type === "version.created" && (r.payload as { meta: { proposal_id: string } }).meta.proposal_id === proposalId);
    if (prior) throw new VersionError("bad_transition", `proposal ${proposalId} is already version ${(prior.payload as { version: number }).version}; adopted versions are never rebuilt`);
    const val = readStream(this.storeRoot, VALIDATIONS_STREAM)
      .filter((e) => e.record_type === "validation.completed" && (e.payload as { proposal_ref?: { seq?: number } }).proposal_ref?.seq === sub.seq).at(-1);
    const report = val?.payload as { report?: { status?: string; hashes?: { proposal?: string | null }; gate?: { rework_budget_min_per_case?: number; rework_max_added_min?: number; rework_within_budget?: boolean } | null } } | undefined;
    if (report?.report?.status !== "dev_validated") throw new VersionError("not_validated", `proposal ${proposalId} has no dev_validated validation`);
    // The approver adopts the rework budget the gate assessed, so a validation from before the budget rule must be run again.
    const g = report.report.gate;
    if (typeof g?.rework_budget_min_per_case !== "number" || typeof g.rework_max_added_min !== "number") throw new VersionError("not_validated", `proposal ${proposalId} was validated before the rework budget; validate it again so the gate assesses its rework`);
    if (g.rework_within_budget !== true) throw new VersionError("not_validated", `proposal ${proposalId} adds ${g.rework_max_added_min} minutes of rework on one case, over the ${g.rework_budget_min_per_case}-minute budget`);
    const reworkBudget = { min_per_case: g.rework_budget_min_per_case, max_added_min: g.rework_max_added_min, approved_by: approver.staff_id };
    const meta = {
      author: { kind: "model_session" as const, id: proposalId }, proposal_id: proposalId,
      source_evidence: { event_ids: p.evidence.event_ids, hypothesis_ids: p.evidence.hypothesis_ids, experiment_ids: p.evidence.experiment_ids, validation_report_id: `${val!.stream_id}#${val!.seq}` },
      model_provenance: null
    };
    const at: Clocks = { occurred_at: atMinute, recorded_at: atMinute, wall_at: wallAt };
    const built = this.registry.propose(p.base_version, p.ops, meta, { scope: p.scope, fallback: p.base_version });
    if (!built.version) throw new VersionError("bad_transition", "the proposal changes nothing or no longer applies");
    if (built.version.definition_hash !== report.report.hashes?.proposal) throw new VersionError("hash_mismatch", "the rebuilt version differs from the one the evaluator validated");
    const v = built.version.version;
    this.registry.setValidation(v, "dev_validated");
    this.log.append("version.created", { version: v, base_version: p.base_version, ops: p.ops, scope: p.scope, meta, definition_hash: built.version.definition_hash, validation_ref: { stream_id: val!.stream_id, seq: val!.seq }, proposal_ref: { stream_id: sub.stream_id, seq: sub.seq } }, { recorded_at: atMinute, occurred_at: atMinute });
    const adopted = this.registry.adopt(v, approver, at);
    this.log.append("version.adopted", { version: v, approver, at, scope: p.scope, definition_hash: adopted.definition_hash, supersedes: adopted.metadata.supersedes, rework_budget: reworkBudget }, { recorded_at: atMinute, occurred_at: atMinute });
    return adopted;
  }

  suspend(version: number, by: Requester, reason: string, atMinute = 0, proposal: ProposalRef | null = null, wallAt = new Date().toISOString()): WD {
    const p = this.gate("suspend", by, { version });
    const at: Clocks = { occurred_at: atMinute, recorded_at: atMinute, wall_at: wallAt };
    const d = this.standing(() => this.registry.suspend(version, p, reason, at));
    this.log.append("version.suspended", { version, by: p, reason, at, proposal }, { recorded_at: atMinute, occurred_at: atMinute });
    return d;
  }

  revert(version: number, by: Requester, reason: string, atMinute = 0, wallAt = new Date().toISOString()): WD {
    const p = this.gate("revert", by, { version });
    const at: Clocks = { occurred_at: atMinute, recorded_at: atMinute, wall_at: wallAt };
    const d = this.standing(() => this.registry.revert(version, p, reason, at));
    this.log.append("version.reverted", { version, by: p, reason, at }, { recorded_at: atMinute, occurred_at: atMinute });
    return d;
  }

  private standing(f: () => WD): WD {
    try { return f(); } catch (e) {
      if (e instanceof RegistryError) throw new VersionError(e.code === "unknown_version" ? "unknown_version" : "bad_transition", e.message);
      throw e;
    }
  }
}
