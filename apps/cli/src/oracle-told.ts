import { join } from "node:path";
import { runValidationStream } from "@hey-pisgah/evaluator";
import { Session, checkDiscovery, commitmentFor, runLoop, scriptedInvestigator } from "@hey-pisgah/intelligence";
import { createModelClient } from "@hey-pisgah/model";

// The quarantined told-answer kickoff for the oracle replay; it is never part of a committed prompt and never reaches a blind run.
export const TOLD_KICKOFF = "Session start. The pool holds 12 recorded discharge cases. Budget: {calls} model calls, {usd} US dollars, 3 proposals. You are told the answer in words: let the nurse's discharge summary draft start once the take-home medicines are ordered, instead of waiting for the doctor's clinical discharge. Express that change with the operations in the workflow definition, test it with run_experiment, and submit it with submit_proposal.";

// npx tsx apps/cli/src/oracle-told.ts --store <dir> --run-id run-xxxxxxxx --max-calls N --budget-usd N [--effort high] [--recordings dir]
const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const root = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const store = flag("store")!;
const runId = flag("run-id")!;
const maxCalls = Number(flag("max-calls") ?? 30);
const budgetUsd = Number(flag("budget-usd") ?? 3);
const effort = (flag("effort") ?? "high") as "medium" | "high";
const mode = (process.env.HEY_PISGAH_MODE as "live" | "replay" | "mock" | undefined) ?? "mock";
const client = createModelClient({ storeRoot: store, mode, recordingsDir: flag("recordings") ?? join(store, "recordings"), mock: scriptedInvestigator("adaptive"), budget: { runUsd: budgetUsd, runMaxCalls: maxCalls, weekUsd: 120, weekStopFraction: 0.8, weekSince: () => new Date(Date.now() - 7 * 24 * 3600 * 1000) } });
const session = new Session({ storeRoot: store, runId, arm: "adaptive", validate: async (s) => { await runValidationStream(s); }, usage: () => ({ ...client.runUsage(runId), max_calls: maxCalls, max_usd: budgetUsd }) });
const kick = TOLD_KICKOFF.replace("{calls}", String(maxCalls)).replace("{usd}", budgetUsd.toFixed(2));
const r = await runLoop({ client, session, maxCalls, budgetUsd, effort, quarantinedKickoff: kick, commitment: commitmentFor(root, "adaptive") ?? { revision: null, hash: null } });
console.log(JSON.stringify(r));
session.close();
client.close();
for (const l of checkDiscovery(store, runId).lines) console.log(l);
