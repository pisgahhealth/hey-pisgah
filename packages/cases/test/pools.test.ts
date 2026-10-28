import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CaseId, canonical } from "@hey-pisgah/contracts";
import { scheduleHash } from "@hey-pisgah/simulator";
import { buildPools } from "../src/build.js";
import { FIXTURES_ROOT, loadSubsets } from "../src/load.js";
import { committed, DATA } from "./helpers.js";

const rows = committed();
const count = (pool: string) => Object.entries(rows.filter((r) => r.pool === pool).reduce<Record<string, number>>((a, r) => ({ ...a, [r.manifest.family]: (a[r.manifest.family] ?? 0) + 1 }), {})).sort().map(([f, n]) => `${f}x${n}`).join(" ");

describe("committed pools", () => {
  it("equal a fresh build from the seed rule, histories included", () => {
    const fresh = buildPools();
    const got = Object.values(fresh).flat().map((x) => canonical(x.file)).sort();
    expect(got).toEqual(rows.map((r) => canonical(r.file)).sort());
    for (const r of rows) expect(r.file.schedule_hash).toBe(scheduleHash(r.file.schedule));
  });
  it("hold the planned families per pool", () => {
    expect(count("discovery")).toBe("F1x3 F2x1 F3x1 F4x1 F5x1 F6x1 F7x2 F8x1 F9x1");
    expect(count("dev")).toBe("F1x3 F10x1 F12x1 F2x2 F3x2 F4x1 F5x1 F6x1 F8x1 F9x2");
    expect(count("dev/held")).toBe("F1x2 F10x1 F2x1 F3x1 F4x1 F5x1 F6x1 F8x1 F9x1");
    expect(count("variation")).toBe("FVx2");
    expect(count("demo")).toBe("F1x1 FVx1");
    const disc = rows.filter((r) => r.pool === "discovery").map((r) => r.manifest.ward_id).sort().join("");
    expect(disc).toBe("AAAAAAAABBCC");
    expect(rows.filter((r) => r.manifest.overlays.includes("F11")).map((r) => r.pool)).toEqual(["dev"]);
  });
  it("give every case one id shape, a history only in discovery, and a manifest only under the evaluator", () => {
    for (const r of rows) {
      expect(CaseId.safeParse(r.file.case_id).success).toBe(true);
      expect(r.file.history !== null).toBe(r.pool === "discovery");
      expect(canonical(r.file)).not.toMatch(/acceptable_classes|should_apply|"family"/);
    }
    expect(new Set(rows.map((r) => r.file.case_id)).size).toBe(rows.length);
    expect(readdirSync(FIXTURES_ROOT).sort()).toEqual(["demo", "dev", "discovery", "subsets.json", "variation"]);
  });
  it("list four fault cases in dev and a reliability subset of four dev and two demo cases without faults", () => {
    const s = loadSubsets();
    const dev = rows.filter((r) => r.pool === "dev");
    expect(s.infra_fault).toHaveLength(4);
    expect(new Set(dev.filter((r) => r.file.infra_fault).map((r) => r.manifest.infra_fault!.kind)).size).toBe(4);
    for (const id of s.infra_fault) expect(dev.find((r) => r.file.case_id === id)?.file.infra_fault).not.toBeNull();
    expect([s.fr4.dev.length, s.fr4.demo.length]).toEqual([4, 2]);
    for (const id of s.fr4.dev) expect(dev.find((r) => r.file.case_id === id)?.file.infra_fault).toBeNull();
    expect(s.demo.step6).toBe(rows.find((r) => r.pool === "demo" && r.manifest.family === "FV")!.file.case_id);
    expect(rows.find((r) => r.file.case_id === s.demo.step5)?.manifest).toMatchObject({ family: "F1", ward_id: "A" });
  });
  it("give every decision point at least one acceptable class, with the infra fault cases waiting or asking", () => {
    for (const r of rows) {
      expect(r.manifest.decision_points.length).toBeGreaterThan(0);
      for (const dp of r.manifest.decision_points) expect(dp.acceptable_classes.length).toBeGreaterThan(0);
    }
    const faults = rows.flatMap((r) => r.manifest.decision_points.filter((d) => d.kind === "infra_fault"));
    expect(faults).toHaveLength(4);
    for (const f of faults) expect(f.acceptable_classes).toEqual(["wait", "ask"]);
  });
  it("commit the seed rule and the reserved hash file next to the manifests, and nothing reserved", () => {
    expect(readdirSync(DATA).sort()).toEqual(["manifests", "reserved.sha256", "seed-rule.json"]);
    expect(readFileSync(join(DATA, "reserved.sha256"), "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
    expect(readdirSync(join(DATA, "manifests")).sort()).toEqual(["demo.json", "dev.json", "dev_held.json", "discovery.json", "variation.json"]);
  });
});
