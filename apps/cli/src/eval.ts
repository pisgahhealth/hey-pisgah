import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ReservedRunRefused, evaluateDev, evaluateReserved, loadProposalInput, reservedRunRefusal, type AgentRunData, type DiscoveryInput, type ProposalInput } from "@hey-pisgah/evaluator";
import { agentRunData, defaultWorld, replayWorld, runAgentOnce } from "./agent-runs.js";

const all = (argv: string[], name: string) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]!] : []));
const one = (argv: string[], name: string) => all(argv, name)[0];
export const FIXTURE_INPUT = new URL("../../../packages/evaluator/fixtures/proposals/learned-pair.json", import.meta.url).pathname;

// eval --set dev|all|reserved: the reserved set refuses before anything else; dev and all make no model call.
export async function evalCommand(root: string, argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const set = one(argv, "set");
  if (set !== "dev" && set !== "all" && set !== "reserved") { console.log("eval --set dev|all|reserved [--input f] [--discovery f] [--agent-store d] [--agent-replay name] [--mock] [--out d] [--sweep-limit n] [--fuzz n]"); return 2; }
  if (set === "reserved") {
    const refused = reservedRunRefusal(root, env);
    if (refused) { console.log(`eval --set reserved refused: ${refused.reason}`); return 4; }
  }
  const mock = argv.includes("--mock");
  const inputsDir = join(root, "evaluation", "inputs");
  const files = [...all(argv, "input"), ...(mock ? [FIXTURE_INPUT] : []), ...(!mock && existsSync(inputsDir) ? readdirSync(inputsDir).filter((f) => f.endsWith(".json")).sort().map((f) => join(inputsDir, f)) : [])];
  const inputs: ProposalInput[] = files.map(loadProposalInput);
  const discoveryFile = one(argv, "discovery");
  const discovery = discoveryFile ? (JSON.parse(readFileSync(discoveryFile, "utf8")) as DiscoveryInput) : null;
  const runsDir = join(root, ".hey-pisgah", "runs", mock ? "eval-mock" : "eval");
  const agentRuns: AgentRunData[] = [];
  for (const d of all(argv, "agent-store")) agentRuns.push(agentRunData(d, d, "live", defaultWorld()));
  const replays = [...all(argv, "agent-replay"), ...(mock ? ["live-v1-2026-10-28"] : [])];
  for (const name of [...new Set(replays)]) {
    const dir = join(runsDir, `replay-${name}`);
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    await runAgentOnce(dir, "replay", replayWorld(name));
    agentRuns.push(agentRunData(dir, `replay ${name}`, "replay", replayWorld(name)));
  }
  if (mock) {
    const dir = join(runsDir, "mock-agent");
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    await runAgentOnce(dir, "mock", defaultWorld());
    agentRuns.push(agentRunData(dir, "scripted mock agent", "mock", defaultWorld()));
  }
  const out = one(argv, "out") ?? (mock ? join(runsDir, "evaluation", "results") : undefined);
  const limit = one(argv, "sweep-limit");
  const fuzzN = one(argv, "fuzz");
  const log = (l: string) => process.stderr.write(`eval: ${l}\n`);
  if (set === "reserved") {
    try {
      const commit = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
      const run = await evaluateReserved({ root, set, inputs, discovery, agentRuns, commit, env, log });
      console.log(`reserved run ${String(run["run_id"])} on ${(run["case_list"] as string[]).length} cases; commit and push evaluation/reserved/RUN.json and the tables now`);
      return 0;
    } catch (e) {
      if (e instanceof ReservedRunRefused) { console.log(`eval --set reserved refused: ${e.reason}`); return 4; }
      throw e;
    }
  }
  const t = await evaluateDev({ root, set, inputs, discovery, agentRuns, log, ...(out ? { outDir: out } : {}), ...(limit ? { sweepLimit: Number(limit) } : {}), ...(fuzzN ? { fuzzN: Number(fuzzN) } : {}) });
  console.log(`eval --set ${set} (${String(t["mode"])}): ${String(t["cases"])} cases -> ${out ?? "evaluation/results"}`);
  return 0;
}
