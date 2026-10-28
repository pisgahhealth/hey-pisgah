import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadV1, loadWardRequirements, worldRules } from "@hey-pisgah/hospital";
import { ModelClient, type MockResponder } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { Registry } from "@hey-pisgah/workflow";
import { loadCases } from "../src/cases.js";
import { scriptedAgent } from "../src/mock.js";
import { AgentRuntime, type RuntimeOptions } from "../src/runtime.js";
import type { CaseWorld } from "../src/world.js";

export const GOAL = "Complete the discharge paperwork for this patient.";
export const OWNER = "nurse n-a1";
export const tempRoot = () => mkdtempSync(join(tmpdir(), "hp-agent-"));
export const registry = () => Registry.load([loadV1()]);
export const baseCase = (): CaseWorld => structuredClone(loadCases().get("c-agent001")!);

// A copy of the base case under a new id with its schedule edited.
export function variant(caseId: string, edit: (w: CaseWorld) => void): CaseWorld {
  const w = baseCase();
  w.case_id = caseId;
  w.schedule.case_id = caseId;
  edit(w);
  return w;
}
export function r2(): CaseWorld["requirements"][number]["set"] {
  const s = structuredClone(loadWardRequirements());
  s.requirement_version = "r2";
  for (const w of s.wards) w.version = "r2";
  return s;
}

export type Harness = { rt: AgentRuntime; client: ModelClient; bodies: Record<string, unknown>[]; close: () => Promise<void> };

export function harness(root: string, o: { mock?: MockResponder; cases?: CaseWorld[]; runtime?: Partial<RuntimeOptions> } = {}): Harness {
  const bodies: Record<string, unknown>[] = [];
  const inner = o.mock ?? scriptedAgent();
  const cases = new Map(loadCases());
  for (const c of o.cases ?? []) cases.set(c.case_id, c);
  let rt: AgentRuntime | null = null;
  const client = new ModelClient({
    storeRoot: root, mode: "mock", mock: (req) => { bodies.push(req.body); return inner(req); },
    taskStateOf: (id) => rt?.stateOf(id) ?? null,
    budget: { runUsd: 5, runMaxCalls: 400, weekUsd: 120, weekStopFraction: 0.8, weekSince: () => new Date(0) }
  });
  rt = new AgentRuntime({ storeRoot: root, client, cases, registry: registry(), world: worldRules(), pollMs: 3, ...(o.runtime ?? {}) });
  const h = rt;
  return { rt: h, client, bodies, close: async () => { await h.stop(); client.close(); } };
}

export const taskRecords = (root: string, id: string) => readStream(root, `tasks/${id}`);
export const ofType = (root: string, id: string, t: string) => taskRecords(root, id).filter((e) => e.record_type === t);
