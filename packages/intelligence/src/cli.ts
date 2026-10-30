import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Operation } from "@hey-pisgah/contracts";
import { budgetFromEnv, createModelClient, type Mode, type ProviderId } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { z } from "zod";
import { checkDiscovery } from "./check.js";
import { commitmentFor } from "./commitments.js";
import { runCycleLoop } from "./cycle.js";
import { SETTINGS, runLoop } from "./loop.js";
import { scriptedInvestigator } from "./mock.js";
import { DiscoveryPool, loadObserved, type OutcomeCase } from "./pool.js";
import { reverseOutcomes } from "./outcomes.js";
import { loadV1 } from "@hey-pisgah/hospital";
import { ARMS } from "./prompts.js";
import { STREAMS, Session, type Arm, type ListedExperiment } from "./session.js";
import { VARIANTS, loadVariant, type ValidationCase, type VariantId } from "./variants.js";
import type { WorkflowDefinition } from "@hey-pisgah/contracts";
import type { Facts } from "@hey-pisgah/workflow";

export const INTELLIGENCE_RECORDINGS_DIR = new URL("../fixtures/recordings", import.meta.url).pathname;
const flag = (argv: readonly string[], name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const ListedOrder = z.union([z.array(z.strictObject({ ops: z.array(Operation).min(1).max(3), case_ids: z.array(z.string()).min(1).max(6) })), z.object({ order: z.array(z.object({ ops: z.array(Operation).min(1).max(3), case_ids: z.array(z.string()).min(1).max(6) })) })]);

export type VariantValidation = { base: WorkflowDefinition; cases: ValidationCase[]; caseFacts: Facts[] };
export type DiscoverDeps = { validate?: (storeRoot: string, variant?: VariantValidation) => Promise<void>; out?: (line: string) => void; mode?: Mode };

// discover --arm adaptive|a3|a4|prior [--effort medium|high] [--variant single|pair|triple] --budget-usd N --max-calls M [--run-id run-xxxxxxxx] [--store dir] [--a4-order file] [--cycle 2 [--outcomes file] [--observed file] [--reverse-outcomes]] [--insufficient-evidence]
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
  const effort = flag(argv, "effort") as "medium" | "high" | undefined;
  if (arm === "adaptive" && (!effort || !(SETTINGS.adaptive_efforts as readonly string[]).includes(effort))) { out(`discover: the adaptive arm needs --effort ${SETTINGS.adaptive_efforts.join(" or ")}`); return 2; }
  const variantId = flag(argv, "variant") as VariantId | undefined;
  if (variantId && (!VARIANTS.includes(variantId) || arm !== "adaptive")) { out(`discover: --variant takes ${VARIANTS.join(", ")} on the adaptive arm`); return 2; }
  const variant = variantId && variantId !== "pair" ? loadVariant(variantId) : null;
  const cycle = flag(argv, "cycle") === "2" ? 2 : 1;
  const outcomes = cycle === 2 ? [...readStream(storeRoot, STREAMS.outcomes).filter((e) => e.record_type === "outcome.case_run").map((e) => e.payload as OutcomeCase), ...(flag(argv, "outcomes") ? loadObserved(flag(argv, "outcomes")!) : [])] : [];
  // --reverse-outcomes keeps the histories and turns each outcome's result around, the counter-evidence test the second cycle must answer.
  const given = argv.includes("--reverse-outcomes") ? reverseOutcomes(outcomes, new DiscoveryPool(), loadV1()) : outcomes;
  const observedFile = flag(argv, "observed") ?? join(root, "evaluation", "results", "observed-cases.json");
  const observed = cycle === 2 && existsSync(observedFile) ? loadObserved(observedFile) : [];
  const provider = (flag(argv, "provider") ?? SETTINGS.provider) as ProviderId;
  const model = flag(argv, "model") ?? SETTINGS.model;
  const client = createModelClient({ storeRoot, mode, recordingsDir: flag(argv, "recordings") ?? INTELLIGENCE_RECORDINGS_DIR, mock: scriptedInvestigator(arm), timeoutMs: 300_000, budget: { ...env, runUsd: budgetUsd, runMaxCalls: maxCalls } });
  const vv: VariantValidation | undefined = variant ? { base: variant.base, cases: variant.validation!, caseFacts: variant.pool.caseFacts() } : undefined;
  const session = new Session({
    storeRoot, runId, arm, cycle, pool: variant ? variant.pool : new DiscoveryPool(undefined, given, observed), ...(variant ? { base: variant.base } : {}), insufficientEvidence: argv.includes("--insufficient-evidence") || cycle === 2,
    ...(deps.validate ? { validate: (root: string) => deps.validate!(root, vv) } : {}), ...(a4Order ? { a4Order } : {}),
    usage: () => { const u = client.runUsage(runId); return { ...u, max_calls: maxCalls, max_usd: budgetUsd }; }
  });
  try {
    const common = { client, session, maxCalls, budgetUsd, provider, model, commitment: commitment ?? { revision: null, hash: null } };
    if (variantId) session.log("variant.selected", { variant: variantId, base_hash: session.base.definition_hash, pool: session.pool.ids() });
    const r = arm === "adaptive" ? await runCycleLoop({ ...common, effort: effort! }) : await runLoop(common);
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
