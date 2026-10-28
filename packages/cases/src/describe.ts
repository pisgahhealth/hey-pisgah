import type { SimEvent } from "@hey-pisgah/contracts";
import { loadV1, worldRules } from "@hey-pisgah/hospital";
import { runDefinition } from "@hey-pisgah/simulator";
import { findCase } from "./load.js";

const clock = (m: number): string => `D${Math.floor(m / 1440)} ${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const SHOWN = new Set(["step.completed", "world.record_updated", "world.busy_started", "world.busy_ended", "document.revised", "check.verified", "check.repeated"]);

// A case's journey ordered by the occurred clock, from its history or from v1 on the definition executor; it prints no evaluator field.
export function describeCase(caseId: string): string[] {
  const found = findCase(caseId);
  if (!found) throw new Error("unknown_id");
  const { file } = found;
  let events: readonly SimEvent[];
  let source: string;
  if (file.history) { events = file.history.events; source = "history"; }
  else {
    const r = runDefinition(loadV1(), file.schedule, { world: worldRules() });
    if (r.outcome !== "ok") throw new Error(`run aborted: ${r.invariant_violations.join("; ")}`);
    events = r.events; source = "v1 on the definition executor";
  }
  const rows: { at: number; seq: number; text: string }[] = [];
  for (const e of events) {
    if (!SHOWN.has(e.kind)) continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const what = e.kind === "step.completed" ? `${e.subject} ${String(p["action_kind"])}${p["document_id"] ? ` ${String(p["document_id"])} ${String(p["stage"])}` : ""}`
      : e.kind.startsWith("world.busy") ? `${e.kind.slice(6)} ${String(p["role"])}`
      : e.kind === "world.record_updated" ? `record updated ${String(p["record_kind"])}`
      : `${e.kind} ${String(p["document_id"])} ${String(p["stage"])}`;
    const late = e.recorded_at !== e.occurred_at ? `  recorded ${clock(e.recorded_at)}` : "";
    rows.push({ at: e.occurred_at, seq: e.seq, text: `${clock(e.occurred_at)}  ${what}  ${e.actor_role ?? "-"} ${e.actor_id ?? "-"}${late}` });
  }
  for (const n of file.initial_state.notes) rows.push({ at: n.occurred_at, seq: 0, text: `${clock(n.occurred_at)}  note ${n.note_id} ${n.author_role} ${n.author_id}: ${n.untrusted_text}` });
  rows.sort((a, b) => a.at - b.at || a.seq - b.seq);
  const s = file.initial_state;
  return [`case ${file.case_id}  ward ${s.ward_id}  payer ${s.payer_type}  source ${source}`, ...rows.map((r) => r.text)];
}

export function describeCommand(args: string[]): number {
  const id = args[0];
  if (!id) { console.log("usage: describe <case_id>"); return 2; }
  try { console.log(describeCase(id).join("\n")); return 0; }
  catch (e) { console.log((e as Error).message); return 1; }
}
