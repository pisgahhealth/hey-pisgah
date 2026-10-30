import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import { EmrRuntime } from "../src/emr/runtime.js";
import { DELEGATE_KIND } from "../src/emr/delegate.js";
import { EMERGENCY_KIND } from "../src/emr/entry.js";
import { emrRoot, until } from "./emr-helpers.js";
import { ARRIVAL, FileEmr } from "./recover-helpers.js";

const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const child = fileURLToPath(new URL("./recover-child.ts", import.meta.url));
type Out = { actions: { kind: string; state: string; awaiting: { attempts: number } | null }[]; saved: { kind: string; key: string }[]; subjects: number; subject_events: number; handed_on: number; patient_id: string | null };
function run(root: string, mode: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(tsx, [child, root, mode], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("error", reject);
    p.on("close", (code, signal) => resolve({ code, signal, out }));
  });
}
const count = (o: Out, kind: string) => o.saved.filter((w) => w.kind === kind).length;

function boot(port: FileEmr, root = emrRoot()) {
  let rt: EmrRuntime | null = null;
  let subjects = 0;
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: () => { throw new Error("no model call is expected"); }, taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1, reconcileMs: [20, 20, 20], onSubject: () => { subjects += 1; } });
  rt.start();
  return { rt, root, subjects: () => subjects };
}
const arrive = (rt: EmrRuntime) => rt.emergency("doc-1", { text: "hey Pisgah, emergency", spoken_at: new Date().toISOString(), args: { unidentified_ref: "Unknown arrival 10:00", reason: "Emergency arrival" } });

describe("a saved write that its verification read missed", () => {
  it("is held as saved, awaiting verification, never failed, and its hand-off runs once when a later read proves it", async () => {
    const root = emrRoot();
    const port = FileEmr.in(root);
    port.proveMisses = 3;
    port.proveThrows = 1;
    const { rt, subjects } = boot(port, root);
    const r = await arrive(rt);
    await until(() => rt.view(r.task_id)!.actions.some((a) => (a as { awaiting_verification?: unknown }).awaiting_verification !== undefined));
    const a0 = rt.view(r.task_id)!.actions[0]!;
    expect(a0.state).toBe("acknowledged");
    expect(rt.view(r.task_id)!.state).not.toBe("failed");
    await until(() => rt.view(r.task_id)!.actions.every((a) => a.state === "completed") && rt.view(r.task_id)!.actions.length === 2, 5000);
    await rt.settled();
    const v = rt.view(r.task_id)!;
    expect(v.actions.map((a) => [a.kind, a.state])).toEqual([[EMERGENCY_KIND, "completed"], [DELEGATE_KIND, "completed"]]);
    expect(port.saved().filter((w) => w.kind === EMERGENCY_KIND)).toHaveLength(1);
    expect(port.saved().filter((w) => w.kind === DELEGATE_KIND)).toHaveLength(1);
    expect(v.patient_id).toBe(ARRIVAL);
    expect(subjects()).toBe(1);
    await rt.stop();
  });

  it("keeps a write the door refused as failed, with no reconcile and no hand-off", async () => {
    const root = emrRoot();
    const port = FileEmr.in(root);
    port.refuse = true;
    const { rt } = boot(port, root);
    const r = await arrive(rt);
    await rt.settled();
    await new Promise((res) => setTimeout(res, 100));
    const v = rt.view(r.task_id)!;
    expect(v.actions.map((a) => a.state)).toEqual(["refused"]);
    expect(port.saved()).toHaveLength(0);
    await rt.stop();
  });

  it("fails a proof that names another record", async () => {
    const root = emrRoot();
    const port = FileEmr.in(root);
    port.proveOther = true;
    const { rt } = boot(port, root);
    const r = await arrive(rt);
    await rt.settled();
    expect(rt.view(r.task_id)!.actions.map((a) => [a.state, a.reason])).toEqual([["failed", "proof_for_another_record"]]);
    await rt.stop();
  });
});

describe("kill between save and verify", () => {
  it("restart reconciles by the saved record, with one write and one hand-off", async () => {
    const root = emrRoot();
    const killed = await run(root, "kill-in-prove");
    expect(killed.signal === "SIGKILL" || killed.code === 137).toBe(true);
    expect(FileEmr.in(root).saved().filter((w) => w.kind === EMERGENCY_KIND)).toHaveLength(1);
    const again = await run(root, "none");
    expect(again.code).toBe(0);
    const o = JSON.parse(again.out) as Out;
    expect(o.actions.map((a) => [a.kind, a.state])).toEqual([[EMERGENCY_KIND, "completed"], [DELEGATE_KIND, "completed"]]);
    expect(count(o, EMERGENCY_KIND)).toBe(1);
    expect(count(o, DELEGATE_KIND)).toBe(1);
    expect([o.subject_events, o.handed_on, o.subjects]).toEqual([1, 1, 1]);
    // A third start finds nothing left to do.
    const third = JSON.parse((await run(root, "none")).out) as Out;
    expect([count(third, EMERGENCY_KIND), count(third, DELEGATE_KIND), third.subject_events, third.handed_on, third.subjects]).toEqual([1, 1, 1, 1, 0]);
  }, 60_000);

  it("a write left awaiting verification when the process stopped is reconciled after the restart", async () => {
    const root = emrRoot();
    const first = JSON.parse((await run(root, "unproved")).out) as Out;
    expect(first.actions).toEqual([{ kind: EMERGENCY_KIND, state: "acknowledged", awaiting: expect.objectContaining({ attempts: 3 }) }]);
    const again = JSON.parse((await run(root, "none")).out) as Out;
    expect(again.actions.map((a) => [a.kind, a.state])).toEqual([[EMERGENCY_KIND, "completed"], [DELEGATE_KIND, "completed"]]);
    expect([count(again, EMERGENCY_KIND), count(again, DELEGATE_KIND), again.subject_events, again.handed_on]).toEqual([1, 1, 1, 1]);
  }, 60_000);

  it("a hand-off missing after a stop right after the verified write runs once at the restart", async () => {
    const root = emrRoot();
    const first = JSON.parse((await run(root, "no-handoff")).out) as Out;
    expect(first.actions.map((a) => a.state)).toEqual(["completed"]);
    const again = JSON.parse((await run(root, "none")).out) as Out;
    expect(again.actions.map((a) => [a.kind, a.state])).toEqual([[EMERGENCY_KIND, "completed"], [DELEGATE_KIND, "completed"]]);
    const third = JSON.parse((await run(root, "none")).out) as Out;
    expect([count(third, EMERGENCY_KIND), count(third, DELEGATE_KIND), third.handed_on, third.subject_events]).toEqual([1, 1, 1, 1]);
  }, 60_000);
});
