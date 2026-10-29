import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelClient, type ChatMessage } from "@hey-pisgah/model";
import { REFERENCE_NAMES, SPARK_SYSTEM, parseSpark, sparkContent } from "./spark.js";

// Probes, on tuning clips only, whether one Spark call reads several named audio parts; nothing here is scored.
const dir = ".hey-pisgah/r1/synth";
const b64 = (id: string) => readFileSync(join(dir, `${id}.wav`)).toString("base64");
const client = new ModelClient({ storeRoot: ".hey-pisgah/r1/store", mode: "live", record: false });
const provider = (process.argv[2] ?? "modal") as "modal" | "meta";
const model = provider === "modal" ? "meta-models/Muse-Spark-Open-816B-A42B" : "muse-spark-1.3";
const refs = (["S", "B", "N"] as const).map((p) => ({ name: REFERENCE_NAMES[p], b64: b64(`E1-${p}`) }));
for (const id of (process.argv[3] ?? "T01,T11,T16,T23").split(",")) {
  const messages = [{ role: "system", content: SPARK_SYSTEM }, { role: "user", content: sparkContent(provider, refs, b64(id)) }] as unknown as ChatMessage[];
  try {
    const r = await client.call({ provider, model, effort: "low", messages, max_completion_tokens: 2000, purpose: "interpret_speech", run_id: "run-r1probe1", task_id: null, task_state: null, thread: "side", affinity_key: null });
    const text = String(r.completion.choices[0]?.message?.content ?? "");
    console.log(id, r.row.latency_ms, "ms", `$${r.row.cost_usd.toFixed(5)}`, r.row.prompt_tokens, "in", JSON.stringify(parseSpark(text) ?? text.slice(0, 300)));
  } catch (e) {
    console.log(id, "error", e instanceof Error ? e.message : String(e));
  }
}
client.close();
