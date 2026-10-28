import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// This file holds the list, so the scan skips it; every other file in the package must be clean.
const root = join(import.meta.dirname, "..");
const self = join(import.meta.dirname, "deny-list.test.ts");
const words = [
  /before[\s_-]*sign[\s_-]*off/i, /\bearlier\b/i, /\bin[\s_-]+advance\b/i, /\bparallel\b/i, /\bdraft[\s_-]+first\b/i, /early[\s_-]*summary/i,
  /pre[\s_-]*signoff/i, /prep[\s_-]*in[\s_-]*advance/i, /reasoning[\s_-]+strength/i, /\bbottleneck/i, /\bdelay[\s_-]+cause/i, /\broot[\s_-]+cause/i,
  /\bfix(es|ed|ing)?\b/i, /\bimprovement/i, /\bF(?:[1-9]|1[0-2]|V)\b/
];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p !== self) out.push(p);
  }
  return out;
}

describe("deny list", () => {
  it("finds no denied term in any package file", () => {
    const hits: string[] = [];
    for (const f of files(root)) {
      const text = readFileSync(f, "utf8");
      for (const w of words) if (w.test(text)) hits.push(`${f.slice(root.length)}: ${w.source}`);
    }
    expect(hits).toEqual([]);
  });
  it("would catch a planted term", () => {
    expect(words.some((w) => w.test("prepare it before sign-off"))).toBe(true);
    expect(words.some((w) => w.test("case family F1"))).toBe(true);
  });
});
