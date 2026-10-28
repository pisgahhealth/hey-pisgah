import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSubsets } from "../src/load.js";
import { committed } from "./helpers.js";
import { poolHashes } from "./g6-child.js";

const root = join(import.meta.dirname, "..", "..", "..");
const child = join(import.meta.dirname, "g6-child.ts");
const fresh = (env: Record<string, string>) => {
  const r = spawnSync(process.execPath, ["--import", "tsx", child], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr.slice(0, 500));
  return JSON.parse(r.stdout) as Record<string, string[]>;
};

describe("G6: schedule hashes are stable across processes", () => {
  it("regenerated hashes match the committed fixtures, here and in fresh processes under two time zones and locales", () => {
    const here = poolHashes();
    const byId = new Map(committed().map((r) => [r.file.case_id, r.file.schedule_hash]));
    const ids = loadSubsets().pools;
    for (const [pool, hashes] of Object.entries(here)) expect(hashes).toEqual(ids[pool]!.map((id) => byId.get(id)));
    expect(fresh({ TZ: "UTC", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" })).toEqual(here);
    expect(fresh({ TZ: "Africa/Lagos", LANG: "tr_TR.UTF-8", LC_ALL: "tr_TR.UTF-8" })).toEqual(here);
  });
});
