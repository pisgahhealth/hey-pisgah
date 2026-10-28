import { serveCommand } from "@hey-pisgah/agent";
import { describeCommand } from "@hey-pisgah/cases";
import { checkG, reservedRunRefusal, runValidationStream } from "@hey-pisgah/evaluator";
import { checkDiscoveryCommand, discoverCommand } from "@hey-pisgah/intelligence";
import { claimsCheck } from "./claims-check.js";
import { runProbe } from "./probe/index.js";

// Every command is registered here; a stubbed one exits 3 until its lane lands.
const root = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const command = process.argv[2] ?? "help";
const commands: Record<string, (() => void) | null> = {
  probe: () => { void runProbe(root, process.argv.slice(3)).then((code) => process.exit(code)); }, sim: null,
  discover: () => { void discoverCommand(root, process.argv.slice(3), { validate: async (store) => { await runValidationStream(store); } }).then((code) => process.exit(code)); }, eval: () => process.exit(evalCommand(process.argv.slice(3))), replay: null,
  serve: () => { void serveCommand(root, process.argv.slice(3)).then((code) => { if (code !== null) process.exit(code); }); },
  "claims:check": () => claimsCheck(root), describe: () => process.exit(describeCommand(process.argv.slice(3))), "video:script": null, "check:discovery": () => process.exit(checkDiscoveryCommand(root, process.argv.slice(3))),
  "check:g": () => process.exit(checkG(process.argv.slice(3)))
};
if (command === "help" || !(command in commands)) {
  console.log(`hey-pisgah <command>\n  ${Object.keys(commands).join("\n  ")}`);
  process.exit(command === "help" ? 0 : 2);
}
// The reserved set refuses before anything else; the arms themselves land with the evaluator's second part.
function evalCommand(argv: string[]): number {
  const set = argv[argv.indexOf("--set") + 1];
  if (argv.includes("--set") && set === "reserved") {
    const refused = reservedRunRefusal(root);
    if (refused) { console.log(`eval --set reserved refused: ${refused.reason}`); return 4; }
  }
  console.log(`eval --set ${set ?? "?"}: not implemented yet (see docs/ARCHITECTURE.md)`);
  return 3;
}
const run = commands[command];
if (!run) { console.log(`${command}: not implemented yet (see docs/ARCHITECTURE.md)`); process.exit(3); }
run();
