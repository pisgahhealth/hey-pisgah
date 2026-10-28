// Package cases: the case generator, the committed pools and the describe view; reserved cases live behind the ./reserved entry only.
export const PACKAGE = "cases" as const;
export { generateCase, caseIdFor, type GenerateOptions } from "./generate.js";
export { drawer, type Drawer } from "./prng.js";
export { SEED_RULE, seedFor, POOL_SPECS, FR4_SUBSET, type CaseSpec } from "./pools.js";
export { loadPool, findCase, loadSubsets, COMMITTED_POOLS, FIXTURES_ROOT, type CommittedPool } from "./load.js";
export { describeCase, describeCommand } from "./describe.js";
export * from "./types.js";
