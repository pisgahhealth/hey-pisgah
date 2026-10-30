import { canonical, sha256 } from "@hey-pisgah/contracts";

// One verified event of the day, in the evidence export's shape; only kinds, roles, ids and numbers, never words.
export type DayEvent = { event_id: string; case_id: string; kind: string; actor_id: string | null; actor_role: string | null; occurred_at: number; recorded_at: number; subject: string | null; payload: Record<string, unknown> };
export type DayCase = { case_id: string; ward_id: string; events: readonly DayEvent[] };
// Work still open at the end of the day, read from the agents' task records; the encounter id is the record's own, never a name.
export type OpenItem = {
  item_id: string; encounter: string; owner: string; department: string; kind: string; title: string;
  state: "open" | "held" | "overdue" | "failed" | "done"; due_at: string | null; refs: string[];
};
// Who a memo goes to, and the encounters the record already authorises them for; being on the same shift is not authorisation.
export type Recipient = { id: string; role: string; department: string; incoming: boolean; authorised: string[] };
// labels are the patients' names as the record holds them, kept in memory only so the checks can refuse any name in a memo.
export type NightSources = { day: string; cases: readonly DayCase[]; open: readonly OpenItem[]; recipients: readonly Recipient[]; labels: readonly string[] };

// The version of the sources a verdict is bound to; names are left out, so the hash can be published.
export function sourcesHash(s: NightSources): string {
  return sha256(canonical({ day: s.day, cases: s.cases.map((c) => ({ case_id: c.case_id, events: c.events.map((e) => e.event_id) })), open: s.open, recipients: s.recipients }));
}

// The department an event belongs to: the person's role, or for an agent the role of the clinician it serves.
export function departmentOf(e: Pick<DayEvent, "actor_id" | "actor_role">): string | null {
  if (e.actor_role && e.actor_role !== "agent") return e.actor_role;
  const m = /^([a-z_]+?)_\d+_agent$/.exec(e.actor_id ?? "");
  return m ? m[1]! : null;
}
