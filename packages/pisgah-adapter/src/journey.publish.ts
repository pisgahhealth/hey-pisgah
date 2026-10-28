import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTalk, loadJourney } from "@hey-pisgah/evaluator";
import { listStreams, readStream } from "@hey-pisgah/store";
import { existsSync } from "node:fs";
import { publicText, publicVersion, type JourneyVersion } from "./journey.sandbox.js";
import { loadProfile } from "./profile.js";
import { SandboxBlock } from "./sandbox.js";

// Publishes a kept run: its results with no ids, and the gate's clauses per line read back from the run's task streams.
const [dir, resultsFile, recordedFile, versionFile] = process.argv.slice(2);
if (!dir || !resultsFile || !recordedFile) { console.log("usage: journey.publish.ts <run dir> <results file> <recorded gate file> [<version file>]"); process.exit(1); }
const script = loadJourney();
const scrub = SandboxBlock.parse(loadProfile().sandbox).scrub;
const says = new Set(script.steps.filter(isTalk).map((t) => t.say));
const root = join(dir, "store");
const byText: Record<string, Record<string, unknown>[]> = {};
for (const sid of listStreams(root, "emr")) {
  const recs = readStream(root, sid);
  const text = new Map(recs.filter((e) => e.record_type === "utterance.heard").map((e) => [String((e.payload as Record<string, unknown>)["line_id"]), String((e.payload as Record<string, unknown>)["text"])]));
  for (const e of recs.filter((x) => x.record_type === "gate.decided")) {
    const p = e.payload as { line_id: string; clauses: Record<string, unknown>[]; outside_line?: Record<string, unknown>[] };
    const said = text.get(p.line_id);
    if (said && says.has(said)) byText[said] = [...p.clauses, ...(p.outside_line ?? [])].map((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null && v !== undefined)));
  }
}
const results = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as { journey_id: string; mode: string };
writeFileSync(resultsFile, `${JSON.stringify(publicText(results, scrub), null, 1)}\n`);
writeFileSync(recordedFile, `${JSON.stringify(publicText({ schema: "hey-pisgah/journey-gate/1", journey_id: results.journey_id, mode: results.mode, by_text: byText }, scrub), null, 1)}\n`);
if (versionFile && existsSync(join(dir, "version.json"))) writeFileSync(versionFile, `${JSON.stringify(publicText(publicVersion(JSON.parse(readFileSync(join(dir, "version.json"), "utf8")) as JourneyVersion, results as { measured_at: string; mode: string; journey_id: string }), scrub), null, 1)}\n`);
console.log(`${Object.keys(byText).length} lines recorded`);
