import { join } from "node:path";
import { sameJourney } from "@hey-pisgah/evaluator";
import { replayJourney } from "./journey-fake.js";
import { keyedGate } from "./journey.js";
import { runSandboxJourney, writeJourneyFiles } from "./journey.sandbox.js";

// Runs the journey on the sandbox once: --mode mock plays the script's keyed gate, --mode live calls the model; --results and --record publish the run.
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] ?? null : null; };
async function main(): Promise<void> {
  const mode = arg("mode") === "live" ? "live" : "mock";
  const out = arg("out");
  if (!out) throw new Error("usage: journey.run.ts --mode mock|live --out <private dir> [--results <file>] [--record <file>] [--versions <version log> --version-results <file>]");
  const r = await runSandboxJourney({
    mode, port: Number(process.env["HEY_PISGAH_EMR_PORT"] ?? 4102), storeRoot: join(out, "store"), recordingsDir: join(out, "recordings"),
    holdMs: Number(process.env["HEY_PISGAH_HOLD_MS"] ?? 4000), watchMs: Number(process.env["HEY_PISGAH_WATCH_MS"] ?? 3000), log: (s) => process.stderr.write(`${s}\n`),
    ...(arg("versions") ? { versionLog: arg("versions")! } : {})
  });
  // The recorded gate answers are played again over the in-memory hospital; the run counts as replayed only when the two agree.
  const replay = await replayJourney(keyedGate(r.recorded));
  r.results.replay_same = sameJourney(r.results, replay.results);
  writeJourneyFiles(r, out, arg("results"), arg("record"), r.scrub, arg("version-results"));
  const x = r.results;
  process.stdout.write(`${x.steps_passed}/${x.steps} steps, FR-1 ${x.fr1_appropriate}/${x.fr1_points}, prohibited ${x.prohibited_attempts}, calls while paused ${x.calls_while_paused}, ${x.calls} calls $${x.cost_usd}, replay same ${x.replay_same}\n`);
  if (r.version) process.stdout.write(`version ${r.version.version}: offers made ${r.version.offers_made}, blocked ${r.version.offers_blocked}; ${r.version.lines.join(" ") || "no line"}\n`);
}
main().catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });
