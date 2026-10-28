import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, hashJson } from "@hey-pisgah/contracts";
import { scheduleHash } from "@hey-pisgah/simulator";
import { generateCase } from "./generate.js";
import { historyFor } from "./history.js";
import { FIXTURES_ROOT } from "./load.js";
import { FR4_SUBSET, POOL_DIR, POOL_SPECS, SEED_RULE, seedFor } from "./pools.js";
import { CaseFile, type GeneratedCase, type Manifest, type Pool } from "./types.js";

export const EVALUATOR_DATA = new URL("../../evaluator/data/", import.meta.url).pathname;
type PoolName = keyof typeof POOL_SPECS;

// Every committed pool, generated from the seed rule; discovery cases also carry their history.
export function buildPools(): Record<PoolName, { gen: GeneratedCase; file: CaseFile }[]> {
  const out = {} as Record<PoolName, { gen: GeneratedCase; file: CaseFile }[]>;
  for (const pool of Object.keys(POOL_SPECS) as PoolName[]) {
    out[pool] = POOL_SPECS[pool].map((spec, i) => {
      const gen = generateCase(spec.family, seedFor(pool as Pool, i), spec.ward, spec.payer, {
        pool: pool as Pool, ...(spec.overlays ? { overlays: spec.overlays } : {}), ...(spec.infra_fault ? { infra_fault: spec.infra_fault } : {})
      });
      const file = CaseFile.parse({
        case_id: gen.manifest.case_id, schedule_hash: scheduleHash(gen.schedule), schedule: gen.schedule, initial_state: gen.initial_state,
        infra_fault: gen.infra_fault, history: pool === "discovery" ? historyFor(gen.schedule) : null
      });
      return { gen, file };
    });
  }
  return out;
}

const pretty = (v: unknown): string => `${JSON.stringify(JSON.parse(canonical(v)), null, 1)}\n`;

// Writes fixtures, manifests and the subset list; manifests go only under the evaluator's data folder.
export function writePools(): void {
  const pools = buildPools();
  for (const dir of new Set(Object.values(POOL_DIR))) rmSync(join(FIXTURES_ROOT, dir), { recursive: true, force: true });
  mkdirSync(join(EVALUATOR_DATA, "manifests"), { recursive: true });
  for (const [pool, cases] of Object.entries(pools) as [PoolName, { gen: GeneratedCase; file: CaseFile }[]][]) {
    const dir = join(FIXTURES_ROOT, POOL_DIR[pool]);
    mkdirSync(dir, { recursive: true });
    for (const { file } of cases) writeFileSync(join(dir, `${file.case_id}.json`), pretty(file));
    const manifests: Manifest[] = cases.map((x) => x.gen.manifest);
    writeFileSync(join(EVALUATOR_DATA, "manifests", `${pool}.json`), pretty(manifests));
  }
  const ids = (p: PoolName) => pools[p].map((x) => x.file.case_id);
  writeFileSync(join(FIXTURES_ROOT, "subsets.json"), pretty({
    pools: Object.fromEntries((Object.keys(pools) as PoolName[]).map((p) => [p, ids(p)])),
    demo: { step5: ids("demo")[0], step6: ids("demo")[1] },
    fr4: { dev: FR4_SUBSET.dev.map((i) => ids("dev")[i]), demo: FR4_SUBSET.demo.map((i) => ids("demo")[i]) },
    infra_fault: pools.dev.filter((x) => x.file.infra_fault !== null).map((x) => x.file.case_id)
  }));
  writeFileSync(join(EVALUATOR_DATA, "seed-rule.json"), pretty({
    rule: `seed(pool, i) = sha256("${SEED_RULE}|" + pool + "|" + i); case_id = "c-" + first 8 hex of sha256("case|" + seed)`,
    pools: Object.fromEntries((Object.keys(POOL_SPECS) as PoolName[]).map((p) => [p, POOL_SPECS[p].map((s, i) => ({ index: i, ...s }))])),
    reserved: "seeds for reserved and spare follow the same rule under the pool names reserved and spare; only their list hash is committed in reserved.sha256",
    pools_hash: hashJson(Object.fromEntries((Object.keys(pools) as PoolName[]).map((p) => [p, pools[p].map((x) => x.file.schedule_hash)])))
  }));
}

if (process.argv[1]?.endsWith("build.ts")) writePools();
