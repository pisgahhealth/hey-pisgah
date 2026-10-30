import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DELEGATE_KIND, type DelegationTeam } from "../src/emr/delegate.js";
import { EMERGENCY_KIND } from "../src/emr/entry.js";
import type { EmrCommit, EmrContext, EmrPort, EmrProof, EmrTarget, Provenance, WorkArgs } from "../src/emr/port.js";

export const ARRIVAL = "aaaaaaaa-1111-4222-8333-444444444444";
export const VISIT = "bbbbbbbb-1111-4222-8333-444444444444";
export const DELEGATION = "dddddddd-1111-4222-8333-444444444444";
const TEAMS: Record<string, DelegationTeam> = { front_desk: { words: ["front desk"], task_kind: "registration", title: "Register the emergency arrival", label: "Front desk" } };

type Saved = { kind: string; key: string | null; record_id: string; at: string };
// A hospital whose writes live in a file, so a restarted process sees what the killed one saved; an arrival is handed on to the front desk once verified.
export class FileEmr implements EmrPort {
  readonly writeKinds = [EMERGENCY_KIND, DELEGATE_KIND] as const;
  proveMisses = 0;
  proveThrows = 0;
  proveOther = false;
  refuse = false;
  // Saves the write and loses its answer this many times, as a dropped connection does.
  loseAnswers = 0;
  // Saves the write, answers 500 and frees the key this many times, as a door that fails after its commit does.
  failAfterSave = 0;
  // Finds a saved arrival by the record itself; off models a hospital with no such read.
  canFind = true;
  finds = 0;
  handOff = true;
  onProve: (() => void) | null = null;
  constructor(private readonly file: string) {}
  static in(root: string): FileEmr { return new FileEmr(join(root, "hospital.json")); }
  saved(): Saved[] { return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Saved[]) : []; }
  kindsFor(): readonly string[] { return [EMERGENCY_KIND, DELEGATE_KIND]; }
  refusedCount() { return 0; }
  delegationTeams(): Record<string, DelegationTeam> { return TEAMS; }
  delegationHandoffs(): Record<string, { team: string; subject_table: string }> { return this.handOff ? { [EMERGENCY_KIND]: { team: "front_desk", subject_table: "patients" } } : {}; }
  async resolve(target: EmrTarget): Promise<EmrContext> {
    return { admission_id: "", patient_id: target.patient_id ?? ARRIVAL, visit_id: VISIT, label: "Unknown arrival 10:00", facts: {}, keywords: [] };
  }
  async commit(kind: string, _a: WorkArgs, key: string, _p: Provenance): Promise<EmrCommit> {
    if (this.refuse) return { ok: false, reason: "door_409_conflict", status: 409, retryable: false, counted: false };
    const all = this.saved();
    let hit = all.find((w) => w.key === key);
    const replayed = !!hit;
    if (!hit) { hit = { kind, key, record_id: kind === EMERGENCY_KIND ? ARRIVAL : DELEGATION, at: new Date().toISOString() }; all.push(hit); writeFileSync(this.file, JSON.stringify(all)); }
    if (kind === EMERGENCY_KIND && this.failAfterSave > 0) {
      this.failAfterSave -= 1;
      hit.key = null;
      writeFileSync(this.file, JSON.stringify(all));
      return { ok: false, reason: "door_500", status: 500, retryable: true, counted: false };
    }
    if (kind === EMERGENCY_KIND && this.loseAnswers > 0) { this.loseAnswers -= 1; return { ok: false, reason: "timeout", status: null, retryable: true, counted: false }; }
    return { ok: true, record_id: hit.record_id, record_version: 1, event_ids: kind === EMERGENCY_KIND ? [`patient:${ARRIVAL}`, `visit:${VISIT}`] : [`delegation:${DELEGATION}`], replayed };
  }
  async findWrite(kind: string, _a: WorkArgs, sought: { since: string }): Promise<{ found: { record_id: string; record_version: number; event_ids: string[] } | null; why?: string }> {
    this.finds += 1;
    if (!this.canFind || kind !== EMERGENCY_KIND) return { found: null, why: "no_lookup" };
    const rows = this.saved().filter((w) => w.kind === kind && w.at >= sought.since);
    if (rows.length !== 1) return { found: null, why: rows.length ? "ambiguous" : "absent" };
    return { found: { record_id: rows[0]!.record_id, record_version: 1, event_ids: [`patient:${ARRIVAL}`, `visit:${VISIT}`] } };
  }
  async prove(kind: string, _a: WorkArgs, w: { record_id: string; record_version: number; event_ids: string[] }): Promise<EmrProof | null> {
    if (kind === EMERGENCY_KIND) {
      this.onProve?.();
      if (this.proveThrows > 0) { this.proveThrows -= 1; throw new Error("read timed out"); }
      if (this.proveMisses > 0) { this.proveMisses -= 1; return null; }
      if (this.proveOther) return { ...w, record_id: VISIT, record_hash: "0".repeat(64), verified_at: new Date().toISOString(), read: "board row" };
    }
    return { ...w, record_hash: "0".repeat(64), verified_at: new Date().toISOString(), read: "board row" };
  }
}
