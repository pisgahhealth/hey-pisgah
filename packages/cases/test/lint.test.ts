import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Only the evaluator may import its data folder or anything named reserved; every other package and app is scanned.
const root = join(import.meta.dirname, "..", "..", "..");
const BANNED = /(?:from\s+|import\s*\(\s*|require(?:\.resolve)?\s*\(\s*)["'][^"']*(?:evaluator\/data|reserved)[^"']*["']/;
// Any path to the evaluator's data folder; only the two generator writers may name it, and they never read from it.
const DATA_PATH = /evaluator\/data|["']evaluator["']\s*,\s*["']data["']/;
const WRITERS = ["/packages/cases/src/build.ts", "/packages/cases/src/reserved.ts"];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
export function offenders(): string[] {
  const out: string[] = [];
  for (const area of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(root, area))) {
      if (area === "packages" && pkg === "evaluator") continue;
      const src = join(root, area, pkg, "src");
      try { statSync(src); } catch { continue; }
      for (const f of sources(src)) {
        const text = readFileSync(f, "utf8");
        const rel = f.slice(root.length);
        if (BANNED.test(text) || (DATA_PATH.test(text) && !WRITERS.includes(rel))) out.push(rel);
      }
    }
  }
  return out;
}

describe("reserved and evaluator data imports", () => {
  it("no package or app other than the evaluator imports evaluator data or anything named reserved", () => {
    expect(offenders()).toEqual([]);
  });
  it("would catch a planted import", () => {
    expect(BANNED.test(`import { generateReserved } from "@hey-pisgah/cases/reserved";`)).toBe(true);
    expect(BANNED.test(`const m = JSON.parse(readFileSync(require.resolve("../../evaluator/data/manifests/dev.json")));`)).toBe(true);
    expect(BANNED.test(`import x from "../../packages/evaluator/data/x.json";`)).toBe(true);
    expect(BANNED.test(`import { loadPool } from "@hey-pisgah/cases";`)).toBe(false);
  });
  it("would catch a path string to the data folder, and the build writer never reads", () => {
    expect(DATA_PATH.test(`join(root, "packages", "evaluator", "data", "manifests")`)).toBe(true);
    expect(DATA_PATH.test(`new URL("../../evaluator/data/", import.meta.url)`)).toBe(true);
    const build = join(root, WRITERS[0]!);
    if (existsSync(build)) expect(readFileSync(build, "utf8")).not.toMatch(/readFileSync|readdirSync/);
  });
});
