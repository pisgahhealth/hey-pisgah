import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import { CLERKING_REFERENCE_KINDS, DIAGNOSIS_KIND, HOME_KIND, ORDER_REFERENCE_KINDS, ROUND_RULE, denyHits, gatePrompt, gateUtterance, type GateInput } from "../src/emr/gate.js";

// Acceptance pass 8 and 9, gap 8: the doctor's round entry on an admitted patient was heard as findings for the clerking note, so no progress note was written and the learning offer never fired.
const DOCTOR = [...ORDER_REFERENCE_KINDS, HOME_KIND, DIAGNOSIS_KIND];
const names = { page_targets: {}, clinics: {}, wards: {}, tests: {}, drugs: {} };
const input = (said: string, ward: string | null): GateInput => ({
  kinds: DOCTOR, names, today: "2026-10-31", openQuestion: null, recent: [], said,
  context: { admission_id: ward ? "11111111-2222-4333-8444-555555555555" : "", patient_id: "22222222-2222-4333-8444-555555555555", label: "ZZ-TEST Blessing", facts: { ward, bed: ward ? "A&E Bed 3" : null }, keywords: [] },
  actions: [{ n: 1, kind: "admit_patient", args: { ward: "A&E" }, state: ward ? "active" : "not recorded", corrects: null }]
});
// Three ways a doctor gives a round entry, none of them asking for a note.
const ROUNDS = [
  "On the round this morning, she is better, still febrile, continue the fluids.",
  "Reviewed her this morning. Fever settling, she's drinking well, plan home today if she stays well.",
  "She's much better today, no vomiting overnight, eating small small. We'll continue the fluids and see her again this evening."
];

describe("a round entry on an admitted patient is a progress note", () => {
  it("tells the gate, only when the owner can write a note, and the prompt still carries no denied term", () => {
    expect(gatePrompt([...CLERKING_REFERENCE_KINDS], names)).toContain(ROUND_RULE);
    expect(gatePrompt(DOCTOR, names)).toContain(ROUND_RULE);
    expect(gatePrompt([...CLERKING_REFERENCE_KINDS].filter((k) => k !== "record_note"), names)).not.toContain(ROUND_RULE);
    expect(denyHits(gatePrompt(DOCTOR, names))).toEqual([]);
  });

  // The real gate, on Modal: GATE_LIVE=1 with the model keys in the environment, three calls and two controls.
  it.skipIf(process.env["GATE_LIVE"] !== "1")("takes three natural round entries as record_note and leaves clerking findings and vitals as they were", { timeout: 120_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "hp-round-"));
    const client = new ModelClient({ storeRoot: root, mode: "live", recordingsDir: join(root, "recordings") });
    const meta = { run_id: "run-r0und000", task_id: "t-r0und000" };
    for (const said of ROUNDS) {
      const r = await gateUtterance(client, input(said, "ZZ-TEST A&E Ward"), meta);
      const kinds = r.value.clauses.map((c) => `${c.class}:${(c as { kind?: string | null }).kind ?? ""}`);
      expect(kinds, said).toContain("instruction:record_note");
    }
    // Before admission the same kind of words are clerking findings, and an admitted patient's vitals stay vitals.
    const before = await gateUtterance(client, input("Fever for three days, vomiting since this morning, about four times.", null), meta);
    expect(before.value.clauses.map((c) => c.class)).not.toContain("instruction");
    const vitals = await gateUtterance(client, input("Sats ninety six on room air, resp rate twenty two.", "ZZ-TEST A&E Ward"), meta);
    expect(vitals.value.clauses.map((c) => (c as { kind?: string | null }).kind)).toContain("record_observation");
    client.close();
  });
});
