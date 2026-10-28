import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startServe } from "@hey-pisgah/agent";
import { readStream } from "@hey-pisgah/store";
import { versionCommand } from "./version.js";

const root = new URL("../../..", import.meta.url).pathname;
const A_PRIOR = join(root, "packages/agent/fixtures/proposals/a-prior.json");

describe("version command", () => {
  it("validates the A-prior proposal on dev, refuses a non-person, and adopts it for a person", async () => {
    const store = mkdtempSync(join(tmpdir(), "hp-version-"));
    const s = await startServe({ storeRoot: store, port: 0, mode: "mock", pollMs: 50 });
    const base = ["--proposal-file", A_PRIOR, "--store", store, "--serve", s.url];
    expect(await versionCommand(root, ["adopt", ...base, "--kind", "agent"])).toBe(1);
    expect(s.versions.registry.list().map((v) => v.status)).toEqual(["adopted"]);
    const report = readStream(store, "learning/validations").at(-1)!.payload as { report: { status: string; gate: { pass: boolean; exception_check: boolean; fences_intact: boolean } } };
    expect(report.report.status).toBe("dev_validated");
    expect(report.report.gate).toMatchObject({ pass: true, exception_check: true, fences_intact: true });
    expect(await versionCommand(root, ["adopt", ...base])).toBe(0);
    expect(readStream(store, "learning/validations").length).toBe(1);
    const v = s.versions.registry.get(2);
    expect([v.status, v.fallback_version, v.metadata.approver?.role, v.metadata.approver?.display_name]).toEqual(["adopted", 1, "ward_manager", "Synthetic ward manager (a person, disclosed)"]);
    expect(s.versions.registry.current({ ward_id: "A" } as never).version).toBe(2);
    await s.close();
  }, 120_000);
});
