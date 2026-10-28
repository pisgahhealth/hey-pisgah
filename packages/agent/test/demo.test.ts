import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findCase } from "@hey-pisgah/cases";
import { loadV1, worldRules } from "@hey-pisgah/hospital";
import { readStream } from "@hey-pisgah/store";
import { Registry } from "@hey-pisgah/workflow";
import { DEMO_WORLDS, FIXTURE_CASES_DIR, caseWorldFile, parseCaseFile } from "../src/cases.js";
import { scriptedAgent } from "../src/mock.js";
import { HospitalPort } from "../src/port.js";
import { GOAL, OWNER, harness, ofType, tempRoot } from "./helpers.js";

const demoWorld = (id: string) => parseCaseFile(JSON.stringify(caseWorldFile(findCase(id)!.file, DEMO_WORLDS[id]!)));

describe("the step 6 world under Ward B r2", () => {
  it("adapts through a case exception the named role confirms, and the final then copies the dispense record", async () => {
    const root = tempRoot();
    const fv = demoWorld("c-2a14921a");
    const mock = scriptedAgent({ exception: { document_id: "discharge_summary", section_id: "medicines", source: { record_kind: "dispense_record", field_path: "items" }, role: "pharmacist" } });
    const h = harness(root, { cases: [fv], mock, runtime: { maxTurnsPerTick: 16 } });
    h.rt.start();
    const id = h.rt.openTask({ case_id: fv.case_id, goal: GOAL, owner: OWNER });
    await h.rt.settled(120_000);
    const port = h.rt.portFor(fv.case_id);
    expect(h.rt.projection(id).state).toBe("done");
    expect(ofType(root, id, "version.check_failed").length).toBe(0);
    const conf = readStream(root, `world/${fv.case_id}`).filter((e) => e.record_type === "case_exception.confirmed").map((e) => e.payload as { by: { kind: string; role: string; staff_id: string }; at: number });
    expect(conf.map((c) => [c.by.kind, c.by.role, c.by.staff_id])).toEqual([["person", "pharmacist", "p_01"]]);
    const fin = port.record(port.stageRecordId("discharge_summary", "final"))!;
    expect(fin.source_refs.map((s) => s.record_kind)).toContain("dispense_record");
    expect(fin.source_refs.map((s) => s.record_kind)).not.toContain("take_home_order");
    await h.close();
  }, 180_000);

});

describe("ward B r2 as data and the demo worlds", () => {
  it("shows r2 to get_ward_requirements only from its effective minute, and the engine sees the change", () => {
    const fv = demoWorld("c-2a14921a");
    const port = HospitalPort.open(tempRoot(), fv, Registry.load([loadV1()]), worldRules());
    expect(port.wardRequirements()).toMatchObject({ requirement_version: "r1", in_force_since_minute: 0 });
    port.advanceTo(599);
    expect(port.wardRequirements()["requirement_version"]).toBe("r1");
    port.advanceTo(600);
    const req = port.wardRequirements() as { requirement_version: string; in_force_since_minute: number; effective_from: string; procedure_text: { untrusted_text: string } };
    expect([req.requirement_version, req.in_force_since_minute, req.effective_from]).toEqual(["r2", 600, "2026-10-31"]);
    expect(req.procedure_text.untrusted_text).toMatch(/exactly as dispensed by pharmacy/);
    expect(port.events().some((e) => e.kind === "requirements.changed" && e.recorded_at === 600)).toBe(true);
    expect(port.run().events.some((e) => e.kind === "world.facts_changed" && e.occurred_at === 600)).toBe(true);
  });

  it("commits demo worlds that equal a fresh conversion of the generated demo cases", () => {
    for (const [id, spec] of Object.entries(DEMO_WORLDS)) {
      const committed = JSON.parse(readFileSync(`${FIXTURE_CASES_DIR}${id}.json`, "utf8")) as unknown;
      expect(committed).toEqual(caseWorldFile(findCase(id)!.file, spec));
    }
  });
});
