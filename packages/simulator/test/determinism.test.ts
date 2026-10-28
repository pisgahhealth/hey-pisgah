import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashesFor } from "./determinism-child.js";

const root = join(import.meta.dirname, "..", "..", "..");
const child = join(import.meta.dirname, "determinism-child.ts");
function fresh(seed: number, env: Record<string, string>): ReturnType<typeof hashesFor> {
  const r = spawnSync(process.execPath, ["--import", "tsx", child, String(seed)], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr.slice(0, 500));
  return JSON.parse(r.stdout) as ReturnType<typeof hashesFor>;
}

describe("determinism", () => {
  it("the same seed twice gives identical hashes in one process", () => {
    const a = hashesFor(7), b = hashesFor(7);
    expect(a).toEqual(b);
    expect(a.control).not.toBe(a.intervention);
    expect(hashesFor(8).control).not.toBe(a.control);
  });

  it("a fresh process under UTC and under Africa/Lagos with different locales gives the same hashes", () => {
    const here = hashesFor(7);
    expect(fresh(7, { TZ: "UTC", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" })).toEqual(here);
    expect(fresh(7, { TZ: "Africa/Lagos", LANG: "tr_TR.UTF-8", LC_ALL: "tr_TR.UTF-8" })).toEqual(here);
  });
});
