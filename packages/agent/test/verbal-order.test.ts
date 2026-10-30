import { describe, expect, it } from "vitest";
import type { Orderables } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { VERBAL_ORDER_KIND, verbalOrderSaid, type VerbalOrderables } from "../src/emr/verbal.js";
import { ClerkFake, PAT, VISIT, clerkBoot } from "./clerking-helpers.js";

const NURSE = "nurse-1";
const O: VerbalOrderables = {
  tests: { urinalysis: ["urinalysis"], fbc: ["full blood count", "fbc"] },
  drugs: { paracetamol_iv: { words: ["paracetamol"], controlled: false }, morphine: { words: ["morphine"], controlled: true } },
  issuers: { dr_edikan: { words: ["doctor edikan", "dr edikan"], label: "Dr Edikan" }, dr_ime: { words: ["doctor ime"], label: "Dr Ime" } },
};

// A ward where the nurse's agent may take verbal orders, and the hospital matches her own voice.
class Ward extends ClerkFake {
  override kindsFor(): readonly string[] { return [VERBAL_ORDER_KIND]; }
  orderables(): Orderables { return { tests: O.tests, drugs: O.drugs }; }
  verbalIssuers() { return O.issuers; }
  private t = 0;
  readonly speaker = async (_owner: string, v: readonly number[]): Promise<SpeakerVerdict> => {
    this.t += 1;
    if (v[0] === 8) return { speaker: "owner", token: `v2.${String(1_761_700_000_000 + this.t)}.${"A".repeat(22)}.${"B".repeat(43)}` };
    return v[0] === 2 ? { speaker: "other_clinician", label: "Dr Edikan", role: "doctor" } : { speaker: "unverified", reason: "no_match" };
  };
}
const vp = (n: number): Voiceprint => ({ vector: [n], ms: 20, model: "nemo_en_titanet_small" });
const said = (text: string, v: Voiceprint) => ({ owner: NURSE, target: { patient_id: PAT }, text, source: "audio" as const, voiceprint: v });

describe("a verbal order taken by its receiver", () => {
  it("reads one prescriber and one test or medicine with its full schedule from the read-back, and lists what is missing", () => {
    expect(verbalOrderSaid("Verbal order from Doctor Edikan, paracetamol 1 g IV three times a day for 2 days, read back.", O)).toEqual({
      args: { issuer: "dr_edikan", order_kind: "prescription", drug: "paracetamol_iv", dose: "1 g", frequency: 3, duration_days: 2, quantity: 6, route: "iv" }, issuer_label: "Dr Edikan" });
    expect(verbalOrderSaid("Telephone order from Dr Edikan, urinalysis now, reading it back.", O)).toEqual({ args: { issuer: "dr_edikan", order_kind: "lab", test: "urinalysis" }, issuer_label: "Dr Edikan" });
    expect(verbalOrderSaid("Verbal order from Doctor Edikan, urinalysis.", O)).toEqual({ missing: ["read_back"] });
    expect(verbalOrderSaid("Verbal order, urinalysis and a full blood count, read back.", O)).toEqual({ missing: ["issuer", "order"] });
    expect(verbalOrderSaid("Verbal order from Doctor Edikan, paracetamol, read back.", O)).toEqual({ missing: ["dose", "frequency", "duration", "quantity"] });
    expect(verbalOrderSaid("Give paracetamol 1 g now.", O)).toBeNull();
  });

  it("proposes the order on the nurse's own matched read-back with its token, holds an unmatched voice and refuses the doctor's voice reading it", async () => {
    const port = new Ward();
    const a = clerkBoot(() => [], { port });
    const own = await a.rt.say(said("Verbal order from Doctor Edikan, urinalysis now, read back.", vp(8)));
    await a.rt.settled();
    const w = port.writes.find((x) => x.kind === VERBAL_ORDER_KIND)!;
    expect(w.args).toMatchObject({ visit_id: VISIT, patient_id: PAT, issuer: "dr_edikan", order_kind: "lab", test: "urinalysis" });
    expect(w.prov.voice?.authorisation).toMatch(new RegExp(`^transcript:${own.line_id}~v2\\.`));
    const before = port.writes.length;
    const held = await a.rt.say(said("Verbal order from Doctor Ime, full blood count, read back.", vp(1)));
    await a.rt.settled();
    expect(port.writes.length).toBe(before);
    expect(a.rt.view(held.task_id)!.actions.find((x) => x.kind === VERBAL_ORDER_KIND && x.line_id === held.line_id)).toMatchObject({ state: "proposed", awaiting: "owner_voice" });
    await a.rt.say(said("Verbal order from Doctor Edikan, full blood count, read back again.", vp(2)));
    await a.rt.settled();
    expect(port.writes.length).toBe(before);
    // An incomplete one is never guessed at.
    await a.rt.say(said("Verbal order from Doctor Edikan, paracetamol, read back.", vp(8)));
    await a.rt.settled();
    expect(port.writes.length).toBe(before);
    expect(a.rt.view(own.task_id)!.notes.at(-1)!.text).toMatch(/^To take a verbal order I still need the dose, how often, for how many days, how much/);
    await a.rt.stop();
  });
});
