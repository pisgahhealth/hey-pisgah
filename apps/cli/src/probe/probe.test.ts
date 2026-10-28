import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { LedgerRow } from "@hey-pisgah/contracts";
import { parseEnvText } from "./env.js";
import { BudgetHit, ProbeLedger, buildRow, readUsage } from "./ledger.js";
import { judgeToolCalls } from "./tools.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const rowFor = (provider: "modal" | "meta", body: any) => buildRow({
  provider, model: body.model, hosted_mode: provider === "meta" ? "standard" : null, effort: "low", effective_strength: provider === "meta" ? null : 8,
  response_id: body.id, usage: readUsage(body.usage), latency_ms: 1991, purpose: "probe:tool_call", run_id: "run-abcd1234", affinity_key: null
});

describe("recorded probe responses", () => {
  it("parses the Modal tool call into a LedgerRow with top-level reasoning tokens and no cache field", () => {
    const body = fixture("modal-tool-call.json");
    const row = LedgerRow.parse(rowFor("modal", body));
    expect(row).toMatchObject({ prompt_tokens: 669, completion_tokens: 88, reasoning_tokens: 16, cached_tokens: null });
    expect(row.cost_usd).toBeCloseTo((669 * 1.25 + 88 * 4.25) / 1e6, 10);
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(judgeToolCalls(body.choices[0].message.tool_calls)).toMatchObject({ valid: true, name: "get_case_state", calls: 1 });
  });

  it("parses the Meta hosted tool call with nested reasoning and cached tokens", () => {
    const row = LedgerRow.parse(rowFor("meta", fixture("meta-tool-call.json")));
    expect(row).toMatchObject({ prompt_tokens: 572, completion_tokens: 116, reasoning_tokens: 42, cached_tokens: 0, hosted_mode: "standard" });
  });
});

describe("probe helpers", () => {
  it("rejects tool calls that break the declared schema", () => {
    const call = (name: string, args: string) => [{ id: "x", type: "function", function: { name, arguments: args } }];
    expect(judgeToolCalls(undefined).reason).toBe("no_tool_call");
    expect(judgeToolCalls(call("get_case_state", '{"case_id":"104"}')).valid).toBe(false);
    expect(judgeToolCalls(call("get_case_state", '{"case_id":"C-104","extra":1}')).valid).toBe(false);
    expect(judgeToolCalls(call("compute_intervals", '{"start":"2026-10-28T09:15:00","end":"2026-10-28T10:00:00Z","unit":"minutes"}')).valid).toBe(false);
    expect(judgeToolCalls(call("get_ward_requirements", '{"ward":"Ward A","kind":"discharge"}')).valid).toBe(true);
  });

  it("parses env text without exposing anything and stops at the call cap", () => {
    expect(parseEnvText('export A="1"\n# c\nB=two\nEMPTY=\n')).toEqual({ A: "1", B: "two", EMPTY: "" });
    const ledger = new ProbeLedger(`${mkdtempSync(`${tmpdir()}/probe-`)}/l.jsonl`, 1, 2);
    ledger.reserve();
    expect(() => ledger.reserve()).toThrow(BudgetHit);
  });
});
