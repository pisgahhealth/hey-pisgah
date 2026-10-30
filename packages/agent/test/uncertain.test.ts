import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { EmrRuntime } from "../src/emr/runtime.js";
import { DELEGATE_KIND } from "../src/emr/delegate.js";
import { EMERGENCY_KIND } from "../src/emr/entry.js";
import { emrRoot, until } from "./emr-helpers.js";
import { ARRIVAL, FileEmr } from "./recover-helpers.js";

const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const child = fileURLToPath(new URL("./recover-child.ts", import.meta.url));
type Out = { actions: { kind: string; state: string; uncertain?: { attempts: number } | null }[]; saved: { kind: string }[]; events: string[]; handed_on: number; subject_events: number };
function run(root: string, mode: string): Promise<Out> {
  return new Promise((resolve, reject) => {
    const p = spawn(tsx, [child, root, mode], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("error", reject);
    p.on("close", () => { try { resolve(JSON.parse(out) as Out); } catch (e) { reject(e); } });
  });
}

function boot(port: FileEmr, reconcileMs: number[] = [20, 20, 20], root = emrRoot()) {
  let rt: EmrRuntime | null = null;
  const failed: string[] = [];
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: () => { throw new Error("no model call is expected"); }, taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1, reconcileMs, onArrivalFailed: (_o, _t, reason) => failed.push(reason) });
  rt.start();
  return { rt, root, failed };
}
const arrive = (rt: EmrRuntime) => rt.emergency("doc-1", { text: "hey Pisgah, emergency", spoken_at: new Date().toISOString(), args: { unidentified_ref: "Unknown arrival 10:00", reason: "Emergency arrival" } });
const arrivals = (port: FileEmr) => port.saved().filter((w) => w.kind === EMERGENCY_KIND).length;
const types = (root: string, taskId: string) => readStream(root, `emr/${taskId}`).map((e) => e.record_type);
const uncertainOf = (rt: EmrRuntime, taskId: string) => (rt.view(taskId)!.actions[0] as { uncertain?: { attempts: number; reason: string } }).uncertain;

describe("a write whose answer was lost", () => {
  it("lost once: held as uncertain, reconciled under its own key, completed with one arrival and one hand-off", async () => {
    const port = FileEmr.in(emrRoot());
    port.loseAnswers = 1;
    const { rt, root, failed } = boot(port);
    const r = await arrive(rt);
    await until(() => rt.view(r.task_id)!.actions.length === 2 && rt.view(r.task_id)!.actions.every((a) => a.state === "completed"), 5000);
    await rt.settled();
    const ev = types(root, r.task_id);
    expect(ev).toContain("action.uncertain");
    expect(ev).not.toContain("action.failed");
    expect(arrivals(port)).toBe(1);
    expect(port.saved().filter((w) => w.kind === DELEGATE_KIND)).toHaveLength(1);
    expect(rt.view(r.task_id)!.patient_id).toBe(ARRIVAL);
    expect(failed).toEqual([]);
    await rt.stop();
  });

  it("lost twice: the reply and the retry's reply both lost, stays uncertain, never failed, and its dependents wait until the next read proves it", async () => {
    const port = FileEmr.in(emrRoot());
    port.loseAnswers = 2;
    port.canFind = false;
    const { rt, root, failed } = boot(port, [400]);
    const r = await arrive(rt);
    await until(() => (uncertainOf(rt, r.task_id)?.attempts ?? 0) >= 2, 3000);
    const v = rt.view(r.task_id)!;
    expect(v.actions.map((a) => a.state)).toEqual(["uncertain"]);
    expect(v.state).toBe("running");
    expect(v.patient_id).toBeNull();
    expect(failed).toEqual([]);
    await until(() => rt.view(r.task_id)!.actions.length === 2 && rt.view(r.task_id)!.actions.every((a) => a.state === "completed"), 5000);
    await rt.settled();
    expect(types(root, r.task_id)).not.toContain("action.failed");
    expect(arrivals(port)).toBe(1);
    expect(port.saved().filter((w) => w.kind === DELEGATE_KIND)).toHaveLength(1);
    await rt.stop();
  });

  it("a door that fails after its commit and frees the key: the record itself is read before any retry, so no second arrival is made", async () => {
    const port = FileEmr.in(emrRoot());
    port.failAfterSave = 1;
    const { rt, root } = boot(port);
    const r = await arrive(rt);
    await until(() => rt.view(r.task_id)!.actions.length === 2 && rt.view(r.task_id)!.actions.every((a) => a.state === "completed"), 5000);
    await rt.settled();
    expect(port.finds).toBeGreaterThanOrEqual(1);
    expect(arrivals(port)).toBe(1);
    const ev = types(root, r.task_id);
    expect(ev.indexOf("action.reconciled")).toBeGreaterThan(ev.indexOf("action.uncertain"));
    expect(ev.filter((e) => e === "action.retry")).toHaveLength(0);
    await rt.stop();
  });

  it("a definite 4xx from the hospital stays refused, with no reconcile and nothing saved", async () => {
    const port = FileEmr.in(emrRoot());
    port.refuse = true;
    const { rt, root } = boot(port);
    const r = await arrive(rt);
    await rt.settled();
    await new Promise((res) => setTimeout(res, 100));
    expect(rt.view(r.task_id)!.actions.map((a) => a.state)).toEqual(["refused"]);
    expect(types(root, r.task_id)).not.toContain("action.uncertain");
    expect(port.finds).toBe(0);
    expect(arrivals(port)).toBe(0);
    await rt.stop();
  });
});

describe("lost, then a restart", () => {
  for (const [how, mode, by] of [["the record itself", "none", "action.reconciled"], ["the same key sent again", "replay", "action.retry"]] as const) {
    it(`rebuilds the uncertain arrival, reconciles it first by ${how}, and completes it with one arrival and one hand-off`, async () => {
      const root = emrRoot();
      const first = await run(root, "lost");
      expect(first.actions).toEqual([expect.objectContaining({ kind: EMERGENCY_KIND, state: "uncertain", uncertain: expect.objectContaining({ attempts: 4 }) })]);
      expect(first.events).not.toContain("action.failed");
      expect(first.saved.filter((w) => w.kind === EMERGENCY_KIND)).toHaveLength(1);
      const again = await run(root, mode);
      expect(again.actions.map((a) => [a.kind, a.state])).toEqual([[EMERGENCY_KIND, "completed"], [DELEGATE_KIND, "completed"]]);
      expect(again.saved.filter((w) => w.kind === EMERGENCY_KIND)).toHaveLength(1);
      expect(again.saved.filter((w) => w.kind === DELEGATE_KIND)).toHaveLength(1);
      expect([again.subject_events, again.handed_on]).toEqual([1, 1]);
      // The restart settles the uncertain write before anything that depends on it.
      const after = again.events.slice(first.events.length);
      expect(after[0]).toBe(by);
      expect(after.indexOf("action.written")).toBeLessThan(after.indexOf("delegation.made"));
    }, 60_000);
  }
});
