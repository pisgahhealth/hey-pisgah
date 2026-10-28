import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createModelClient, type ChatMessage, type ChatTool } from "@hey-pisgah/model";
import { describe, expect, it } from "vitest";
import { INTELLIGENCE_RECORDINGS_DIR } from "../src/cli.js";
import { tempRoot } from "./helpers.js";

type Body = { model: string; messages: ChatMessage[]; reasoning_effort: "xhigh"; tools?: ChatTool[]; parallel_tool_calls?: boolean; max_completion_tokens?: number };
const files = readdirSync(INTELLIGENCE_RECORDINGS_DIR).filter((f) => f.endsWith(".json"));

describe("the L2.1 discovery recordings", () => {
  it("still replay exactly through the body-keyed fallback", async () => {
    expect(files.length).toBe(4);
    const client = createModelClient({ storeRoot: tempRoot(), mode: "replay", recordingsDir: INTELLIGENCE_RECORDINGS_DIR, budget: { runUsd: 100, runMaxCalls: 100, weekUsd: 1e6, weekStopFraction: 1, weekSince: () => new Date(0) } });
    for (const f of files) {
      const rec = JSON.parse(readFileSync(join(INTELLIGENCE_RECORDINGS_DIR, f), "utf8")) as { hash: string; provider: "modal"; request: Body; response: unknown };
      const b = rec.request;
      const r = await client.call({
        provider: rec.provider, model: b.model, effort: b.reasoning_effort, messages: b.messages, ...(b.tools ? { tools: b.tools } : {}),
        ...(b.parallel_tool_calls !== undefined ? { parallel_tool_calls: b.parallel_tool_calls } : {}), ...(b.max_completion_tokens !== undefined ? { max_completion_tokens: b.max_completion_tokens } : {}),
        purpose: "replay.check", run_id: "run-0ld2e9a1", task_id: null, task_state: null, thread: "main", affinity_key: null
      });
      expect(r.hash).toBe(rec.hash);
      expect(r.completion).toEqual(rec.response);
    }
    client.close();
  });
});
