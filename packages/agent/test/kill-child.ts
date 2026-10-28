import { canonical } from "@hey-pisgah/contracts";
import { ModelClient } from "@hey-pisgah/model";
import { loadCases } from "../src/cases.js";
import { scriptedAgent } from "../src/mock.js";
import { AgentRuntime, type Boundary } from "../src/runtime.js";
import { project } from "../src/task.js";
import { GOAL, OWNER, registry } from "./helpers.js";

// Runs the v1 case to a settled state; with a crash spec it kills itself with SIGKILL at that boundary hit.
const [root, spec] = process.argv.slice(2) as [string, string];
const [crashAt, nth] = spec === "none" ? [null, 0] : [spec.split(":")[0] as Boundary, Number(spec.split(":")[1])];
const hits: Record<string, number> = {};
let rt: AgentRuntime | null = null;
const client = new ModelClient({
  storeRoot: root, mode: "mock", mock: scriptedAgent({ notify: true }), taskStateOf: (id) => rt?.stateOf(id) ?? null,
  budget: { runUsd: 5, runMaxCalls: 400, weekUsd: 120, weekStopFraction: 0.8, weekSince: () => new Date(0) }
});
rt = new AgentRuntime({
  storeRoot: root, client, cases: loadCases(), registry: registry(), pollMs: 2,
  boundary: (b) => {
    hits[b] = (hits[b] ?? 0) + 1;
    if (b === crashAt && hits[b] === nth) process.kill(process.pid, "SIGKILL");
  }
});
rt.start();
if (rt.taskIds().length === 0) rt.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER });
await rt.settled(60_000);
const id = rt.taskIds()[0]!;
const live = (rt as unknown as { tasks: Map<string, { stream: { records(): readonly import("@hey-pisgah/contracts").Envelope[] }; port: import("../src/port.js").HospitalPort }> }).tasks.get(id)!;
const p = project(live.stream.records());
const port = live.port;
const actions = p.order.map((a) => p.actions.get(a)!).map((a) => ({
  action_id: a.action_id, action_kind: a.action_kind, state: a.state, intent_key: a.intent_key, args: a.args,
  proof: a.proof ? { ...a.proof, verified_at: { occurred_at: a.proof.verified_at.occurred_at, recorded_at: a.proof.verified_at.recorded_at } } : null,
  effective_writes: port.writesFor(a.intent_key).length
}));
const resumedByWake: Record<string, number> = {};
for (const e of live.stream.records()) if (e.record_type === "task.resumed") { const w = String((e.payload as { wake_id: string }).wake_id); resumedByWake[w] = (resumedByWake[w] ?? 0) + 1; }
const out = {
  hits,
  final: { state: p.state, conditions: p.conditions, actions, effect_set_hash: port.effectSetHash(), closed_effect: p.closed?.["effect_set_hash"] ?? null, now: port.now(), writes: port.allWrites().length },
  resumedByWake, retries: p.counts.retries
};
process.stdout.write(canonical(JSON.parse(JSON.stringify(out))));
await rt.stop();
client.close();
