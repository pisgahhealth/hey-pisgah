import { createHash } from "node:crypto";
import { adoptionApproval, type VersionRecord } from "./approval.js";

type Row = Record<string, unknown>;
const arr = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);
const obj = (x: unknown): Row => (x && typeof x === "object" ? (x as Row) : {});

// The log's hash after each record, so each step of the sequence names the history it stood on.
export function logHashes(text: string): { seq: number; record_type: string; hash: string }[] {
  const lines = text.split("\n").filter(Boolean);
  return lines.map((l, i) => ({ seq: Number(obj(JSON.parse(l))["seq"] ?? i + 1), record_type: String(obj(JSON.parse(l))["record_type"]), hash: createHash("sha256").update(`${lines.slice(0, i + 1).join("\n")}\n`).digest("hex") }));
}

// The adopt, use, suspend and stop sequence as a result: what the running EMR did at each step, read from the run and the version log, with human_approval from the adoption record only.
export function adoptionLive(o: { live: Row; afterRestart: Row[]; logText: string; monitor: Row; version?: number }): Row {
  const v = o.version ?? 2;
  const log: VersionRecord[] = o.logText.split("\n").filter(Boolean).map((l) => { const e = JSON.parse(l) as Row; return { record_type: String(e["record_type"]), wall_at: String(e["wall_at"] ?? ""), payload: e["payload"] }; });
  const approval = adoptionApproval(log, v);
  const adopted = obj(o.live["adopted"]), suspended = obj(o.live["suspended"]);
  const a1 = obj(o.live["a1"]), a2 = obj(o.live["a2"]), a3 = obj(o.live["a3"]);
  const a1v = obj(a1["version"]), a2v = obj(a2["version"]), a3v = obj(a3["version"]);
  const saved = obj(a1["saved"]);
  const prov = arr(saved["provenance"]);
  const withdrawn = arr(a2v["withdrawn"]).filter((w) => Number(w["version"]) === v);
  const withheld = arr(a3v["withheld"]).filter((w) => Number(w["version"]) === v);
  const suspensionReason = withdrawn[0]?.["reason"] ?? withheld[0]?.["reason"] ?? null;
  const applicable = {
    ward_id: "A", version_in_force: Number(a1v["version"] ?? 0), offers_made: arr(a1v["offers"]).length, offer: a1["offer"] ?? null,
    saved_verified: !!saved["record_id"], note_by_nurse_agent: saved["note_author_is_nurse_agent"] === true, provenance_rows: prov.length, provenance_on_behalf_of_nurse: prov.some((r) => r["on_behalf_of"] === true),
    lines: "the nurse's two lines typed to her serve (draft, then save once reviewed), read by the live gate", calls: Number(a1["calls"] ?? 0), cost_usd: Number(a1["usd"] ?? 0)
  };
  const pending = { version_in_force: Number(a2v["version"] ?? 0), withdrawn: withdrawn.length === 1, withdrawn_after_s: a2["withdrawn_after_ms"] !== undefined ? Math.round(Number(a2["withdrawn_after_ms"]) / 1000) : null, questions_left: Number(a2["questions"] ?? -1), note: a2["note"] ?? null };
  const next = { version_in_force: Number(a3v["version"] ?? 0), offers_made: Number(a3["offers"] ?? -1), questions: Number(a3["questions"] ?? -1), reason_is_suspension: withheld.length >= 1 && /was suspended by/.test(String(withheld[0]?.["reason"] ?? "")), note: a3["note"] ?? null };
  const restart = { tasks: o.afterRestart.length, all_version_1: o.afterRestart.length > 0 && o.afterRestart.every((t) => t["version"] === 1), questions: o.afterRestart.reduce((n, t) => n + Number(t["questions"] ?? 0), 0), withdrawn_once: o.afterRestart.reduce((n, t) => n + Number(t["withdrawn"] ?? 0), 0) === 1 };
  const used = applicable.version_in_force === v && applicable.offers_made >= 1 && applicable.saved_verified && applicable.note_by_nurse_agent;
  const tookEffect = pending.version_in_force !== v && pending.withdrawn && pending.questions_left === 0 && next.version_in_force !== v && next.offers_made === 0 && next.questions === 0 && next.reason_is_suspension;
  const hashes = logHashes(o.logText);
  const playedBy = obj(approval["approval"])["played_by_lane"] === true;
  // A decision is a person's own only when its record names a person by id and time and no lane playing the role; the same rule as adoptionApproval.
  const own = (type: string, key: "approver" | "by") => {
    const rec = log.filter((r) => r.record_type === type && Number(obj(r.payload)["version"]) === v).at(-1);
    const who = obj(obj(rec?.payload)[key]);
    const when = obj(obj(rec?.payload)["at"])["wall_at"];
    return !!rec && who["kind"] === "person" && typeof who["staff_id"] === "string" && !!who["staff_id"] && typeof when === "string" && !/synthetic|build lane/i.test(`${String(who["display_name"] ?? "")} ${String(who["staff_id"] ?? "")}`);
  };
  const adoptedOwn = own("version.adopted", "approver"), suspendedOwn = own("version.suspended", "by");
  return {
    measured_at: String(o.live["finished_at"] ?? new Date().toISOString()), measured: true, source: "sandbox_live_sequence",
    mode: "sandbox door through the VER serve: the doctor's admission and round entries written by his agent (scripted); the nurse's two lines typed to her serve and read by the live gate; adoption and suspension posted to the version desk in the ward manager's role by the VER build lane, disclosed; the EMR serve was not restarted between them",
    version: v, definition_hash: adopted["definition_hash"] ?? null, scope: adopted["scope"] ?? null,
    version_log: { hash_before_adoption: obj(o.live["version_log"])["hash_start"] ?? null, hash_after_adoption: adopted["log_hash"] ?? null, hash_after_suspension: suspended["log_hash"] ?? null, records: hashes },
    adopted_at: adopted["at"] ?? null, suspended_at: suspended["at"] ?? null, suspension_reason: suspended["reason"] ?? null,
    adopted_by_person_role: obj(adopted["approver"])["kind"] === "person" && obj(adopted["approver"])["role"] === "ward_manager",
    suspended_by_person_role: obj(suspended["by"])["kind"] === "person" && obj(suspended["by"])["role"] === "ward_manager",
    played_by_lane: playedBy, ...approval,
    // human_approval stays false once the version is suspended; the two decisions of this sequence are read on their own records, and a lane in the role is never a person's own decision.
    adopted_by_own_person: adoptedOwn, suspended_by_own_person: suspendedOwn, human_decision: adoptedOwn && suspendedOwn,
    applicable, pending_offer: pending, next_fresh: next, restart,
    used_on_fresh_stay: used, suspension_took_effect: tookEffect, restart_agrees: restart.all_version_1 && restart.questions === 0 && restart.withdrawn_once,
    sequence_complete: used && tookEffect && restart.all_version_1 && restart.questions === 0 && restart.withdrawn_once,
    withdrawn_after_s: pending.withdrawn_after_s, suspension_shown: suspensionReason,
    strip: { offer_shown: true, saved_shown: true, withdrawal_shown: false, why: "the strip follows the task with the newest line, action or waiting question, and a withdrawal or a not-offered note is neither, so after the suspension it shows the first stay's task; the reason is in the page task's notes and the serve's view" },
    approver: obj(adopted["approver"])["display_name"] ?? null,
    planted_failure_detected: o.monitor["planted_failure_detected"] ?? null, only_affected_blocked: o.monitor["only_affected_blocked"] ?? null, approval_by_person: o.monitor["approval_by_person"] ?? null,
    monitor_source: "evaluation/results/monitor.json (the planted ward B r2 check), copied so C-09 reads the monitor and the live suspension together",
    cost_usd: applicable.cost_usd, calls: applicable.calls
  };
}
