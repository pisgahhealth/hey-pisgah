// Prepares one G10 strip run on the sandbox: a fresh arrival, admitted by the agent through the serve under test, printed as JSON for the walk.
import { loadProfile } from "../src/profile.js";
import { SandboxBlock } from "../src/sandbox.js";
import { freshArrival } from "./sandbox-helpers.js";

const serve = process.env["G10_SERVE"] ?? "http://127.0.0.1:4133";
const label = process.env["G10_LABEL"] ?? "G10 Child";
const profile = loadProfile();
const owner = SandboxBlock.parse(profile.sandbox).owner;
const { patient } = await freshArrival(profile, label);
const r = await fetch(`${serve}/tasks/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, patientId: patient, text: "Admit him as an emergency to the children's ward for abdominal pain." }) });
if (r.status !== 202) throw new Error(`say answered ${r.status}`);
const taskId = ((await r.json()) as { task_id: string }).task_id;
let admission: string | null = null;
for (let i = 0; i < 300 && !admission; i++) {
  await new Promise((done) => setTimeout(done, 1000));
  const tasks = (await (await fetch(`${serve}/tasks?owner=${owner}`)).json()) as { task_id: string; admission_id?: string | null; state: string }[];
  const t = tasks.find((x) => x.task_id === taskId);
  if (t?.admission_id) admission = t.admission_id;
  else if (t && ["failed", "refused"].includes(t.state)) throw new Error(`admission task ${t.state}`);
}
if (!admission) throw new Error("no admission after 5 minutes");
process.stdout.write(`${JSON.stringify({ owner, patient, admission, task_id: taskId })}\n`);
