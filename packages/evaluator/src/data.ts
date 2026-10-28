import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Manifest } from "@hey-pisgah/cases";

// The evaluator's own data folder; no other package may name it.
export const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));
export const ACCEPTANCE_DIR = fileURLToPath(new URL("../acceptance/", import.meta.url));
export const RESERVED_HASH_FILE = `${DATA_DIR}reserved.sha256`;

export const MANIFEST_POOLS = ["discovery", "dev", "dev_held", "variation", "demo"] as const;
export type ManifestPool = (typeof MANIFEST_POOLS)[number];

// Reads one pool's manifests, keyed by case id.
export function loadManifests(pool: ManifestPool): Map<string, Manifest> {
  const rows = z.array(Manifest).parse(JSON.parse(readFileSync(`${DATA_DIR}manifests/${pool}.json`, "utf8")));
  return new Map(rows.map((m) => [m.case_id, m]));
}
