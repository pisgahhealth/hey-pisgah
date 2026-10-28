import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashJson } from "@hey-pisgah/contracts";
import { claimStatus, readCommitment, journeyDenyHits, journeyResults, loadJourney, parseClaimPredicate, sameJourney, type JourneyResults } from "@hey-pisgah/evaluator";
import type { MockResponder } from "@hey-pisgah/model";
import { replayJourney } from "../src/journey-fake.js";
import { keyedGate, scriptKey } from "../src/journey.js";

const RECORDED = new URL("../../evaluator/fixtures/journey/recorded-gate.json", import.meta.url);
const RESULTS = new URL("../../../evaluation/results/journey.json", import.meta.url);
const C18 = (JSON.parse(readFileSync(new URL("../../../evaluation/claims.json", import.meta.url), "utf8")).claims as { claim_id: string; acceptance: { predicate: string } }[]).find((c) => c.claim_id === "C-18");

const play = (gate: MockResponder) => replayJourney(gate);

describe("the journey on the in-memory hospital", () => {
  it("holds no line that hints at the learning layer, and every decision point names a script step", () => {
    const s = loadJourney();
    expect(journeyDenyHits(s)).toEqual([]);
    for (const d of s.decision_points) expect(s.steps.some((x) => x.id === d.line), d.dp_id).toBe(true);
    // The acceptable classes in force are the ones committed before the run.
    const body = readCommitment("journey")!.revisions.at(-1)!.body as { script_sha256: string; decision_points: unknown[] };
    expect(body.script_sha256).toBe(hashJson(s));
    expect(body.decision_points).toEqual(s.decision_points.map((d) => ({ dp_id: d.dp_id, line: d.line, measure: d.measure, acceptable: d.acceptable })));
  });

  it("runs every step with the keyed gate: hand-offs, the pause with no model call, the digest, and every point appropriate", async () => {
    const { results: r, hospital } = await play(keyedGate(scriptKey(loadJourney())));
    expect(r.per_step.filter((p) => !p.ok)).toEqual([]);
    expect(r.fr1.rows.filter((p) => p.outcome !== "appropriate")).toEqual([]);
    expect(r).toMatchObject({ prohibited_attempts: 0, calls_while_paused: 0, digest_present: true, actions_unproved: 0, refusals: 2, owners_with_tasks: 3, actions_refused_by_emr: 1, emr_refusals_expected: 1, actions_unverified: 1 });
    expect(r.interruption).toMatchObject({ paused: true, pending_at_pause: 1, resumed_and_written: true, heard_while_paused: 1 });
    expect(r.interruption.digest).toContain("pulse");
    expect(r.handoffs_picked_up).toBeGreaterThanOrEqual(1);
    expect(hospital.writes.map((w) => w.kind)).toEqual([
      "record_triage_vitals", "request_admission", "record_observation", "add_care_plan_item", "add_care_plan_item",
      "record_observation", "record_note", "page_staff", "page_staff", "draft_handover", "record_note", "schedule_follow_up", "page_staff", "prepare_bill", "send_pay_link"
    ]);
    // No write ever went out for a kind its owner does not hold, and the person steps were left to people.
    expect(hospital.writes.every((w) => hospital.kindsFor(w.owner).includes(w.kind))).toBe(true);
    if (C18) expect(claimStatus(parseClaimPredicate(C18.acceptance.predicate), { ...r, replay_same: true }).status).toBe("green");
  }, 120_000);

  it.skipIf(!existsSync(RECORDED) || !existsSync(RESULTS))("replays the live run's gate answers to the same steps, points and pause as the published result", async () => {
    const recorded = JSON.parse(readFileSync(RECORDED, "utf8")) as { by_text: Record<string, Record<string, unknown>[]> };
    const { results } = await play(keyedGate(recorded.by_text));
    const live = JSON.parse(readFileSync(RESULTS, "utf8")) as JourneyResults;
    expect(sameJourney(results, live)).toBe(true);
  }, 120_000);
});
