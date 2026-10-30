import { join } from "node:path";
import { runValidationStream } from "@hey-pisgah/evaluator";
import { DiscoveryPool, Session, checkDiscovery, commitmentFor, runCycleLoop, scriptedInvestigator } from "@hey-pisgah/intelligence";
import { budgetFromEnv, createModelClient, type Mode } from "@hey-pisgah/model";

// The discover command's adaptive path on the committed world at effort low, which its effort gate refuses under revision 12; no wrapper and no hint.
// npx tsx apps/cli/src/discover-low.ts --store <dir> --run-id run-xxxxxxxx --budget-usd N --max-calls N
const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const root = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const store = flag("store")!;
const runId = flag("run-id")!;
const budgetUsd = Number(flag("budget-usd"));
const maxCalls = Number(flag("max-calls"));
const mode = (process.env.HEY_PISGAH_MODE as Mode | undefined) ?? "mock";
const commitment = commitmentFor(root, "adaptive");
if (mode === "live" && !commitment) throw new Error("the adaptive arm does not match the last committed revision");
const client = createModelClient({ storeRoot: store, mode, recordingsDir: join(store, "recordings"), mock: scriptedInvestigator("adaptive"), timeoutMs: 300_000, budget: { ...budgetFromEnv(), runUsd: budgetUsd, runMaxCalls: maxCalls } });
const session = new Session({ storeRoot: store, runId, arm: "adaptive", cycle: 1, pool: new DiscoveryPool(undefined, [], []), validate: async (s) => { await runValidationStream(s, {}); }, usage: () => ({ ...client.runUsage(runId), max_calls: maxCalls, max_usd: budgetUsd }) });
try {
  const r = await runCycleLoop({ client, session, maxCalls, budgetUsd, effort: "low", commitment: commitment ?? { revision: null, hash: null } });
  console.log(`discover ${runId}: effort low, mode ${client.mode}, stop ${r.stop} (${r.detail}), ${r.calls} calls, $${r.usd.toFixed(4)}`);
} finally {
  session.close();
  client.close();
}
for (const l of checkDiscovery(store, runId).lines) console.log(l);
