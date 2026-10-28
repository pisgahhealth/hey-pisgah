import { claimsCheck } from "./claims-check.js";
import { runProbe } from "./probe/index.js";

// Every command is registered here; a stubbed one exits 3 until its lane lands.
const root = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const command = process.argv[2] ?? "help";
const commands: Record<string, (() => void) | null> = {
  probe: () => { void runProbe(root, process.argv.slice(3)).then((code) => process.exit(code)); }, sim: null, discover: null, eval: null, replay: null, serve: null,
  "claims:check": () => claimsCheck(root), "video:script": null, "check:discovery": null
};
if (command === "help" || !(command in commands)) {
  console.log(`hey-pisgah <command>\n  ${Object.keys(commands).join("\n  ")}`);
  process.exit(command === "help" ? 0 : 2);
}
const run = commands[command];
if (!run) { console.log(`${command}: not implemented yet (see docs/ARCHITECTURE.md)`); process.exit(3); }
run();
