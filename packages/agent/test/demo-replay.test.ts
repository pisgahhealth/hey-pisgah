import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KEYS_PATH, secretValues } from "@hey-pisgah/model";
import { describe, expect, it } from "vitest";
import { loadV1 } from "@hey-pisgah/hospital";
import { readStream } from "@hey-pisgah/store";
import { Registry, type PersonApprover } from "@hey-pisgah/workflow";
import { RECORDED_DIR, startServe } from "../src/serve.js";
import { tempRoot } from "./helpers.js";

const A_PRIOR = (JSON.parse(readFileSync(new URL("../fixtures/proposals/a-prior.json", import.meta.url), "utf8")) as { proposal: { ops: unknown[]; scope: { wards: "all"; condition: null } } }).proposal;
const MANAGER: PersonApprover = { kind: "person", staff_id: "wm_synthetic", role: "ward_manager", display_name: "Synthetic ward manager" };
const GOAL = "Complete the discharge paperwork for this patient.";
// The two live runs as recorded; each task is opened in the order it ran so its id, and every request, match.
const RUNS = [
  { case_id: "c-110f6ad7", owner: "nurse n_a3", task_id: "t-e9687333", calls: 38, effect_set_hash: "b34fc0d75005cb147b82ab764670f0bb9b18313a7defc745e226e901ef7aae79" },
  { case_id: "c-2a14921a", owner: "nurse n_b1", task_id: "t-84aa48a0", calls: 50, effect_set_hash: "9c44d5c75c43c3ffaaad243e3b4e5088e592f307cab4f9e240bece78943fe37c" }
];

describe("demo cases, replayed", () => {
  it("replays step 5 and step 6 under adopted version 2 to their recorded effect sets", async () => {
    const reg = Registry.load([loadV1()]);
    const v2 = reg.propose(1, A_PRIOR.ops, { author: { kind: "model_session", id: "p-8f0e4fe7" }, proposal_id: "p-8f0e4fe7", source_evidence: { event_ids: [], hypothesis_ids: [], experiment_ids: [], validation_report_id: null }, model_provenance: null }, { scope: A_PRIOR.scope, fallback: 1 }).version!;
    expect(v2.definition_hash).toBe("42fa598d10013a6074b41d7babcd65859812252ca1ccf53fb2d5a402917b5472");
    reg.setValidation(2, "dev_validated");
    reg.adopt(2, MANAGER, { occurred_at: 0, recorded_at: 0, wall_at: "2026-10-28T11:51:00.000Z" });
    const root = tempRoot();
    const s = await startServe({ storeRoot: root, port: 0, mode: "replay", pollMs: 3, registry: reg, recordingsDir: `${RECORDED_DIR}demo-2026-10-28/recordings` });
    for (const r of RUNS) {
      const id = s.runtime.openTask({ case_id: r.case_id, goal: GOAL, owner: r.owner, budget: { max_calls: 80, max_usd: 1 } });
      expect(id).toBe(r.task_id);
      await s.runtime.settled(240_000);
      const st = s.runtime.status(id) as { state: string; closed: { effect_set_hash: string } };
      const p = s.runtime.projection(id);
      expect([st.state, p.counts.model_calls]).toEqual(["done", r.calls]);
      expect(st.closed.effect_set_hash).toBe(r.effect_set_hash);
      const rows = readStream(root, `ledger/${p.run_id}`).filter((e) => e.record_type === "model.call").map((e) => e.payload as { effort: string; provider: string; task_state: string });
      expect(rows.every((x) => x.effort === "low" && x.provider === "modal" && x.task_state === "running")).toBe(true);
    }
    await s.close();
  }, 300_000);

  it("the demo recordings hold no key value and no auth header", () => {
    const dir = `${RECORDED_DIR}demo-2026-10-28/recordings`;
    const secrets = secretValues(KEYS_PATH);
    const files = readdirSync(dir).filter((n) => n.endsWith(".json"));
    expect(files.length).toBe(88);
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(/authorization|bearer /i.test(text)).toBe(false);
      for (const v of secrets) expect(text.includes(v)).toBe(false);
    }
  });
});
