import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adoptionLive, logHashes } from "./adoption-live.js";

const lane = { kind: "person", staff_id: "wm_x", role: "ward_manager", display_name: "Synthetic Ward A manager (disclosed; a person's role played by a build lane)" };
const at = (w: string) => ({ occurred_at: 0, recorded_at: 0, wall_at: w });
const LOG = [
  { seq: 1, record_type: "version.created", wall_at: "2026-10-31T07:08:35Z", payload: { version: 2 } },
  { seq: 2, record_type: "version.adopted", wall_at: "2026-10-31T07:08:35Z", payload: { version: 2, approver: lane, at: at("2026-10-31T07:08:35Z") } },
  { seq: 3, record_type: "version.suspended", wall_at: "2026-10-31T07:12:19Z", payload: { version: 2, by: lane, reason: "late round entry", at: at("2026-10-31T07:12:19Z") } }
].map((r) => JSON.stringify(r)).join("\n") + "\n";
const WHY = "version 2 was suspended by Synthetic Ward A manager on 31 Oct, 08:12 (late round entry), so version 1 is in force";
const live = () => ({
  finished_at: "2026-10-31T07:13:43Z", version_log: { hash_start: "e3b0" },
  adopted: { definition_hash: "c657", scope: { wards: ["A"] }, approver: lane, log_hash: "aa", at: "2026-10-31T07:08:35Z" },
  suspended: { by: lane, reason: "late round entry", log_hash: "bb", at: "2026-10-31T07:12:19Z" },
  a1: { offer: "The round entry is on the stay.", calls: 2, usd: 0.0096, version: { version: 2, offers: ["v2:st06"] }, saved: { record_id: "n1", note_author_is_nurse_agent: true, provenance: [{ on_behalf_of: true, origin: "voice" }] } },
  a2: { withdrawn_after_ms: 14385, questions: 0, note: `Withdrawn: ${WHY}.`, version: { version: 1, withdrawn: [{ version: 2, reason: WHY }] } },
  a3: { offers: 0, questions: 0, note: `Not offered: ${WHY}.`, version: { version: 1, withheld: [{ version: 2, reason: WHY }] } }
});
const restart = [{ version: 1, questions: 0, withdrawn: 0 }, { version: 1, questions: 0, withdrawn: 1 }, { version: 1, questions: 0, withdrawn: 0 }];
const monitor = { planted_failure_detected: true, only_affected_blocked: true, approval_by_person: true };

describe("the live adopt, use, suspend and stop sequence as a result", () => {
  it("is complete when the fresh stay used version 2, the suspension withdrew the pending offer and stopped the next stay with its reason, and a restart agreed", () => {
    const r = adoptionLive({ live: live(), afterRestart: restart, logText: LOG, monitor });
    expect(r).toMatchObject({ sequence_complete: true, used_on_fresh_stay: true, suspension_took_effect: true, restart_agrees: true, withdrawn_after_s: 14, adopted_by_person_role: true, played_by_lane: true, human_approval: false, human_decision: false, planted_failure_detected: true });
  });

  it("names the log's hash after each record", () => {
    const h = logHashes(LOG);
    expect(h.map((x) => x.record_type)).toEqual(["version.created", "version.adopted", "version.suspended"]);
    expect(h.at(-1)!.hash).toBe(createHash("sha256").update(LOG).digest("hex"));
  });

  it("is not complete when the next stay was still offered version 2, the pending offer stayed open, or a restart offered again", () => {
    const offered = live(); offered.a3 = { ...offered.a3, offers: 1, version: { version: 2, withheld: [] } };
    expect(adoptionLive({ live: offered, afterRestart: restart, logText: LOG, monitor })).toMatchObject({ suspension_took_effect: false, sequence_complete: false });
    const open = live(); open.a2 = { ...open.a2, questions: 1, version: { version: 2, withdrawn: [] } };
    expect(adoptionLive({ live: open, afterRestart: restart, logText: LOG, monitor })).toMatchObject({ suspension_took_effect: false, sequence_complete: false });
    expect(adoptionLive({ live: live(), afterRestart: [{ version: 2, questions: 1, withdrawn: 0 }], logText: LOG, monitor })).toMatchObject({ restart_agrees: false, sequence_complete: false });
  });

  it("reads a person's own approval only from the adoption record, so a lane in the role is never one", () => {
    const person = { kind: "person", staff_id: "samuel", role: "ward_manager", display_name: "Samuel" };
    const own = LOG.replaceAll(JSON.stringify(lane), JSON.stringify(person));
    expect(adoptionLive({ live: live(), afterRestart: restart, logText: own, monitor })).toMatchObject({ human_approval: false, adopted_by_own_person: true, suspended_by_own_person: true, human_decision: true, played_by_lane: false });
    const adoptedOnly = own.split("\n").slice(0, 2).join("\n") + "\n";
    expect(adoptionLive({ live: live(), afterRestart: restart, logText: adoptedOnly, monitor })).toMatchObject({ human_approval: true, human_decision: false });
    expect(adoptionLive({ live: live(), afterRestart: restart, logText: LOG, monitor })).toMatchObject({ human_approval: false, adopted_by_own_person: false, human_decision: false });
  });
});
