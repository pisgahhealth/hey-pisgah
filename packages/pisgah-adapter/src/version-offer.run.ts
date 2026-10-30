import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EmrRuntime, versionWiring, type VersionWiring } from "@hey-pisgah/agent";
import { readStream } from "@hey-pisgah/store";
import { loadV1 } from "@hey-pisgah/hospital";
import { ModelClient } from "@hey-pisgah/model";
import { PisgahPort } from "./port.js";
import { loadProfile } from "./profile.js";
import { SandboxBlock, mintAgentBearer } from "./sandbox.js";
import { adoptedForEmr, requirementsNow } from "./versions.js";

// Opens one owner's task on a live stay under a version and watches the EMR until the version's offer is made or the wait ends; no model is called.
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] ?? null : null; };
async function main(): Promise<void> {
  const out = arg("out"), login = arg("login"), admission = arg("admission");
  if (!out || !login || !admission) throw new Error("usage: version-offer.run.ts --login <owner login> --admission <id> --out <private dir> [--versions <version log> | --v1] [--wait-ms n]");
  const profile = loadProfile();
  const sb = SandboxBlock.parse(profile.sandbox);
  const who = sb.owners.find((o) => o.login === login) ?? null;
  const m = mintAgentBearer(sb, who);
  const storeRoot = join(out, "store");
  mkdirSync(storeRoot, { recursive: true });
  const spec = () => loadProfile().versions!;
  let wiring: VersionWiring;
  let def: { version: number; definition_hash: string };
  if (arg("versions")) {
    const a = adoptedForEmr(storeRoot, arg("versions")!, spec);
    wiring = a.wiring;
    def = a.def;
  } else {
    const v1 = loadV1();
    const v = spec();
    wiring = versionWiring({ def: v1, parent: null, counterparts: { steps: v.steps, events: v.events, documents: v.documents }, requirements: requirementsNow(spec) });
    def = v1;
  }
  const port = new PisgahPort(profile, { bearers: { [m.owner]: m.bearer } });
  let rt: EmrRuntime | null = null;
  const client = new ModelClient({ storeRoot, mode: "mock", mock: () => { throw new Error("no model call is made here"); }, taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot, client, port, holdMs: 0, proofRetryMs: 1500, watchMs: 2000, versions: wiring });
  rt.start();
  const t0 = Date.now();
  const wait = Number(arg("wait-ms") ?? 20_000);
  const { task_id } = await rt.open(m.owner, { admission_id: admission });
  while (Date.now() - t0 < wait && !(rt.view(task_id)?.version && rt.view(task_id)!.questions.length)) await new Promise((r) => setTimeout(r, 500));
  const v = rt.view(task_id)!;
  await rt.stop();
  client.close();
  const rows = readStream(storeRoot, `emr/${task_id}`);
  const made = rows.filter((r) => r.record_type === "offer.made" && (r.payload as Record<string, unknown>)["version"] !== undefined).map((r) => ({ at: r.wall_at, ...(r.payload as Record<string, unknown>) }));
  const watch = rows.filter((r) => r.record_type === "watch.changed").map((r) => (r.payload as { facts: Record<string, string | null> }).facts);
  const result = { version: def.version, definition_hash: def.definition_hash, task_id, owner_login: login, offers_made: made.length, offers: made, questions: v.questions.map((q) => q.text), lines: v.version?.lines ?? [], blocked: v.version?.blocked ?? [], watched: watch.at(-1) ?? null, waited_ms: Date.now() - t0 };
  writeFileSync(join(out, "offer.json"), `${JSON.stringify(result, null, 1)}\n`);
  process.stdout.write(`version ${result.version}: offers made ${result.offers_made}; ${result.questions.join(" ") || "no question"}\n`);
}
main().catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });
