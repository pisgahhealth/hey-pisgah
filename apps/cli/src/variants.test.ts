import { validateProposal } from "@hey-pisgah/evaluator";
import { VARIANTS, loadVariant } from "@hey-pisgah/intelligence";
import { describe, expect, it } from "vitest";

const proposal = (ops: unknown[], tag: string) => ({ proposal_id: `p-${tag}`, parent_proposal_id: null, base_version: 1, ops, scope: { wards: "all", condition: null }, rationale: "r", evidence: { hypothesis_ids: [], experiment_ids: [], event_ids: [] }, expected_effects: [], known_exceptions: [], viewed_case_ids: [], status: "submitted", hash: "0".repeat(64) });
const gain = (r: { cases: { delta: { post_signoff_wait_min: number | null } }[] }) => -r.cases.reduce((s, c) => s + (c.delta.post_signoff_wait_min ?? 0), 0);

describe("simulator variants through the dev gate", () => {
  it("validates each planted answer on its own validation cases, and no strict subset of the triple gets half its gain", async () => {
    for (const id of VARIANTS) {
      const v = loadVariant(id);
      const opts = v.validation ? { base: v.base, cases: v.validation, caseFacts: v.pool.caseFacts() } : {};
      const r = await validateProposal(proposal(v.planted, "0000aaa1"), opts);
      expect(r.status, id).toBe("dev_validated");
      expect(gain(r), id).toBeGreaterThan(0);
      if (id !== "triple") continue;
      for (let m = 1; m < 7; m++) {
        const sub = v.planted.filter((_, i) => (m >> i) & 1);
        const s = await validateProposal(proposal(sub, `0000bb${m}0`), opts);
        expect(gain(s), JSON.stringify(sub)).toBeLessThan(gain(r) / 2);
      }
    }
  }, 120_000);

  it("refuses the change that switched the refund voucher final off in the triple world", async () => {
    const v = loadVariant("triple");
    const r = await validateProposal(proposal([{ op: "add_condition", target: { step: { step: "st17b" } }, condition: { fact: "expected_discharge_recorded", eq: "false" } }], "0000dd02"), { base: v.base, cases: v.validation!, caseFacts: v.pool.caseFacts() });
    expect(r.status).toBe("dev_failed");
    expect(r.gate?.documents_kept).toBe(false);
    expect(gain(r)).toBeGreaterThan(0);
  }, 60_000);
});
