import { describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import { EmrRuntime } from "../src/emr/runtime.js";
import { LEVERS_OFF } from "../src/emr/speed.js";
import type { EmrCommit, Provenance, WorkArgs } from "../src/emr/port.js";
import { ClerkFake, DOC, PAT, ins } from "./clerking-helpers.js";
import { emrRoot, gater, until, type C } from "./emr-helpers.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("gathered emergency vitals behind an occupied write queue", () => {
  it("honours the later line's hold even after the old timer has queued its write", async () => {
    const holdMs = 800;
    let releasePrior!: () => void;
    const priorReleased = new Promise<void>((resolve) => { releasePrior = resolve; });
    let priorStarted = false;
    class BlockedPort extends ClerkFake {
      override kindsFor(): readonly string[] { return [...super.kindsFor(), "record_triage_vitals"]; }
      override async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
        if (kind === "record_clerking") {
          priorStarted = true;
          await priorReleased;
        }
        return super.commit(kind, args, key, prov);
      }
    }
    const root = emrRoot();
    const port = new BlockedPort();
    let rt: EmrRuntime | null = null;
    const client = new ModelClient({
      storeRoot: root,
      mode: "mock",
      taskStateOf: (id) => rt?.stateOf(id) ?? null,
      mock: gater((said) => (said === "Fever for three days."
        ? [{ class: "finding", section: "history", text: said, confidence: 0.99 }]
        : said === "Pulse 110."
          ? [ins("record_triage_vitals", { pulse: 110 })]
          : [ins("record_triage_vitals", { temp_c: 38.5 })]) as unknown as C[]),
    });
    rt = new EmrRuntime({
      storeRoot: root, client, port, holdMs, proofRetryMs: 1,
      speed: { ...LEVERS_OFF, proofBeside: true },
    });
    rt.start();
    try {
      const task = await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Fever for three days." });
      await until(() => priorStarted);
      await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Pulse 110." }, task.task_id);
      await until(() => rt!.view(task.task_id)!.actions.some((a) => a.kind === "record_triage_vitals"));
      await sleep(holdMs + 150);
      expect(port.writes.filter((w) => w.kind === "record_triage_vitals")).toHaveLength(0);
      await rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Temperature 38.5." }, task.task_id);
      await until(() => rt!.view(task.task_id)!.actions.some((a) => a.kind === "record_triage_vitals" && a.args["temp_c"] === "38.5"));
      expect(rt.view(task.task_id)!.actions.filter((a) => a.kind === "record_triage_vitals")).toHaveLength(1);
      const gatheredAt = Date.now();
      releasePrior();
      await sleep(100);
      expect(Date.now() - gatheredAt).toBeLessThan(holdMs);
      expect(port.writes.filter((w) => w.kind === "record_triage_vitals"), "the queued first-generation timer must not write the amended set before its fresh hold expires").toHaveLength(0);
      await rt.settled();
      expect(port.writes.filter((w) => w.kind === "record_triage_vitals").map((w) => w.args)).toEqual([
        expect.objectContaining({ pulse: 110, temp_c: "38.5" }),
      ]);
    } finally {
      releasePrior();
      await rt.stop();
    }
  });
});
