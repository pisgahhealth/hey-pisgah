import type { LedgerRow } from "@hey-pisgah/contracts";
import { readStream } from "@hey-pisgah/store";

// Every model call or refused call that touched a waiting task, from the run ledger and the task stream; empty means zero calls while waiting.
export function callsWhileWaiting(storeRoot: string, taskId: string, runId: string): string[] {
  const out: string[] = [];
  for (const e of readStream(storeRoot, `ledger/${runId}`)) {
    const row = e.payload as Partial<LedgerRow> & { reason?: string };
    if (e.record_type === "model.call" && row.task_id === taskId && row.task_state === "waiting") out.push(`ledger seq ${e.seq}: a ${row.thread} call while waiting`);
    if (e.record_type === "model.refused" && row.task_id === taskId && row.reason === "refused_while_waiting") out.push(`ledger seq ${e.seq}: a call refused while waiting`);
  }
  let state = "running";
  for (const e of readStream(storeRoot, `tasks/${taskId}`)) {
    const p = e.payload as { to?: string };
    if (e.record_type === "task.state_changed") state = String(p.to);
    else if (e.record_type === "task.resumed") state = "running";
    else if (e.record_type === "model.turn" && state === "waiting") out.push(`task seq ${e.seq}: a model turn while waiting`);
  }
  return out;
}
