import { applyOperations } from "@hey-pisgah/workflow";
import { describe, expect, it } from "vitest";
import { fixtureDefinition } from "../../workflow/test/fixture.js";
import { BEHAVIOUR_UNCHANGED, behaviourNote, runDefinition } from "../src/index.js";
import { fixtureSchedule } from "./schedule-fixture.js";

const def = fixtureDefinition();
const changed = (ops: Parameters<typeof applyOperations>[1]) => { const a = applyOperations(def, ops); if (!a.ok) throw new Error("refused"); return a.definition; };
const run = (d: typeof def) => { const r = runDefinition(d, fixtureSchedule(1), { run_id: "run-be4a0001" }); if (r.outcome !== "ok") throw new Error("violation"); return r; };

describe("behaviour note", () => {
  it("says behaviour unchanged when the definition changed and every event log is identical", () => {
    const moved = changed([{ op: "add_soft_edge", from: { step: "st01" }, to: { step: "st06" }, gate: "start" }]);
    const c = run(def), i = run(moved);
    expect(i.version_hash).not.toBe(c.version_hash);
    const b = behaviourNote([c], [i]);
    expect(b).toEqual({ identical: [true], definition_changed: true, note: BEHAVIOUR_UNCHANGED });
  });

  it("gives no note when the logs differ or the definition is the same", () => {
    const c = run(def);
    const open = changed([{ op: "remove_soft_edge", edge_id: "e04" }, { op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st02" } } }]);
    expect(behaviourNote([c], [run(open)])).toMatchObject({ identical: [false], definition_changed: true, note: null });
    expect(behaviourNote([c], [run(def)])).toEqual({ identical: [true], definition_changed: false, note: null });
  });
});
