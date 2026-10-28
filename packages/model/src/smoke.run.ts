import { resolve } from "node:path";
import { createModelClient } from "./client.js";
import { callStructured } from "./structured.js";
import { SMOKE_REQUEST, SmokeArgs } from "./smoke.js";

// Runs the smoke call in the mode HEY_PISGAH_MODE names and prints usage figures only.
const client = createModelClient({ storeRoot: resolve(process.cwd(), ".hey-pisgah/store") });
try {
  const r = await callStructured(client, SmokeArgs, SMOKE_REQUEST, { toolName: "get_case_state" });
  const { prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, cost_usd, latency_ms, mode } = r.result.row;
  console.log(JSON.stringify({ mode, hash: r.result.hash, repairs: r.repairs, value: r.value, prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, cost_usd, latency_ms }));
} finally {
  client.close();
}
