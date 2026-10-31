import { describe, expect, it } from "vitest";
import type { EmrContext, EmrTarget } from "../src/emr/port.js";
import type { SayInput } from "../src/emr/runtime.js";
import { OWNER } from "./emr-helpers.js";
import { boot, chunkWav, earOf } from "./mic-helpers.js";

const ARRIVAL = "aaaaaaaa-1111-4222-8333-555555555555";

// Acceptance pass 9, B11: after a restart the port knew no admission for the patient on the surgeon's page, the listening session's context had none, and the line reached the runtime with no patient at all.
describe("a listened line keeps the patient of the page it was heard on", () => {
  it("passes the page's patient on when the session's context has no admission", async () => {
    const { rt, port, listen, settle } = boot(() => [{ class: "aside" }], earOf({ 2000: "Accepted surgical review." }));
    port.resolve = async (target: EmrTarget): Promise<EmrContext> => ({ admission_id: "", patient_id: target.patient_id ?? null, visit_id: null, label: "Unnamed arrival", facts: {}, keywords: [] });
    const said: SayInput[] = [];
    const inner = rt.say.bind(rt);
    rt.say = async (s: SayInput, taskId?: string) => { said.push(s); return inner(s, taskId); };
    await listen.chunk({ owner: OWNER, target: { patient_id: ARRIVAL }, session_id: "s1", seq: 0, wav: chunkWav(1300, 700) }, true);
    await settle();
    expect(said).toHaveLength(1);
    expect(said[0]!.target).toEqual({ admission_id: "", patient_id: ARRIVAL });
    await rt.stop();
  });
});
