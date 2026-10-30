import { ModelClient } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { EmrRuntime } from "../src/emr/runtime.js";
import { EMERGENCY_KIND } from "../src/emr/entry.js";
import { FileEmr } from "./recover-helpers.js";

// One process of the recovery test: opens an arrival on a file-backed hospital, dies in its verification read, misses it, or runs clean.
const [root, mode] = process.argv.slice(2) as [string, "kill-in-prove" | "unproved" | "no-handoff" | "lost" | "replay" | "none"];
const port = FileEmr.in(root);
if (mode === "kill-in-prove") port.onProve = () => process.kill(process.pid, "SIGKILL");
if (mode === "unproved") port.proveMisses = 1000;
// Every answer the door gives is lost, so the process stops with the arrival saved and its outcome unknown.
if (mode === "lost") { port.loseAnswers = 1000; port.canFind = false; }
// A hospital with no read that finds the record, so only the same key sent again can settle the write.
if (mode === "replay") port.canFind = false;
// Stands in for a stop between the verified write and its hand-off: the write completes and nothing follows it in the journal.
if (mode === "no-handoff") port.handOff = false;
let subjects = 0;
let rt: EmrRuntime | null = null;
const client = new ModelClient({ storeRoot: root, mode: "mock", mock: () => { throw new Error("no model call is expected"); }, taskStateOf: (id) => rt?.stateOf(id) ?? null });
rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1, reconcileMs: [20, 20], onSubject: () => { subjects += 1; } });
rt.start();
if (rt.taskIds().length === 0) await rt.emergency("doc-1", { text: "hey Pisgah, emergency", spoken_at: new Date().toISOString(), args: { unidentified_ref: "Unknown arrival 10:00", reason: "Emergency arrival" } });
const id = rt.taskIds()[0]!;
const done = () => {
  const v = rt!.view(id)!;
  const a = v.actions.find((x) => x.kind === EMERGENCY_KIND)!;
  if (mode === "lost") return a.state === "uncertain" && (a as { uncertain?: { attempts: number } }).uncertain?.attempts === 4;
  return a.state === "completed" ? v.actions.every((x) => x.state === "completed") && (mode === "no-handoff" || v.actions.length === 2) : mode === "unproved" && (a as { awaiting_verification?: { attempts: number } }).awaiting_verification?.attempts === 3;
};
for (let i = 0; i < 500 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
await rt.settled();
const events = readStream(root, `emr/${id}`).map((e) => e.record_type);
const v = rt.view(id)!;
process.stdout.write(JSON.stringify({
  actions: v.actions.map((a) => ({ kind: a.kind, state: a.state, awaiting: (a as { awaiting_verification?: unknown }).awaiting_verification ?? null, ...(mode === "lost" ? { uncertain: (a as { uncertain?: unknown }).uncertain ?? null } : {}) })),
  events,
  saved: port.saved(), subjects, subject_events: events.filter((e) => e === "task.subject").length, handed_on: events.filter((e) => e === "delegation.made").length, patient_id: v.patient_id
}));
await rt.stop();
client.close();
