import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, appTexts, armHashes } from "@hey-pisgah/intelligence";
import type { CallArgs, ModelClient } from "@hey-pisgah/model";
import { afterEach, describe, expect, it } from "vitest";
import { RUNGS, SHARED_HEADER, hintText, quarantined, sharedLedger, type Rung } from "./quarantine-discovery.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const session = (runId: string) => { const d = mkdtempSync(join(tmpdir(), "q7-")); dirs.push(d); return new Session({ storeRoot: d, runId, arm: "adaptive" }); };

describe("quarantined discovery", () => {
  it("carries the hint after the kickoff and the shared ledger after the cycle ledger, once per cycle", async () => {
    const seen: CallArgs[] = [];
    const fake = { call: async (a: CallArgs) => { seen.push(a); return null; }, mode: "mock" } as unknown as ModelClient;
    const s = session("run-q7test01");
    let built = 0;
    const c = quarantined(fake, s, hintText("L3"), () => { built += 1; return `${SHARED_HEADER}\n[]`; });
    const msgs = (ledger: string) => [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "kick" }, { role: "user" as const, content: ledger }, { role: "user" as const, content: "stage" }];
    await c.call({ messages: msgs("ledger 0") } as CallArgs);
    await c.call({ messages: msgs("ledger 0") } as CallArgs);
    await c.call({ messages: msgs("ledger 1") } as CallArgs);
    expect(seen[0]!.messages[1]!.content).toBe(`kick\n${hintText("L3")}`);
    expect(seen[0]!.messages[3]!.content).toContain(SHARED_HEADER);
    expect(seen[0]!.messages[4]!.content).toBe("stage");
    expect(built).toBe(2);
    expect(c.mode).toBe("mock");
    s.close();
  });

  it("shares only investigators that have recorded something", () => {
    const a = session("run-q7test02");
    expect(sharedLedger([{ k: 2, s: a }])).toBe("");
    a.close();
  });

  it("keeps every hint out of the committed texts and hashes", () => {
    const committed = appTexts("adaptive").map((t) => t.text).join("\n");
    for (const r of Object.keys(RUNGS) as Rung[]) for (const h of RUNGS[r]) if (!h.startsWith("Precondition table")) expect(committed.includes(h)).toBe(false);
    expect(committed.includes(SHARED_HEADER)).toBe(false);
    expect(armHashes("adaptive").prompt).toMatch(/^[0-9a-f]{64}$/);
  });
});
