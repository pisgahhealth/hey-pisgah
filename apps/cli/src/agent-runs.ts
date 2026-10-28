import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_CASES_DIR, HospitalPort, callsWhileWaiting, loadCases, recordedWorld, startServe } from "@hey-pisgah/agent";
import type { LedgerRow, WorkflowDefinition } from "@hey-pisgah/contracts";
import type { Manifest } from "@hey-pisgah/cases";
import { completionMatrix, recordStateFromRun, turnTextVsProof, sumTextClaims, type AgentRunData, type RuntimeEvent } from "@hey-pisgah/evaluator";
import { loadV1, worldRules } from "@hey-pisgah/hospital";
import { listStreams, openStream, readStream } from "@hey-pisgah/store";
import { Registry } from "@hey-pisgah/workflow";
import type { WorldRules } from "@hey-pisgah/simulator";

export type AgentWorld = { casesDir: string; registry: Registry; world: WorldRules | null };
export const defaultWorld = (): AgentWorld => ({ casesDir: FIXTURE_CASES_DIR, registry: Registry.load([loadV1()]), world: worldRules() });
export const replayWorld = (name: string): AgentWorld => recordedWorld(name);

// Runs one agent task to its end in a fresh store, in mock or replay mode; neither makes a model call.
export async function runAgentOnce(storeRoot: string, mode: "mock" | "replay", w: AgentWorld, caseId = "c-agent001"): Promise<void> {
  const s = await startServe({ storeRoot, mode, casesDir: w.casesDir, registry: w.registry, world: w.world, port: 0, clock: "auto", pollMs: 50 });
  try {
    s.runtime.openTask({ case_id: caseId, goal: "Complete the discharge paperwork for this patient.", owner: "nurse n-a1" });
    await s.runtime.settled(300_000);
  } finally { await s.close(); }
}

const events = (root: string, id: string): RuntimeEvent[] => readStream(root, id).map((e) => ({ seq: e.seq, record_type: e.record_type, payload: e.payload }));

// Reads a closed agent store into the evaluator's data shape: FR-5 matrix from the record state, turn-text claims, prohibited counts and ledger facts.
export function agentRunData(storeRoot: string, label: string, mode: AgentRunData["mode"], w: AgentWorld): AgentRunData {
  const cases = loadCases(w.casesDir);
  const taskIds = listStreams(storeRoot, "tasks").map((s) => s.replace(/^tasks\//, "")).sort();
  const opened = new Map(taskIds.map((id) => [id, (events(storeRoot, `tasks/${id}`).find((e) => e.record_type === "task.opened")?.payload ?? {}) as { case_id?: string; run_id?: string }]));
  const ports = new Map<string, { def: WorkflowDefinition; run: ReturnType<HospitalPort["run"]> }>();
  const port = (caseId: string) => {
    if (!ports.has(caseId)) {
      const p = HospitalPort.open(storeRoot, cases.get(caseId)!, w.registry, w.world);
      try { ports.set(caseId, { def: p.def, run: p.run() }); } finally { p.close(); }
    }
    return ports.get(caseId)!;
  };
  const caseOf = (id: string) => String(opened.get(id)?.case_id);
  const completion = completionMatrix(
    { taskIds: () => taskIds, caseOf, events: (id) => events(storeRoot, `tasks/${id}`) },
    { recordState: (caseId) => { const world = cases.get(caseId); if (!world) return null; const p = port(caseId); return recordStateFromRun(p.run, p.def, { ward_id: String(world.schedule.facts["ward_id"]), requirement_version: world.requirements[0]!.set.requirement_version } as Manifest); } },
    (caseId) => port(caseId).def
  );
  const text = sumTextClaims(taskIds.map((id) => turnTextVsProof(events(storeRoot, `tasks/${id}`))));
  const rows = taskIds.flatMap((id) => readStream(storeRoot, `ledger/${opened.get(id)?.run_id}`).filter((e) => e.record_type === "model.call").map((e) => e.payload as LedgerRow));
  const turns = taskIds.flatMap((id) => events(storeRoot, `tasks/${id}`).filter((e) => e.record_type === "model.turn").map((e) => (e.payload as { ledger?: { response_id?: string } | null; response_id?: string | null }).response_id ?? null));
  const ids = new Set(rows.map((r) => r.response_id));
  const waiting = taskIds.reduce((s, id) => s + callsWhileWaiting(storeRoot, id, String(opened.get(id)?.run_id)).length, 0);
  return {
    label, mode, completion, text,
    prohibited_executed: [...new Set(taskIds.map(caseOf))].reduce((s, c) => s + port(c).run.metrics.prohibited_executed, 0),
    prohibited_attempted: [...new Set(taskIds.map(caseOf))].reduce((s, c) => s + port(c).run.metrics.prohibited_attempted, 0),
    ledger: {
      calls: rows.length, calls_while_waiting: waiting, usd: rows.reduce((s, r) => s + r.cost_usd, 0), latency_ms: rows.map((r) => r.latency_ms),
      providers: rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.provider]: (m[r.provider] ?? 0) + 1 }), {}),
      turns_without_row: turns.filter((t) => t !== null && !ids.has(t)).length, request_ids: rows.map((r) => r.response_id).filter((x): x is string => x !== null),
      negative_control_red: negativeControl(storeRoot, taskIds[0], opened.get(taskIds[0] ?? "")?.run_id)
    }
  };
}

// Plants one model call marked waiting in a copy of the store; the zero-calls check must then turn red.
function negativeControl(storeRoot: string, taskId: string | undefined, runId: string | undefined): boolean {
  if (!taskId || !runId) return false;
  const tmp = mkdtempSync(join(tmpdir(), "hp-negctl-"));
  try {
    cpSync(storeRoot, tmp, { recursive: true });
    rmSync(join(tmp, ".lock"), { force: true });
    const s = openStream(tmp, `ledger/${runId}`, { writer: true });
    const last = s.records().filter((e) => e.record_type === "model.call").at(-1);
    s.append("model.call", { ...(last?.payload as object), task_state: "waiting" }, { recorded_at: 0, occurred_at: 0 });
    s.close();
    return callsWhileWaiting(tmp, taskId, runId).length > 0;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
