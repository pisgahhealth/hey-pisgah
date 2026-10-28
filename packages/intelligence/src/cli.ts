import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Operation } from "@hey-pisgah/contracts";
import { budgetFromEnv, createModelClient, type Mode, type ProviderId } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { z } from "zod";
import { checkDiscovery } from "./check.js";
import { commitmentFor } from "./commitments.js";
import { SETTINGS, runLoop } from "./loop.js";
import { scriptedInvestigator } from "./mock.js";
import { DiscoveryPool, type OutcomeCase } from "./pool.js";
import { ARMS } from "./prompts.js";
import { STREAMS, Session, type Arm, type ListedExperiment } from "./session.js";

export const INTELLIGENCE_RECORDINGS_DIR = new URL("../fixtures/recordings", import.meta.url).pathname;
const flag = (argv: readonly string[], name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const ListedOrder = z.union([z.array(z.strictObject({ ops: z.array(Operation).min(1).max(3), case_ids: z.array(z.string()).min(1).max(6) })), z.object({ order: z.array(z.object({ ops: z.array(Operation).min(1).max(3), case_ids: z.array(z.string()).min(1).max(6) })) })]);

export type DiscoverDeps = { validate?: (storeRoot: string) => Promise<void>; out?: (line: string) => void; mode?: Mode };

// discover --arm adaptive|a3|a4|prior --budget-usd N --max-calls M [--run-id run-xxxxxxxx] [--store dir] [--a4-order file] [--cycle 2] [--insufficient-evidence]
export async function discoverCommand(root: string, argv: readonly string[], deps: DiscoverDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const arm = (flag(argv, "arm") ?? "adaptive") as Arm;
  if (!ARMS.includes(arm)) { out(`discover: --arm must be one of ${ARMS.join(", ")}`); return 2; }
  const env = budgetFromEnv();
  const budgetUsd = Number(flag(argv, "budget-usd") ?? env.runUsd);
  const maxCalls = Number(flag(argv, "max-calls") ?? env.runMaxCalls);
  if (!(budgetUsd > 0) || !(maxCalls > 0)) { out("discover: --budget-usd and --max-calls must be positive"); return 2; }
  const storeRoot = flag(argv, "store") ?? join(root, ".hey-pisgah", "store");
  const runId = flag(argv, "run-id") ?? `run-${randomBytes(4).toString("hex")}`;
  const mode = deps.mode ?? ((process.env.HEY_PISGAH_MODE as Mode | undefined) ?? "mock");
  const commitment = commitmentFor(root, arm);
  if (mode === "live" && !commitment) { out(`discover: the ${arm} prompt and tool hashes are not the last committed revision in evaluation/commitments/intelligence.json`); return 5; }
  let a4Order: ListedExperiment[] | undefined;
  if (arm === "a4") {
    const p = flag(argv, "a4-order") ?? join(root, "evaluation", "commitments", "a4.json");
    if (!existsSync(p)) { out(`discover: no committed A4 order at ${p}`); return 6; }
    const parsed = ListedOrder.parse(JSON.parse(readFileSync(p, "utf8")));
    a4Order = (Array.isArray(parsed) ? parsed : parsed.order) as ListedExperiment[];
  }
  const cycle = flag(argv, "cycle") === "2" ? 2 : 1;
  const outcomes = cycle === 2 ? readStream(storeRoot, STREAMS.outcomes).filter((e) => e.record_type === "outcome.case_run").map((e) => e.payload as OutcomeCase) : [];
  const provider = (flag(argv, "provider") ?? SETTINGS.provider) as ProviderId;
  const model = flag(argv, "model") ?? SETTINGS.model;
  const client = createModelClient({ storeRoot, mode, recordingsDir: flag(argv, "recordings") ?? INTELLIGENCE_RECORDINGS_DIR, mock: scriptedInvestigator(arm), budget: { ...env, runUsd: budgetUsd, runMaxCalls: maxCalls } });
  const session = new Session({
    storeRoot, runId, arm, cycle, pool: new DiscoveryPool(undefined, outcomes), insufficientEvidence: argv.includes("--insufficient-evidence"),
    ...(deps.validate ? { validate: deps.validate } : {}), ...(a4Order ? { a4Order } : {}),
    usage: () => { const u = client.runUsage(runId); return { ...u, max_calls: maxCalls, max_usd: budgetUsd }; }
  });
  try {
    const r = await runLoop({ client, session, maxCalls, budgetUsd, provider, model, commitment: commitment ?? { revision: null, hash: null } });
    out(`discover ${runId}: arm ${arm}, mode ${client.mode}, stop ${r.stop} (${r.detail}), ${r.calls} calls, $${r.usd.toFixed(4)}, ${session.hypotheses.size} hypotheses, ${session.experiments.size} experiments, ${session.proposals.size} proposals`);
    out(`next: npm run check:discovery -- ${runId}`);
    return 0;
  } finally {
    session.close();
    client.close();
  }
}

export function checkDiscoveryCommand(root: string, argv: readonly string[], out: (l: string) => void = (l) => console.log(l)): number {
  const runId = argv.find((a) => !a.startsWith("--"));
  if (!runId) { out("usage: check:discovery <run_id> [--store dir]"); return 2; }
  const r = checkDiscovery(flag(argv, "store") ?? join(root, ".hey-pisgah", "store"), runId);
  for (const l of r.lines) out(l);
  return r.pass ? 0 : 1;
}
