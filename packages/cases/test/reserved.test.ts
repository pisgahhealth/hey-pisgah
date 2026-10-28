import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CaseId, canonical } from "@hey-pisgah/contracts";
import { RESERVED_CANARIES, ReservedSealBroken, generateReserved, seedList, seedListHash } from "../src/reserved.js";
import { DEV_NAMES } from "../src/text.js";
import { caseIdFor } from "../src/generate.js";
import { committed, DATA } from "./helpers.js";

const hashFile = join(DATA, "reserved.sha256");

describe("reserved seeds", () => {
  it("commit 25 reserved and 10 spare entries whose list hash is the committed file", () => {
    const list = seedList();
    expect([list.filter((e) => e.set === "reserved").length, list.filter((e) => e.set === "spare").length]).toEqual([25, 10]);
    expect(readFileSync(hashFile, "utf8").trim()).toBe(seedListHash());
    const fam = (f: string) => list.filter((e) => e.set === "reserved" && e.family === f).length;
    expect(["F1", "F2", "F3", "F4", "F5", "F6", "F8", "F9", "F10", "FV"].map(fam)).toEqual([4, 3, 3, 2, 2, 2, 2, 2, 2, 3]);
    expect(list.filter((e) => e.set === "reserved" && e.overlays?.includes("F11")).length).toBe(2);
    expect(list.filter((e) => e.set === "reserved" && e.overlays?.includes("F12")).length).toBe(1);
  });
  it("refuse to generate when the hash file does not match", () => {
    const dir = mkdtempSync(join(tmpdir(), "seal-"));
    const bad = join(dir, "reserved.sha256");
    writeFileSync(bad, `${"0".repeat(64)}\n`);
    expect(() => generateReserved(bad)).toThrow(ReservedSealBroken);
  });
  it("use one id shape with dev, and canary surnames that no committed case contains", () => {
    const list = seedList();
    for (const e of list) expect(CaseId.safeParse(caseIdFor(e.seed)).success).toBe(true);
    expect(new Set(list.map((e) => e.canary)).size).toBe(list.length);
    const devWords = new Set([...DEV_NAMES.family, ...DEV_NAMES.given_female, ...DEV_NAMES.given_male]);
    for (const c of RESERVED_CANARIES) expect(devWords.has(c)).toBe(false);
    const text = committed().map((r) => canonical(r.file)).join("\n");
    for (const c of RESERVED_CANARIES) expect(text.includes(c)).toBe(false);
    const ids = new Set(committed().map((r) => r.file.case_id));
    for (const e of list) expect(ids.has(caseIdFor(e.seed))).toBe(false);
  });
  it("stay out of the main entry", () => {
    const index = readFileSync(join(import.meta.dirname, "..", "src", "index.ts"), "utf8").replace(/^\/\/.*$/gm, "");
    expect(/reserved|checks|history|build/.test(index)).toBe(false);
  });
});
