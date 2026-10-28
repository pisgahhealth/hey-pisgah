import { readFileSync } from "node:fs";
import { WorkflowDefinition, definitionHash, fencesHash, permissionsHash, structureHash, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";

// Placeholder until the simulator exports its rules hash; recorded in the lane done file.
export const RULES_HASH_PENDING = "0".repeat(64);

export function loadV1(): WD {
  return WorkflowDefinition.parse(JSON.parse(readFileSync(new URL("./data/v1.json", import.meta.url), "utf8")));
}

// Recomputes every stored hash so a test can prove the file is stamped correctly.
export function stampHashes(def: WD): WD {
  const metadata = { ...def.metadata, fences_hash: fencesHash(def), permissions_hash: permissionsHash(def), structure_hash: structureHash(def) };
  const out = { ...def, metadata };
  return { ...out, definition_hash: definitionHash(out) };
}
