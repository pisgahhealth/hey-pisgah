import { describe, expect, it } from "vitest";
import { describeCase } from "../src/describe.js";
import { committed } from "./helpers.js";

const rows = committed();
const minute = (line: string) => { const m = /^D(\d) (\d\d):(\d\d)/.exec(line)!; return Number(m[1]) * 1440 + Number(m[2]) * 60 + Number(m[3]); };

describe("describe", () => {
  it("prints a journey ordered by the occurred clock, from history for discovery and from v1 otherwise", () => {
    for (const pool of ["discovery", "dev"]) {
      const r = rows.find((x) => x.pool === pool)!;
      const lines = describeCase(r.file.case_id);
      expect(lines[0]).toContain(pool === "discovery" ? "source history" : "source v1 on the definition executor");
      const times = lines.slice(1).map(minute);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(lines.some((l) => / st16 record_departure /.test(l))).toBe(true);
    }
  });
  it("prints no evaluator field for any committed case", () => {
    for (const r of rows) {
      const text = describeCase(r.file.case_id).join("\n");
      expect(text).not.toMatch(/\bF(?:[1-9]|1[0-2]|V)\b|should_apply|acceptable|canary|\bdp\d\d\b|\bT[1-6]\b/);
      expect(text.includes(r.manifest.canary)).toBe(false);
      expect(text.includes(r.manifest.seed)).toBe(false);
    }
  });
  it("answers an unknown id with the uniform error", () => {
    expect(() => describeCase("c-00000000")).toThrow("unknown_id");
  });
});
