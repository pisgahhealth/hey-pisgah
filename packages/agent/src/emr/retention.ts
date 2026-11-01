import type { Stream } from "@hey-pisgah/store";
import type { EmrObligation, EmrTask } from "./runtime.js";

// The obligations of a task still held or fired; lane B5's mirror and lane B3's retention read the same rule.
export function openObligations(t: Pick<EmrTask, "obligations">): EmrObligation[] {
  return t.obligations.filter((o) => o.state === "held" || o.state === "fired");
}

const SETTLED = new Set(["completed", "refused", "cancelled", "failed"]);

// Final closure: done, every action settled and every completed one proved, and nothing still open that could need the words.
export function finallyClosed(t: EmrTask): boolean {
  if (t.state !== "done") return false;
  if (openObligations(t).length > 0) return false;
  if (t.questions.some((q) => q.answered_by === null)) return false;
  if (t.identities.some((i) => i.state === "open")) return false;
  if (t.delegations.some((d) => d.completed_at === null || !!d.waiting)) return false;
  return [...t.actions.values()].every((a) => SETTLED.has(a.state) && !a.unverified && (a.state !== "completed" || a.proof !== null));
}

// Drops the words of a finally closed task from its journal, keeping line ids, digests, record ids and the patient label; a failure is logged and the words stay sealed.
export function retainClosed(stream: Stream, t: EmrTask, log?: (line: string) => void): number {
  if (!finallyClosed(t)) return 0;
  try {
    return stream.retain().fields;
  } catch (e) {
    log?.(`retention skipped for ${t.task_id}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    return 0;
  }
}
