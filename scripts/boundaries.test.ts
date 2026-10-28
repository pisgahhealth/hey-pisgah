import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Import fences between packages; the evaluator holds reserved data and acceptance code, so the agent side may never import it.
const root = join(import.meta.dirname, "..");
const forbidden: Record<string, string[]> = {
  agent: ["evaluator", "cases/fixtures/reserved"],
  intelligence: ["evaluator", "cases/fixtures/reserved"],
  simulator: ["hospital", "cases", "evaluator", "agent", "intelligence"],
  contracts: ["store", "workflow", "simulator", "hospital", "cases", "model", "agent", "intelligence", "evaluator", "voice"]
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("package boundaries", () => {
  for (const [pkg, banned] of Object.entries(forbidden)) {
    it(`${pkg} imports none of ${banned.join(", ")}`, () => {
      const files = sources(join(root, "packages", pkg, "src"));
      const hits: string[] = [];
      for (const f of files) {
        const text = readFileSync(f, "utf8");
        for (const b of banned) {
          if (new RegExp(`from\\s+["'][^"']*(@hey-pisgah/${b}|packages/${b}|/${b}/)`).test(text)) hits.push(`${f} -> ${b}`);
        }
      }
      expect(hits).toEqual([]);
    });
  }
});
