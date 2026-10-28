import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KEYS_PATH, secretValues } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { AGENT_RECORDINGS_DIR, startServe } from "../src/serve.js";
import { GOAL, OWNER, tempRoot } from "./helpers.js";

// The one live v1 case on Modal (effort low, 28 Oct 2026), replayed from its recordings with no network and no keys.
const LIVE = { calls: 38, cost_usd: 0.33711975, effect_set_hash: "579c0f283a531756306cfb588a96459064811132fcb6f0228007034a2b52d364" };

describe("live v1 case, replayed", () => {
  it("replays to the same done state, call count, cost and effect set", async () => {
    const root = tempRoot();
    const s = await startServe({ storeRoot: root, port: 0, mode: "replay", pollMs: 3 });
    const id = s.runtime.openTask({ case_id: "c-agent001", goal: GOAL, owner: OWNER });
    await s.runtime.settled(120_000);
    const st = s.runtime.status(id) as { state: string; closed: { effect_set_hash: string } };
    const p = s.runtime.projection(id);
    expect(st.state).toBe("done");
    expect(p.counts.model_calls).toBe(LIVE.calls);
    expect(p.budget.usd_used).toBeCloseTo(LIVE.cost_usd, 8);
    expect(st.closed.effect_set_hash).toBe(LIVE.effect_set_hash);
    const rows = readStream(root, `ledger/${p.run_id}`).filter((e) => e.record_type === "model.call").map((e) => e.payload as { effort: string; provider: string; task_state: string });
    expect(rows.every((r) => r.effort === "low" && r.provider === "modal" && r.task_state === "running")).toBe(true);
    await s.close();
  }, 180_000);

  it("the committed recordings hold no key value and no auth header", () => {
    const secrets = secretValues(KEYS_PATH);
    for (const f of readdirSync(AGENT_RECORDINGS_DIR).filter((n) => n.endsWith(".json"))) {
      const text = readFileSync(join(AGENT_RECORDINGS_DIR, f), "utf8");
      expect(/authorization|bearer /i.test(text)).toBe(false);
      for (const v of secrets) expect(text.includes(v)).toBe(false);
    }
  });
});
