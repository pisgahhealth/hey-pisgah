import { hashJson } from "@hey-pisgah/contracts";
import { applyOperations } from "@hey-pisgah/workflow";
import { fixtureDefinition } from "../../workflow/test/fixture.js";
import { eventLogHash, runDefinition } from "../src/index.js";
import { fixtureSchedule } from "./schedule-fixture.js";

// Prints the determinism hashes for one seed so a fresh process can be compared with the parent.
export function hashesFor(seed: number): { control: string; intervention: string; result: string } {
  const def = fixtureDefinition();
  const s = fixtureSchedule(seed, { amendAt: 560, takeHome: true });
  const a = applyOperations(def, [{ op: "remove_soft_edge", edge_id: "e04" }]);
  if (!a.ok) throw new Error("fixture op refused");
  const c = runDefinition(def, s), i = runDefinition(a.definition, s);
  if (c.outcome !== "ok" || i.outcome !== "ok") throw new Error("fixture run aborted");
  return { control: eventLogHash(c.events), intervention: eventLogHash(i.events), result: hashJson(c) };
}

if (process.argv[1]?.endsWith("determinism-child.ts")) process.stdout.write(JSON.stringify(hashesFor(Number(process.argv[2]))));
