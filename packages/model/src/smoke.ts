import { z } from "zod";
import type { CallArgs } from "./client.js";

// The one recorded Modal smoke call; replay tests rebuild the same request from here.
export const SmokeArgs = z.strictObject({ case_id: z.string().regex(/^c-[a-z0-9]{8}$/) });

export const SMOKE_REQUEST: CallArgs = {
  provider: "modal",
  model: "meta-models/Muse-Spark-Open-816B-A42B",
  effort: "low",
  messages: [
    { role: "system", content: "You are a discharge assistant. Use the tool to read case state. Never invent ids." },
    { role: "user", content: "Look up the current state of case c-ab12cd34." }
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "get_case_state",
        description: "Read the current state of one discharge case.",
        parameters: { type: "object", properties: { case_id: { type: "string", pattern: "^c-[a-z0-9]{8}$" } }, required: ["case_id"], additionalProperties: false }
      }
    }
  ],
  parallel_tool_calls: false,
  max_completion_tokens: 600,
  purpose: "smoke",
  run_id: "run-smoke001",
  task_id: null,
  task_state: null,
  thread: "main",
  affinity_key: null
};
