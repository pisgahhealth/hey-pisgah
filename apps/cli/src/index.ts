import { serveCommand } from "@hey-pisgah/agent";
import { describeCommand } from "@hey-pisgah/cases";
import { checkG, runValidationStream } from "@hey-pisgah/evaluator";
import { checkDiscoveryCommand, discoverCommand } from "@hey-pisgah/intelligence";
import { claimsCheck } from "./claims-check.js";
import { evalCommand } from "./eval.js";
import { videoScript } from "./video-script.js";
import { runProbe } from "./probe/index.js";
import { versionCommand } from "./version.js";

// Every command is registered here; a stubbed one exits 3 until its lane lands.
const root = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const command = process.argv[2] ?? "help";
const commands: Record<string, (() => void) | null> = {
  probe: () => { void runProbe(root, process.argv.slice(3)).then((code) => process.exit(code)); }, sim: null,
  discover: () => { void discoverCommand(root, process.argv.slice(3), { validate: async (store) => { await runValidationStream(store); } }).then((code) => process.exit(code)); }, eval: () => { void evalCommand(root, process.argv.slice(3)).then((code) => process.exit(code)); }, replay: null,
  serve: () => { void serveCommand(root, process.argv.slice(3)).then((code) => { if (code !== null) process.exit(code); }); },
  "claims:check": () => claimsCheck(root, claimsArgs(process.argv.slice(3))), describe: () => process.exit(describeCommand(process.argv.slice(3))), "video:script": () => process.exit(videoScript(root, process.argv.slice(3))), "check:discovery": () => process.exit(checkDiscoveryCommand(root, process.argv.slice(3))),
  "check:g": () => process.exit(checkG(process.argv.slice(3))),
  version: () => { void versionCommand(root, process.argv.slice(3)).then((code) => process.exit(code)); }
};
if (command === "help" || !(command in commands)) {
  console.log(`hey-pisgah <command>\n  ${Object.keys(commands).join("\n  ")}`);
  process.exit(command === "help" ? 0 : 2);
}
// claims:check --results <dir> reads result files under that root and writes its status file there.
function claimsArgs(argv: string[]): { resultsRoot?: string } {
  const i = argv.indexOf("--results");
  return i >= 0 && argv[i + 1] ? { resultsRoot: argv[i + 1]! } : {};
}
const run = commands[command];
if (!run) { console.log(`${command}: not implemented yet (see docs/ARCHITECTURE.md)`); process.exit(3); }
run();
