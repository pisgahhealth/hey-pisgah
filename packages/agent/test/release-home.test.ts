import { describe, expect, it } from "vitest";
import { gatePrompt, gateTool, denyHits } from "../src/emr/gate.js";
import type { PaperworkReadBack, Provenance } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { CONFIRM_KINDS } from "../src/emr/runtime.js";
import { ADMIT, ClerkFake, DOC, clerkBoot, ins } from "./clerking-helpers.js";

const TOKEN = (n: number) => `v1.${String(1_761_700_000_000 + n)}.${"A".repeat(43)}`;
const print = (n: number): Voiceprint => ({ vector: [n], ms: 20, model: "nemo_en_titanet_small" });
const OWNER = print(5), STRANGER = print(1);
const KINDS = ["record_observation", "record_note", "release_home"];
const PAPER: PaperworkReadBack = {
  digest: "d".repeat(64), diagnosis: "Acute appendicitis", dispensed: ["Paracetamol 10"],
  exceptions: ["Amoxicillin: prescribed 15, dispensed 10; the summary shows 10"], tests: { resulted: 1, total: 2 }, unsigned: 0
};

// The admitted patient's hospital, with a voice match by voiceprint and the paperwork it fills from the record.
class HomeFake extends ClerkFake {
  paper: PaperworkReadBack | null = PAPER;
  reads = 0;
  private n = 0;
  constructor() { super(); this.admitted = true; }
  override kindsFor(): readonly string[] { return KINDS; }
  readonly speaker = async (_o: string, v: readonly number[], _p: Provenance): Promise<SpeakerVerdict> => {
    this.n += 1;
    return v[0] === 5 ? { speaker: "owner", token: TOKEN(this.n) } : { speaker: "unverified", reason: "no_match" };
  };
  readonly readPaperwork = async (): Promise<PaperworkReadBack> => {
    this.reads += 1;
    if (!this.paper) throw new Error("no paperwork");
    return this.paper;
  };
}

function boot() {
  const port = new HomeFake();
  return { ...clerkBoot((s) => (/go home/i.test(s) ? [ins("release_home", { text: "rest and drink water" })] : []), { port }), port };
}
const say = (rt: ReturnType<typeof boot>["rt"], text: string, v: Voiceprint | null, task?: string) =>
  rt.say({ owner: DOC, target: { admission_id: ADMIT }, text, source: "audio", ...(v ? { voiceprint: v } : {}) }, task);

describe("discharge by voice behind the confirmation word", () => {
  it("keeps the gate's denied words out of the prompt and tool for an owner who may send a patient home", () => {
    const names = { page_targets: {}, clinics: {}, wards: {} };
    expect(gatePrompt(KINDS, names)).toContain("release_home:");
    expect(denyHits(`${gatePrompt(KINDS, names)}\n${JSON.stringify(gateTool(KINDS))}`)).toEqual([]);
    expect(CONFIRM_KINDS.has("release_home")).toBe(true);
  });

  it("reads the paperwork back, writes nothing on the instruction, and discharges only on the owner's matched confirm", async () => {
    const { rt, port } = boot();
    const a = await say(rt, "She can go home today, rest and drink water.", OWNER);
    await rt.settled();
    const v = rt.view(a.task_id)!;
    const act = v.actions.find((x) => x.kind === "release_home")!;
    expect(act).toMatchObject({ state: "proposed", awaiting: "confirm" });
    expect(port.reads).toBe(1);
    const q = v.questions.at(-1)!.text;
    expect(q).toContain("Diagnosis from the record: Acute appendicitis");
    expect(q).toContain("Medicines from the dispense record: Paracetamol 10");
    expect(q).toContain("prescribed 15, dispensed 10");
    expect(q).toContain("Say confirm to discharge");
    expect(port.writes.filter((w) => w.kind === "release_home")).toHaveLength(0);
    // Negative control: a voice the hospital cannot match says confirm, and nothing is written.
    await say(rt, "Confirm.", STRANGER, a.task_id);
    await rt.settled();
    expect(port.writes.filter((w) => w.kind === "release_home")).toHaveLength(0);
    // The owner's own confirm writes it, carrying that line's token and the digest of the paperwork read back.
    const yes = await say(rt, "Confirm.", OWNER, a.task_id);
    await rt.settled();
    const sent = port.writes.filter((w) => w.kind === "release_home");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.args).toMatchObject({ admission_id: ADMIT, primary_diagnosis: "Acute appendicitis", instructions: "rest and drink water" });
    expect(sent[0]!.prov.voice?.confirmation).toMatch(new RegExp(`^transcript:${yes.line_id}~v1\\.`));
    expect(sent[0]!.prov.voice?.authorisation).toMatch(new RegExp(`^transcript:${a.line_id}~v1\\.`));
    expect(sent[0]!.prov.read_back_digest).toBe("d".repeat(64));
    expect(sent[0]!.prov.evidence).toBe(`transcript:${a.line_id}`);
    expect(rt.view(a.task_id)!.actions.find((x) => x.kind === "release_home")!.state).toBe("completed");
    await rt.stop();
  });

  it("asks no confirmation when the record has no diagnosis, and writes nothing", async () => {
    const { rt, port } = boot();
    port.paper = { ...PAPER, diagnosis: null };
    const a = await say(rt, "He can go home.", OWNER);
    await rt.settled();
    await say(rt, "Confirm.", OWNER, a.task_id);
    await rt.settled();
    expect(port.writes.filter((w) => w.kind === "release_home")).toHaveLength(0);
    expect(rt.view(a.task_id)!.actions.find((x) => x.kind === "release_home")!.state).toBe("cancelled");
    await rt.stop();
  });
});
