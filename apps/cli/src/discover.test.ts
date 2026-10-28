import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNKNOWN_ID as EVALUATOR_UNKNOWN_ID, reservedTokens, runValidationStream } from "@hey-pisgah/evaluator";
import { STREAMS, Session, UNKNOWN_ID, checkDiscoveryCommand, discoverCommand } from "@hey-pisgah/intelligence";
import { readStream } from "@hey-pisgah/store";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..", "..");
const temp = () => mkdtempSync(join(tmpdir(), "hp-cli-"));

describe("discover and check:discovery", () => {
  it("runs a mock adaptive discovery through the evaluator's validation pipeline", async () => {
    const store = temp();
    const lines: string[] = [];
    const code = await discoverCommand(root, ["--arm", "adaptive", "--budget-usd", "1", "--max-calls", "20", "--store", store, "--run-id", "run-c11aaaaa"], { mode: "mock", out: (l) => lines.push(l), validate: async (s) => { await runValidationStream(s); } });
    expect(code).toBe(0);
    expect(lines[0]).toContain("stop dev_valid_proposal");
    const reports = readStream(store, STREAMS.validations).map((e) => (e.payload as { report: { status: string } }).report.status);
    expect(reports).toEqual(["dev_validated"]);
    const out: string[] = [];
    expect(checkDiscoveryCommand(root, ["run-c11aaaaa", "--store", store], (l) => out.push(l))).toBe(0);
    expect(out.join("\n")).toContain("deny-list scan");
    expect(checkDiscoveryCommand(root, ["run-c11bbbbb", "--store", store], () => {})).toBe(1);
  });

  it("refuses a live run whose hashes are not committed, and an A4 run with no committed order", async () => {
    const store = temp();
    const quiet = { out: () => {}, mode: "live" as const };
    expect(await discoverCommand(temp(), ["--arm", "prior", "--store", store], quiet)).toBe(5);
    expect(await discoverCommand(temp(), ["--arm", "a4", "--store", store], { out: () => {}, mode: "mock" })).toBe(6);
    expect(await discoverCommand(root, ["--arm", "nope"], quiet)).toBe(2);
  });

  it("answers a real reserved id with the evaluator's own unknown_id object", () => {
    expect(UNKNOWN_ID).toEqual(EVALUATOR_UNKNOWN_ID);
    const s = new Session({ storeRoot: temp(), runId: "run-c11ccccc", arm: "adaptive" });
    const id = reservedTokens().ids[0]!;
    for (const a of [s.timeline({ case_id: id, order: "occurred" }), s.record({ case_id: id, record_kind: "signoff_record" }), s.queue({ case_id: id, at_min: 600 }), s.staff({ case_id: id, role: "nurse" })]) {
      expect(JSON.stringify(a)).toBe(JSON.stringify(EVALUATOR_UNKNOWN_ID));
    }
    s.close();
  });
});
