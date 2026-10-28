import { generateCase } from "../src/generate.js";
import { POOL_SPECS, seedFor } from "../src/pools.js";
import { scheduleHash } from "@hey-pisgah/simulator";
import type { Pool } from "../src/types.js";

// Prints every committed pool's schedule hashes, regenerated from the seed rule, so a fresh process can be compared.
export function poolHashes(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(POOL_SPECS).map(([pool, specs]) => [pool, specs.map((s, i) =>
    scheduleHash(generateCase(s.family, seedFor(pool as Pool, i), s.ward, s.payer, { pool: pool as Pool, ...(s.overlays ? { overlays: s.overlays } : {}), ...(s.infra_fault ? { infra_fault: s.infra_fault } : {}) }).schedule))]));
}

if (process.argv[1]?.endsWith("g6-child.ts")) process.stdout.write(JSON.stringify(poolHashes()));
