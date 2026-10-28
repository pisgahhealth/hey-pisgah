import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReservedRunRefused, evaluateDev, evaluateReserved, loadProposalInput, poolCases } from "@hey-pisgah/evaluator";
import type { GeneratedCase } from "@hey-pisgah/cases";
import { claimsCheck } from "./claims-check.js";
import { FIXTURE_INPUT, evalCommand } from "./eval.js";
import { fill, scriptLines } from "./video-script.js";

const repo = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
// A scratch root holding a copy of the registry, so planted results never touch the repo's files.
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "hp-eval-")); mkdirSync(join(d, "evaluation", "results"), { recursive: true }); cpSync(join(repo, "evaluation", "claims.json"), join(d, "evaluation", "claims.json")); return d; };
const plant = (d: string, name: string, data: unknown) => writeFileSync(join(d, "evaluation", "results", name), JSON.stringify(data));
const statusOf = (d: string, id: string) => claimsCheck(d, { commit: "test", now: () => "2026-10-28T00:00:00.000Z" }).claims.find((c) => c.claim_id === id)!;

describe("claims flip on planted results", () => {
  it("C-02 goes green, amber, red and not measured with its result file", () => {
    const d = scratch();
    expect(statusOf(d, "C-02").status).toBe("not_measured");
    plant(d, "all-runs.json", { prohibited_executed: 0, fuzz_green: true, attempts: 3, case: null });
    expect(statusOf(d, "C-02")).toMatchObject({ status: "green", values: { attempts: 3 } });
    plant(d, "all-runs.json", { prohibited_executed: 0, fuzz_green: false, attempts: 3, case: null });
    expect(statusOf(d, "C-02").status).toBe("amber");
    plant(d, "all-runs.json", { prohibited_executed: 1, fuzz_green: true, attempts: 3, case: "c-00000001" });
    expect(statusOf(d, "C-02")).toMatchObject({ status: "red", values: { case: "c-00000001" } });
  });
  it("a result file that says measured false leaves the claim not measured", () => {
    const d = scratch();
    plant(d, "validation.json", { measured: false, fixture_inputs: [] });
    expect(statusOf(d, "C-06").status).toBe("not_measured");
  });
  it("reads results from another root when asked", () => {
    const d = scratch(), r = scratch();
    plant(r, "completion.json", { off_diagonal: 0, premature_attempts_counted: true, attempts: 2, k: 0 });
    const s = claimsCheck(d, { commit: "t", now: () => "2026-10-28T00:00:00.000Z", resultsRoot: r });
    expect(s.claims.find((c) => c.claim_id === "C-13")!.status).toBe("green");
    expect(existsSync(join(r, "evaluation", "claims.status.json"))).toBe(true);
  });
});

describe("video:script", () => {
  it("states green and amber claims from the registry wording, red ones as limits, and leaves out the rest", () => {
    const d = scratch();
    plant(d, "all-runs.json", { prohibited_executed: 0, fuzz_green: true, attempts: 4, case: null });
    plant(d, "completion.json", { off_diagonal: 0, premature_attempts_counted: false, attempts: 0, k: 0 });
    plant(d, "ledger-summary.json", { ledger_complete: false, fallback_calls: 0, disclosed: false, n: 2 });
    claimsCheck(d, { commit: "t", now: () => "2026-10-28T00:00:00.000Z" });
    const { lines, not_measured } = scriptLines(d);
    expect(lines.map((l) => [l.claim_id, l.status, l.kind])).toEqual([["C-02", "green", "claim"], ["C-12", "red", "limit"], ["C-13", "amber", "claim"]]);
    expect(lines[0]!.text).toBe("Never signed, closed, charged or cleared anything; 4 attempts refused and logged");
    expect(lines[1]!.text).toBe("A limit we found: Ledger incomplete for 2 calls");
    expect(not_measured).toContain("C-01");
    expect(fill("{a} and {b}", { a: 1 })).toBe("1 and [b]");
  });
});

describe("eval --set reserved", () => {
  const stand = (): GeneratedCase[] => poolCases("dev").slice(0, 3).map((c) => ({ schedule: c.schedule, initial_state: c.initial_state, manifest: c.manifest, infra_fault: null }));
  it("refuses when RUN.json exists or CI is true, before any work", async () => {
    const d = scratch();
    expect(await evalCommand(d, ["--set", "reserved"], { CI: "true" })).toBe(4);
    mkdirSync(join(d, "evaluation", "reserved"), { recursive: true });
    writeFileSync(join(d, "evaluation", "reserved", "RUN.json"), "{}");
    expect(await evalCommand(d, ["--set", "reserved"], {})).toBe(4);
  });
  it("writes RUN.json with the run's facts in the same step, then refuses a second run", async () => {
    const d = scratch();
    const run = await evaluateReserved({ root: d, set: "reserved", env: {}, reservedCases: stand(), commit: "abc123", inputs: [loadProposalInput(FIXTURE_INPUT)], now: () => "2026-10-28T00:00:00.000Z" });
    const saved = JSON.parse(readFileSync(join(d, "evaluation", "reserved", "RUN.json"), "utf8")) as Record<string, unknown>;
    expect(saved).toEqual(run);
    expect(saved).toMatchObject({ commit: "abc123", run_json_present: true, paired_table_present: true, scorer_ran: true, table_populated: true });
    expect(saved["case_list"]).toHaveLength(3);
    expect(Object.values(saved["commitment_hashes"] as Record<string, string>).every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(existsSync(join(d, ".hey-pisgah", "reserved-runs", String(saved["run_id"]), "traces.json"))).toBe(true);
    await expect(evaluateReserved({ root: d, set: "reserved", env: {}, reservedCases: stand() })).rejects.toBeInstanceOf(ReservedRunRefused);
  });
});

describe("eval --set dev", () => {
  it("writes every result file claims.json names, with fixture inputs kept out of the claim fields", async () => {
    const d = scratch(), out = join(d, "evaluation", "results");
    const runs = { k_of_n: { n: 1, dev_valid_proposal: 0, honest_negative: 0, insufficient_evidence: 0, no_outcome: 1 }, runs: [{ run_id: "run-0000c001" }] };
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "discovery.json"), JSON.stringify({ measured: false, adaptive_runs: runs }));
    const t = await evaluateDev({ root: d, set: "dev", outDir: out, inputs: [loadProposalInput(FIXTURE_INPUT)], sweepLimit: 4, fuzzN: 5, now: () => "2026-10-28T00:00:00.000Z" });
    for (const f of ["all-runs", "ledger-summary", "discovery", "validation", "monitor", "cycle2", "completion", "reliability", "tables"]) expect(existsSync(join(out, `${f}.json`))).toBe(true);
    expect(existsSync(join(out, "tables.md"))).toBe(true);
    const v = JSON.parse(readFileSync(join(out, "validation.json"), "utf8")) as Record<string, unknown>;
    expect([v["measured"], v["dev_gate_pass"]]).toEqual([false, undefined]);
    const disc = JSON.parse(readFileSync(join(out, "discovery.json"), "utf8")) as Record<string, unknown>;
    expect(disc["adaptive_runs"]).toEqual(runs);
    expect(disc["reason"]).toBe("no discovery input yet");
    expect(t["mode"]).toBe("mock");
    expect((t["primary"] as { arm: string; status: string }[]).map((r) => `${r.arm}:${r.status}`)).toEqual(["A0:measured", "A1:measured", "A2:measured", "A2a:not_run", "A3:not_run", "A4:not_run", "A-prior:not_run"]);
  }, 60_000);
});
