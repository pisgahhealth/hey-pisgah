import { describe, expect, it } from "vitest";
import { loadPool, type GeneratedCase } from "@hey-pisgah/cases";
import { checkG, runGChecks } from "../src/gchecks.js";
import { reservedTokens } from "../src/reserved.js";
import { loadManifests } from "../src/data.js";

// Committed pools stand in for a generated set, so no test ever generates reserved cases.
const committed = (pools: ("discovery" | "dev" | "variation")[]): GeneratedCase[] => pools.flatMap((p) => {
  const m = loadManifests(p);
  return loadPool(p).map((f) => ({ schedule: f.schedule, initial_state: f.initial_state, manifest: m.get(f.case_id)!, infra_fault: f.infra_fault }));
});

describe("sealed check:g", () => {
  const set = committed(["discovery", "dev", "variation"]);
  it("runs G1 to G6 on a set and passes on the committed pools", () => {
    expect(runGChecks(set, () => set).map((l) => `${l.id} ${l.status}`)).toEqual(["G1 pass", "G2 pass", "G3 pass", "G4 pass", "G5 pass", "G6 pass"]);
  });
  it("fails G6 when a schedule no longer matches its manifest hash", () => {
    const bad = set.map((c, i) => (i === 0 ? { ...c, manifest: { ...c.manifest, schedule_hash: "0".repeat(64) } } : c));
    expect(runGChecks(bad).find((l) => l.id === "G6")?.status).toBe("fail");
  });
  it("prints pass or fail lines only, and nothing when generation itself fails", () => {
    const lines: string[] = [];
    expect(checkG(["--set", "spare"], (l) => lines.push(l), () => committed(["dev"]))).toBe(0);
    for (const l of lines) expect(l).toMatch(/^(G[1-6] (pass|fail|n\/a)|check:g (pass|fail))$/);
    expect(lines).toContain("G3 n/a");
    const text = lines.join("\n");
    for (const t of [...reservedTokens().ids, ...reservedTokens().canaries, ...set.map((c) => c.manifest.case_id)]) expect(text.includes(t)).toBe(false);
    const failed: string[] = [];
    expect(checkG([], (l) => failed.push(l), () => { throw new Error("c-12345678 Quorvane"); })).toBe(1);
    expect(failed).toEqual(["check:g fail"]);
    expect(checkG(["--set", "dev"], () => undefined, () => [])).toBe(2);
  });
});
