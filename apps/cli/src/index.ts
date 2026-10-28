// Every command is stubbed here until its lane lands, so scripts resolve from day one.
const command = process.argv[2] ?? "help";
const commands = ["probe", "sim", "discover", "eval", "replay", "serve", "claims:check", "video:script", "check:discovery"];
if (command === "help" || !commands.includes(command)) {
  console.log(`hey-pisgah <command>\n  ${commands.join("\n  ")}`);
  process.exit(command === "help" ? 0 : 2);
}
console.log(`${command}: not implemented yet (see docs/ARCHITECTURE.md)`);
process.exit(3);
