import { describe, expect, it } from "vitest";
import type { EmrCommit, Provenance, WorkArgs } from "../src/emr/port.js";
import { ClerkFake, DOC, PAT, clerkBoot, ins } from "./clerking-helpers.js";

// Coordinator smoke, 1 Nov: a vitals write the hospital refused with its own reason left no note, so the strip showed nothing done and no why.
class RefusingFake extends ClerkFake {
  message: string | undefined = "Record the patient's vitals before assigning. Missing temperature.";
  override async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    if (kind === "record_observation" || kind === "record_clerking") return { ok: false, reason: "door_409_conflict", status: 409, retryable: false, counted: false, ...(this.message ? { message: this.message } : {}) };
    return super.commit(kind, args, key, prov);
  }
}

const gate = (s: string) => (/pulse/i.test(s) ? [ins("record_observation", { pulse: 88 })] : [{ class: "aside" as const, confidence: 0.9 }]);

async function refused(message: string | undefined) {
  const port = new RefusingFake();
  port.message = message;
  const b = clerkBoot(gate, { port });
  await b.rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Pulse 88.", source: "text" });
  await b.rt.settled();
  const notes = b.rt.views(DOC).flatMap((v) => v.notes.filter((x) => x.kind === "refusal").map((x) => x.text));
  await b.rt.stop();
  return notes;
}

describe("a refused write says why", () => {
  it("notes the hospital's own reason for a refused write", async () => {
    const notes = await refused("Record the patient's vitals before assigning. Missing temperature.");
    expect(notes.some((x) => /not done\. Record the patient's vitals before assigning\. Missing temperature\./.test(x))).toBe(true);
  });

  it("still says it was refused when the hospital gives no reason", async () => {
    const notes = await refused(undefined);
    expect(notes.some((x) => /not done\. The hospital refused it\./.test(x))).toBe(true);
  });
});
