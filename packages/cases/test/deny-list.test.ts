import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DENY, GENERATOR_VOCAB, strings } from "../src/checks.js";
import { FIXTURES_ROOT } from "../src/load.js";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p]; });
}
const scan = (value: unknown, where: string, words: readonly RegExp[]) =>
  strings(value).flatMap((s) => words.filter((w) => w.test(s)).map((w) => `${where}: ${w.source} in "${s.slice(0, 50)}"`));

describe("deny list over fixture strings", () => {
  it("finds no denied term or generator vocabulary in any committed fixture string or key", () => {
    const hits = files(FIXTURES_ROOT).flatMap((f) => scan(JSON.parse(readFileSync(f, "utf8")), f.slice(FIXTURES_ROOT.length), [...DENY, ...GENERATOR_VOCAB]));
    expect(hits).toEqual([]);
  });
  it("finds no denied term in the evaluator's manifests apart from the family field itself", () => {
    const dir = join(import.meta.dirname, "..", "..", "evaluator", "data", "manifests");
    const hits = readdirSync(dir).flatMap((f) => {
      const ms = (JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>[]).map(({ family: _f, overlays: _o, ...rest }) => rest);
      return scan(ms, f, DENY);
    });
    expect(hits).toEqual([]);
  });
  it("would catch a planted term", () => {
    expect(scan({ note: "draft it before sign-off" }, "x", DENY)).toHaveLength(1);
    expect(scan({ k: ["case F7"] }, "x", DENY)).toHaveLength(1);
    expect(scan({ manifest_hint: "x" }, "x", GENERATOR_VOCAB).length).toBeGreaterThan(0);
  });
});
