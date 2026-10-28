import { describe, expect, it } from "vitest";
import { fencesHash } from "@hey-pisgah/contracts";
import { loadV1 } from "./definition.js";
import { stubEngine } from "./engine-seam.js";
import { loadHandCase } from "./fixtures.js";
import { loadWardRequirements } from "./requirements.js";
import { loadWorldBindings, loadWorldParameters } from "./world.js";

const hand = loadHandCase();
const v1 = loadV1();
const world = { bindings: loadWorldBindings(), requirements: loadWardRequirements() };
const parameters = loadWorldParameters();
const changed = stubEngine.applyOperations(v1, hand.g2.ops);
const wait = (def: typeof v1, preparer: "staff" | "agent") => stubEngine.run(def, world, hand.schedule, { preparer, parameters });

describe("G2 on the hand case, definition executor", () => {
  it("leaves the stored fences untouched", () => {
    expect(fencesHash(changed)).toBe(v1.metadata.fences_hash);
    expect(changed.edges.some((e) => e.edge_id === "e04")).toBe(false);
  });
  it("cuts the post-sign-off wait by 30 minutes or more when e04 goes", () => {
    const a = wait(v1, hand.g2.preparer);
    const b = wait(changed, hand.g2.preparer);
    expect([a.terminal_state, b.terminal_state]).toEqual(["departed", "departed"]);
    expect([a.post_signoff_wait_min, b.post_signoff_wait_min]).toEqual([hand.g2.expected.v1_wait_min, hand.g2.expected.changed_wait_min]);
    const cut = a.post_signoff_wait_min! - b.post_signoff_wait_min!;
    expect(cut).toBe(hand.g2.expected.cut_min);
    expect(cut).toBeGreaterThanOrEqual(hand.g2.expected.min_cut);
  });
  it("still holds the final summary until the clinical discharge", () => {
    const b = wait(changed, "staff");
    expect(b.step_times.st06!.completed_occ!).toBeLessThan(b.step_times.st05!.completed_occ!);
    expect(b.step_times.st07!.started_occ!).toBeGreaterThanOrEqual(b.step_times.st05!.completed_occ!);
  });
  it("records the smaller cut when the agent prepares at one minute", () => {
    expect(wait(v1, "agent").post_signoff_wait_min! - wait(changed, "agent").post_signoff_wait_min!).toBe(5);
  });
});
