import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPool } from "@hey-pisgah/cases";
import { assertAllowedPath, isInside } from "@hey-pisgah/store";
import {
  UNKNOWN_ID, reservedRunFile, reservedRunRefusal, reservedRunsRoot, reservedTokens, sealedReservedCases, serveAllowlist, visibleLookup, writeReservedArtifact
} from "../src/reserved.js";
import { TranscriptLeak, assertNoReservedLeak, scanTranscripts } from "../src/scan.js";

const repo = join(import.meta.dirname, "..", "..", "..");
const temp = () => mkdtempSync(join(tmpdir(), "rsv-"));
const tokens = reservedTokens();
const cli = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, ["--import", "tsx", join(repo, "apps", "cli", "src", "index.ts"), ...args], { cwd: repo, env: { ...process.env, ...env }, encoding: "utf8" });

describe("the one reserved run", () => {
  it("refuses in CI and once RUN.json exists", () => {
    const root = temp();
    expect(reservedRunRefusal(root, { CI: "true" })?.reason).toBe("ci");
    expect(reservedRunRefusal(root, {})).toBeNull();
    mkdirSync(join(root, "evaluation", "reserved"), { recursive: true });
    writeFileSync(reservedRunFile(root), "{}\n");
    expect(reservedRunRefusal(root, {})?.reason).toBe("run_recorded");
    expect(() => sealedReservedCases(root, { env: {} })).toThrow(/run_recorded/);
  });
  it("refuses a seed hash that does not match before generating anything", () => {
    const root = temp();
    const bad = join(root, "reserved.sha256");
    writeFileSync(bad, `${"0".repeat(64)}\n`);
    expect(() => sealedReservedCases(root, { env: {}, hashFile: bad })).toThrow(/does not match/);
  });
  it("eval --set reserved exits 4 under CI=true", () => {
    const r = cli(["eval", "--set", "reserved"], { CI: "true" });
    expect([r.status, r.stdout.trim()]).toEqual([4, "eval --set reserved refused: ci"]);
  });
  it("writes reserved outputs once, only under reserved-runs, which serve cannot open", () => {
    const root = temp();
    const f = writeReservedArtifact(root, "run-aaaaaaaa", "case.json", { ok: true });
    expect(isInside(reservedRunsRoot(root), f)).toBe(true);
    expect(() => writeReservedArtifact(root, "run-aaaaaaaa", "case.json", {})).toThrow(/written once/);
    expect(() => writeReservedArtifact(root, "run-aaaaaaaa", "../../store/x.json", {})).toThrow();
    expect(() => writeReservedArtifact(root, "../store", "x.json", {})).toThrow();
    expect(serveAllowlist(root).some((r) => isInside(r, reservedRunsRoot(root)))).toBe(false);
    expect(() => assertAllowedPath(serveAllowlist(root), f)).toThrow(/outside the configured roots/);
  });
  it("keeps the reserved generator in one sealed module that writes only through the reserved-runs writer", () => {
    const src = join(repo, "packages", "evaluator", "src");
    const files = readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    const importers = files.filter((f) => /from\s+["']@hey-pisgah\/cases\/reserved["']/.test(readFileSync(join(src, f), "utf8")));
    expect(importers).toEqual(["reserved.ts"]);
    expect(readFileSync(join(src, "reserved.ts"), "utf8").match(/writeFileSync\(/g)).toHaveLength(1);
  });
});

describe("uniform unknown_id", () => {
  const visible = new Map(loadPool("discovery").map((c) => [c.case_id, c]));
  const lookup = visibleLookup(visible);
  it("answers reserved, dev-validation, unknown and malformed ids with one identical object", () => {
    const hidden = [
      ...tokens.ids,
      ...(["dev", "dev/held", "variation", "demo"] as const).flatMap((p) => loadPool(p).map((c) => c.case_id)),
      "c-00000000", "c-zzzz", "", 42, null, { case_id: "c-00000000" }
    ];
    for (const id of hidden) expect(lookup(id)).toBe(UNKNOWN_ID);
    expect(new Set(hidden.map((id) => JSON.stringify(lookup(id)))).size).toBe(1);
    expect(Object.isFrozen(UNKNOWN_ID)).toBe(true);
    const first = [...visible.keys()][0]!;
    expect(lookup(first)).toMatchObject({ ok: true });
  });
});

describe("transcript scan", () => {
  const roots = [join(repo, "packages", "model", "fixtures"), join(repo, "packages", "cases", "fixtures"), join(repo, "packages", "agent", "fixtures"), join(repo, ".hey-pisgah", "store"), join(repo, ".hey-pisgah", "runs")];
  it("finds no reserved id or canary in any committed or stored transcript", () => {
    expect(() => assertNoReservedLeak(roots, tokens, [reservedRunsRoot(repo)])).not.toThrow();
  });
  it("turns red on a planted canary, and ignores the same text inside a reserved run", () => {
    const root = temp();
    const canary = tokens.canaries[3]!;
    const id = tokens.ids[5]!;
    const recording = { request: { messages: [{ role: "system", content: "Discharge work" }, { role: "tool", content: `patient ${canary.toUpperCase()}` }] }, response: { choices: [{ message: { role: "assistant", content: `opening ${id}` } }] } };
    const runs = join(root, ".hey-pisgah", "runs", "run-bbbbbbbb");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "rec.json"), JSON.stringify(recording));
    writeFileSync(join(runs, "ledger.jsonl"), `${JSON.stringify({ prompt: `see ${canary}` })}\nnot json ${id}\n`);
    const hits = scanTranscripts([join(root, ".hey-pisgah")], tokens, [reservedRunsRoot(root)]);
    expect(hits.map((h) => h.channel).sort()).toEqual(["model_output", "other", "prompt", "tool_output"]);
    expect(() => assertNoReservedLeak([join(root, ".hey-pisgah")], tokens, [reservedRunsRoot(root)])).toThrow(TranscriptLeak);
    const clean = temp();
    const sealed = join(reservedRunsRoot(clean), "run-cccccccc");
    mkdirSync(sealed, { recursive: true });
    writeFileSync(join(sealed, "rec.json"), JSON.stringify(recording));
    expect(scanTranscripts([join(clean, ".hey-pisgah")], tokens, [reservedRunsRoot(clean)])).toEqual([]);
  });
});
