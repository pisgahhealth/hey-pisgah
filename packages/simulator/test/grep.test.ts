import { DocumentId } from "@hey-pisgah/contracts";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(import.meta.dirname, "..", "src");
const files = readdirSync(src).filter((f) => f.endsWith(".ts")).map((f) => ({ f, text: readFileSync(join(src, f), "utf8") }));
const hits = (patterns: RegExp[]) => files.flatMap(({ f, text }) => patterns.filter((p) => p.test(text)).map((p) => `${f}: ${p.source}`));

describe("simulator source scans", () => {
  it("scans a non-empty source tree", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("names no hospital step, edge or document id", () => {
    const patterns = [/\bst\d\d/, /\be\d\d/, ...DocumentId.options.map((d) => new RegExp(`\\b${d}\\b`))];
    expect(hits(patterns)).toEqual([]);
  });

  it("reads no wall clock and no ambient randomness", () => {
    const banned = ["Math" + ".random", "Date" + ".now", "new " + "Date("].map((s) => new RegExp(s.replace(/[.(]/g, "\\$&")));
    expect(hits(banned)).toEqual([]);
  });
});
