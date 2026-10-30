import { describe, expect, it } from "vitest";
import { ORDER_REFERENCE_KINDS } from "../src/emr/gate.js";
import type { EmrCommit, EmrWriteKind, Orderables, Provenance, ReadBack, WorkArgs } from "../src/emr/port.js";
import { OWNER_YES, READ_BACK_MM, READ_BACK_YES } from "../src/emr/runtime.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { ClerkFake, PAT, DOC, clerkBoot, ins } from "./clerking-helpers.js";

const ITEM_A = "dddddddd-1111-4222-8333-444444444444";
const ITEM_B = "eeeeeeee-1111-4222-8333-444444444444";
const TOKEN = (n: number) => `v2.${String(1_761_700_000_000 + n)}.${"N".repeat(22)}.${"A".repeat(43)}`;
const print = (who: string): Voiceprint => ({ vector: [who.length], ms: 20, model: "nemo_en_titanet_small" });
const OWNER_VOICE = print("owner"), STRANGER = print("x");

// A hospital that matches by the voiceprint's one number, reads back one order, and digests each write by its kind and test.
class BindingFake extends ClerkFake {
  readBackAnswer: ReadBack = { items: [{ stateId: ITEM_A, label: "Full Blood Count", kind: "lab", controlled: false, sentAt: "2026-10-30T10:00:00.000Z" }], itemsDigest: "a".repeat(64), readBackAt: "2026-10-30T10:05:00.000Z", seal: "S".repeat(43), awaitingSecond: [], changed: [] };
  private n = 0;
  override kindsFor(): readonly string[] { return [...ORDER_REFERENCE_KINDS]; }
  orderables(): Orderables { return { tests: { fbc: ["full blood count"], malaria: ["malaria"] }, drugs: { morphine: { words: ["morphine"], controlled: true } } }; }
  readonly speaker = async (_owner: string, v: readonly number[]): Promise<SpeakerVerdict> => { this.n += 1; return v[0] === 5 ? { speaker: "owner", token: TOKEN(this.n) } : { speaker: "unverified", reason: "no_match" }; };
  readonly readBack = async (): Promise<ReadBack> => this.readBackAnswer;
  // The batch digest the hospital holds now; a countersign of any other digest is refused, as the hospital refuses a changed batch.
  hospitalDigest: string | null = null;
  override async commit(kind: EmrWriteKind, args: WorkArgs, intentKey: string, prov: Provenance): Promise<EmrCommit> {
    if (kind === "countersign" && this.hospitalDigest && args["items_digest"] !== this.hospitalDigest) return { ok: false, reason: "door_409_conflict", status: 409, retryable: false, counted: false };
    return super.commit(kind, args, intentKey, prov);
  }
  voiceItem(kind: string, a: WorkArgs): string | null { return `${kind === "order_test" ? "1" : "2"}${String(a["test"] ?? a["drug"] ?? "").length}`.padEnd(64, "0"); }
}

function boot(script: Parameters<typeof clerkBoot>[0], clock?: { now: number }) {
  const port = new BindingFake();
  return { ...clerkBoot(script, { port, ...(clock ? { clock } : {}) }), port };
}
const sayAs = (rt: ReturnType<typeof clerkBoot>["rt"], text: string, voiceprint: Voiceprint) => rt.say({ owner: DOC, target: { patient_id: PAT }, text, source: "audio", voiceprint });
const orders = (port: BindingFake) => port.writes.filter((w) => w.kind === "order_test").map((w) => w.prov as Provenance);

describe("one spoken line names every order it authorised", () => {
  it("sends both tests of one owner line with the same sorted batch, and a one-test line with none", async () => {
    const { rt, port } = boot((s) => (s.includes("and a malaria") ? [ins("order_test", { test: "fbc" }), ins("order_test", { test: "malaria" })] : s.includes("blood count") ? [ins("order_test", { test: "fbc" })] : []));
    await sayAs(rt, "Send a full blood count and a malaria test.", OWNER_VOICE);
    await rt.settled();
    const two = orders(port);
    expect(two).toHaveLength(2);
    const want = [port.voiceItem("order_test", { test: "fbc" })!, port.voiceItem("order_test", { test: "malaria" })!].sort();
    expect(two.map((p) => p.voice?.batch)).toEqual([want, want]);
    expect(two[0]!.voice?.authorisation).toBe(two[1]!.voice?.authorisation);
    await sayAs(rt, "Send another full blood count.", OWNER_VOICE);
    await rt.settled();
    expect(orders(port)[2]!.voice?.batch).toBeUndefined();
    await rt.stop();
  });
});

describe("the owner's natural yes to a countersign read-back (G4's finding, the coordinator's ruling)", () => {
  it("reads the short confirmations as yes, and leaves the plain yes rule unchanged", () => {
    for (const t of ["go on", "yeah go on", "okay go on", "okay sign them", "yes go ahead", "sign those"]) expect(READ_BACK_YES.test(t), t).toBe(true);
    for (const t of ["go on doctor", "go on then tell me", "sign", "carry on", "right go on"]) expect(READ_BACK_YES.test(t), t).toBe(false);
    for (const t of ["mm", "mmm", "mhm", "mm hmm", "uh huh"]) expect(READ_BACK_MM.test(t), t).toBe(true);
    for (const t of ["m", "hmm", "mm no"]) expect(READ_BACK_MM.test(t), t).toBe(false);
    expect(OWNER_YES.test("go on")).toBe(false);
    // The acceptance rehearsal's "Yes, confirm the morphine": naming what is confirmed is still the strict word (30 Oct).
    for (const t of ["yes confirm the morphine", "confirm that one", "i confirm", "okay confirm it"]) expect(OWNER_YES.test(t), t).toBe(true);
    for (const t of ["confirm that she has no allergies", "can you confirm her weight", "yes confirm the dose with pharmacy please"]) expect(OWNER_YES.test(t), t).toBe(false);
  });

  for (const said of ["Go on.", "Yeah, go on.", "Okay, sign them.", "Mm."]) {
    it(`signs exactly the read-back's batch on the owner's "${said}"`, async () => {
      const { rt, port } = boot(() => []);
      await sayAs(rt, "Sign everything.", OWNER_VOICE);
      await rt.settled();
      await sayAs(rt, said, OWNER_VOICE);
      await rt.settled();
      const cs = port.writes.filter((w) => w.kind === "countersign");
      expect(cs).toHaveLength(1);
      expect(cs[0]!.args).toMatchObject({ item_ids: [ITEM_A], items_digest: "a".repeat(64), read_back_seal: "S".repeat(43) });
      await rt.stop();
    });
  }

  it("takes a bare mm only while the read-back is the last thing shown", async () => {
    const clock = { now: Date.now() };
    const { rt, port } = boot(() => [], clock);
    await sayAs(rt, "Sign everything.", OWNER_VOICE);
    await rt.settled();
    clock.now += 1000;
    // An unmatched voice's yes is refused with a note, so the read-back is no longer the last thing shown.
    await sayAs(rt, "Yes.", STRANGER);
    await rt.settled();
    clock.now += 1000;
    await sayAs(rt, "Mm.", OWNER_VOICE);
    await rt.settled();
    expect(port.writes.filter((w) => w.kind === "countersign")).toHaveLength(0);
    await sayAs(rt, "Yeah, go on.", OWNER_VOICE);
    await rt.settled();
    expect(port.writes.filter((w) => w.kind === "countersign")).toHaveLength(1);
    await rt.stop();
  });

  it("answers the later read-back only, with that batch's digest", async () => {
    const { rt, port } = boot(() => []);
    await sayAs(rt, "Sign everything.", OWNER_VOICE);
    await rt.settled();
    port.readBackAnswer = { ...port.readBackAnswer, items: [{ stateId: ITEM_B, label: "Urinalysis", kind: "lab", controlled: false, sentAt: null }], itemsDigest: "b".repeat(64) };
    await sayAs(rt, "Sign them all.", OWNER_VOICE);
    await rt.settled();
    await sayAs(rt, "Go on.", OWNER_VOICE);
    await rt.settled();
    const cs = port.writes.filter((w) => w.kind === "countersign");
    expect(cs.map((w) => w.args["items_digest"])).toEqual(["b".repeat(64)]);
    expect(cs[0]!.args["item_ids"]).toEqual([ITEM_B]);
    await rt.stop();
  });

  it("negative control: a confirmation after the batch changed in the hospital is refused and signs nothing", async () => {
    const { rt, port } = boot(() => []);
    await sayAs(rt, "Sign everything.", OWNER_VOICE);
    await rt.settled();
    port.hospitalDigest = "c".repeat(64);
    const yes = await sayAs(rt, "Yeah, go on.", OWNER_VOICE);
    await rt.settled();
    expect(port.writes.filter((w) => w.kind === "countersign")).toHaveLength(0);
    expect(rt.view(yes.task_id)!.actions.find((a) => a.kind === "countersign")?.state).not.toBe("completed");
    await rt.stop();
  });

  it("never takes go on as the confirmation of a controlled drug", async () => {
    const { rt, port } = boot((s) => (s.includes("morphine") ? [ins("prescribe", { drug: "morphine", dose: "5 mg" })] : []));
    await sayAs(rt, "Give morphine 5 mg IV, one dose.", OWNER_VOICE);
    await rt.settled();
    await sayAs(rt, "Yeah, go on.", OWNER_VOICE);
    await rt.settled();
    expect(port.writes.filter((w) => w.kind === "prescribe")).toHaveLength(0);
    await rt.stop();
  });

  it("never takes go on as the owner's yes to an order held for an unmatched voice", async () => {
    const { rt, port } = boot((s) => (s.includes("blood count") ? [ins("order_test", { test: "fbc" })] : []));
    const a = await sayAs(rt, "Send a full blood count.", STRANGER);
    await rt.settled();
    await sayAs(rt, "Go on.", OWNER_VOICE);
    await rt.settled();
    expect(port.writes.filter((w) => w.kind === "order_test")).toHaveLength(0);
    expect(rt.view(a.task_id)!.actions.find((x) => x.kind === "order_test")).toMatchObject({ state: "proposed", awaiting: "owner_voice" });
    await rt.stop();
  });

  it("does not take go on as a yes once the answer window has passed", async () => {
    const clock = { now: Date.now() };
    const { rt, port } = boot(() => [], clock);
    await sayAs(rt, "Sign everything.", OWNER_VOICE);
    await rt.settled();
    clock.now += 601_000;
    await sayAs(rt, "Go on.", OWNER_VOICE);
    await rt.settled();
    expect(port.writes.filter((w) => w.kind === "countersign")).toHaveLength(0);
    await rt.stop();
  });
});
