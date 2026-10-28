import { writeFileSync } from "node:fs";
import { caseFacts } from "@hey-pisgah/agent";
import { OBSERVED_ABOUT, exportJourneyRun, journeyRunDirs, type ObservedFile } from "./evidence.js";
import { loadProfile } from "./profile.js";

// Exports journey runs as observed evidence cases: evidence.run.ts --out <file> <runs folder>...
const argv = process.argv.slice(2);
const at = argv.indexOf("--out");
const out = at >= 0 ? argv[at + 1] : undefined;
const roots = argv.filter((a, i) => !a.startsWith("--") && i !== at + 1);
if (!out || !roots.length) { process.stderr.write("usage: evidence.run.ts --out <file> <runs folder>...\n"); process.exit(2); }
const spec = loadProfile().versions ?? null;
if (!spec) { process.stderr.write("the profile has no versions block, so the case facts are unknown\n"); process.exit(2); }
const facts = caseFacts(spec) as Record<string, string | string[]>;
const cases = roots.flatMap((r) => journeyRunDirs(r)).map((d) => exportJourneyRun(d, spec, facts));
const file: ObservedFile = { schema: "hey-pisgah/observed-cases/1", about: OBSERVED_ABOUT, exported_at: new Date().toISOString(), cases };
writeFileSync(out, `${JSON.stringify(file, null, 1)}\n`);
process.stdout.write(`${cases.length} observed cases, ${cases.reduce((n, c) => n + c.events.length, 0)} events -> ${out}\n`);
