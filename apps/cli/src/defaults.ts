import { PreferenceMemory, deriveDefaults, pastEntries, projectEmr, type EmrTask } from "@hey-pisgah/agent";
import { listStreams, readStream } from "@hey-pisgah/store";

// Derives one owner's defaults from their own past entries: npx tsx apps/cli/src/defaults.ts --owner id --store root [--store root ...] [--offer]; prints counts only, never note text.
const argv = process.argv.slice(2);
const all = (k: string) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]!] : []));
const owner = all("owner")[0];
const stores = all("store");
if (!owner || !stores.length) { console.error("--owner and at least one --store are required"); process.exit(2); }

function storeTasks(root: string): EmrTask[] {
  return listStreams(root, "emr").flatMap((sid) => { try { return [projectEmr(readStream(root, sid))]; } catch { return []; } });
}

const tasks = stores.flatMap(storeTasks);
const entries = pastEntries(tasks, owner);
const readings = deriveDefaults(entries);
const out: Record<string, unknown> = {
  stores: stores.length, tasks_of_owner: tasks.filter((t) => t.owner === owner).length, said_entries: entries.length,
  derived: readings.map((r) => ({ field: r.field, item_kind: r.item_kind, value: r.value, k: r.k, n: r.n, cites: r.cites.length }))
};
// Offering writes candidates into the one store's preference stream; the serve on that store must be stopped, since it holds the writer.
if (argv.includes("--offer")) {
  if (stores.length !== 1) { console.error("--offer takes exactly one --store"); process.exit(2); }
  const mem = new PreferenceMemory(stores[0]!);
  try { out["offered"] = mem.derived(owner, readings).length; } finally { mem.close(); }
}
console.log(JSON.stringify(out));
