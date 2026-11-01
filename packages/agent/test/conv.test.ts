import { describe, expect, it } from "vitest";
import { ORDER_REFERENCE_KINDS } from "../src/emr/gate.js";
import { EMERGENCY_KIND, IDENTITY_KIND, spelledName, identityFrom } from "../src/emr/entry.js";
import type { EmrCommit, EmrContext, EmrTarget, Orderables, Provenance, ReadBack, WorkArgs } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { openStream } from "@hey-pisgah/store";
import { summariseWork } from "../src/emr/work.js";
import { ADMIT, ClerkFake, DOC, PAT, VISIT, clerkBoot, ins, type W } from "./clerking-helpers.js";

// Lane CONV: the conversation fixes after the ACC2 review, each red before its fix.
const TOKEN = (n: number) => `v1.${String(1_761_700_000_000 + n)}.${"A".repeat(43)}`;
const print = (n: number): Voiceprint => ({ vector: [n], ms: 20, model: "nemo_en_titanet_small" });
const OWNER = print(5), DRB = print(4), STRANGER = print(1);
const ARRIVAL = "dddddddd-1111-4222-8333-444444444444", ARRIVAL_VISIT = "eeeeeeee-1111-4222-8333-444444444444";

// A doctor who orders, with a voice match (5 is the owner, 4 is Dr B) and two paracetamols the ear can mix up.
class ConvFake extends ClerkFake {
  private n = 0;
  // Loses the hospital's answer to a prescription, so the write is left uncertain.
  lose = false;
  noVisit = false;
  commits = 0;
  kinds: string[] = [...ORDER_REFERENCE_KINDS, EMERGENCY_KIND, IDENTITY_KIND, "record_triage_vitals"];
  readBackAnswer: ReadBack | null = null;
  override kindsFor(): readonly string[] { return this.kinds; }
  orderables(): Orderables {
    return { tests: {}, drugs: { paracetamol_iv: { words: ["IV paracetamol", "paracetamol IV"], controlled: false }, paracetamol_oral: { words: ["paracetamol tablets", "oral paracetamol"], controlled: false }, morphine: { words: ["morphine"], controlled: true } } };
  }
  readonly readBack = async (): Promise<ReadBack> => this.readBackAnswer!;
  // The unnamed arrival is saved as its own patient and visit, as the door answers.
  override async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    if (kind === "prescribe") this.commits += 1;
    if (kind === "prescribe" && this.lose) return { ok: false, reason: "timeout", status: null, retryable: true, counted: false };
    if (kind !== EMERGENCY_KIND) return super.commit(kind, args, key, prov);
    if (!this.writes.some((w) => w.key === key)) this.writes.push({ kind, args, key, prov, id: ARRIVAL });
    return { ok: true, record_id: ARRIVAL, record_version: 1, event_ids: [`patient:${ARRIVAL}`, ...(this.noVisit ? [] : [`visit:${ARRIVAL_VISIT}`])], replayed: false };
  }
  readonly speaker = async (_o: string, v: readonly number[], _p: Provenance): Promise<SpeakerVerdict> => {
    this.n += 1;
    return v[0] === 5 ? { speaker: "owner", token: TOKEN(this.n) } : v[0] === 4 ? { speaker: "other_clinician", label: "Dr B", role: "doctor" } as SpeakerVerdict : { speaker: "unverified", reason: "no_match" };
  };
  override async resolve(target: EmrTarget): Promise<EmrContext> {
    if (target.patient_id === PAT) return { admission_id: "", patient_id: PAT, visit_id: VISIT, label: "Emeka Obi", facts: { ward: null, bed: null }, keywords: [] };
    if (target.patient_id === ARRIVAL) return { admission_id: "", patient_id: ARRIVAL, visit_id: ARRIVAL_VISIT, label: "Unknown arrival 19:42", facts: { ward: null, bed: null }, keywords: [] };
    return super.resolve(target);
  }
}

function boot(script: (said: string) => W[]) {
  const port = new ConvFake();
  return { ...clerkBoot(script, { port }), port };
}
type Rt = ReturnType<typeof boot>["rt"];
const say = (rt: Rt, text: string, v: Voiceprint | null = OWNER, o: { task?: string; question_id?: string; typed?: boolean } = {}) =>
  rt.say({ owner: DOC, target: { patient_id: PAT }, text, source: o.typed ? "text" : "audio", ...(v ? { voiceprint: v } : {}), ...(o.question_id ? { question_id: o.question_id } : {}) }, o.task);
const rx = (port: ConvFake) => port.writes.filter((w) => w.kind === "prescribe");
const of = (port: ConvFake, kind: string) => port.writes.filter((w) => w.kind === kind);
// An emergency arrival opened by the device, then a line said on it.
async function arrival(b: ReturnType<typeof boot>) {
  const e = await b.rt.emergency(DOC, { text: "Hey Pisgah, emergency.", spoken_at: new Date(b.clock.now).toISOString(), args: { unidentified_ref: "Unknown arrival 19:42", reason: "Emergency arrival, opened by voice; reason not yet stated" } });
  await b.rt.settled();
  return e.task_id;
}
const sayOn = (rt: Rt, task: string, text: string, v: Voiceprint | null = OWNER, spoken_at?: string) =>
  rt.say({ owner: DOC, target: { patient_id: ARRIVAL }, text, source: "audio", ...(v ? { voiceprint: v } : {}), ...(spoken_at ? { spoken_at } : {}) }, task);

// Pass 10b's A10: the ear wrote "IV pay rasitamol", so the gate guessed the IV paracetamol and the medicine is asked, never guessed.
const ASIDE: W[] = [{ class: "aside", confidence: 0.9 }];
const A10 = "Give her IV pay rasitamol, one gram, eight hourly, for one day. That's three doses";
const gate = (s: string): W[] => {
  if (/pay rasitamol/.test(s)) return [ins("prescribe", { drug: "paracetamol_iv", dose: "1 g" })];
  if (/^Oral paracetamol 500 mg/.test(s)) return [ins("prescribe", { drug: "paracetamol_oral", dose: "500 mg", route: "oral" })];
  if (/paracetamol tablets/.test(s)) return [ins("prescribe", { drug: "paracetamol_oral", dose: "500 mg", route: "oral" })];
  if (/IV paracetamol/.test(s)) return [ins("prescribe", { drug: "paracetamol_iv" })];
  return ASIDE;
};

describe("CONV 0: the answer to which medicine is the owner's own request, through resumeWork", () => {
  it("holds an order a typed reply to which medicine finishes, and never sends it on the earlier line's voice", async () => {
    const { rt, port } = boot(gate);
    const a = await say(rt, A10);
    await rt.settled();
    const q = rt.view(a.task_id)!.questions.at(-1)!;
    expect(q.text).toMatch(/Which medicine should I prescribe/);
    await say(rt, "IV paracetamol.", null, { task: a.task_id, question_id: q.question_id, typed: true });
    await rt.settled();
    expect(rx(port)).toHaveLength(0);
    expect(rt.view(a.task_id)!.actions.find((x) => x.kind === "prescribe")).toMatchObject({ state: "proposed", awaiting: "owner_voice" });
    await rt.stop();
  });

  it("writes the dose and route the answer said, over the held line's", async () => {
    const { rt, port } = boot(gate);
    const a = await say(rt, A10);
    await rt.settled();
    const b = await say(rt, "Oral paracetamol 500 mg.");
    await rt.settled();
    expect(rx(port)).toHaveLength(1);
    expect(rx(port)[0]!.args).toMatchObject({ drug: "paracetamol_oral", dose: "500 mg", route: "oral" });
    expect(rx(port)[0]!.prov.voice?.authorisation).toContain(`transcript:${b.line_id}~`);
    const v = rt.view(a.task_id)!;
    expect(v.questions.filter((x) => /Which medicine/.test(x.text))).toEqual([]);
    await rt.stop();
  });

  it("writes a later take-home line as its own order while which medicine is still open", async () => {
    const { rt, port } = boot(gate);
    const a = await say(rt, A10);
    await rt.settled();
    // The acceptance script's A19 as the cleaned transcript reads it, said while A10's question is still open.
    const home = await say(rt, "Actually, give her oral paracetamol tablets to take home, 500 milligrams, three times a day for three days, quantity nine.");
    await rt.settled();
    expect(rx(port)).toHaveLength(1);
    expect(rx(port)[0]!.args).toMatchObject({ drug: "paracetamol_oral", dose: "500 mg", frequency: 3, duration_days: 3, quantity: 9, route: "oral" });
    expect(rt.view(a.task_id)!.actions.find((x) => x.kind === "prescribe")!.line_id).toBe(home.line_id);
    await rt.stop();
  });

  it("never finishes a question raised on Dr B's line with the owner's bare count", async () => {
    const { rt, port } = boot((s) => (/^IV paracetamol one gram/.test(s) ? [ins("prescribe", { drug: "paracetamol_iv", dose: "1 g" })] : ASIDE));
    const a = await say(rt, "IV paracetamol one gram.", DRB);
    await rt.settled();
    expect(rt.view(a.task_id)!.questions.some((q) => /How many/.test(q.text))).toBe(true);
    await say(rt, "Three.", OWNER, { task: a.task_id });
    await rt.settled();
    expect(rx(port)).toHaveLength(0);
    await rt.stop();
  });

  it("writes the quantity follow-up once after which medicine is answered", async () => {
    const { rt, port } = boot((s) => (/pay rasitamol/.test(s) ? [ins("prescribe", { drug: "paracetamol_iv", dose: "1 g" })] : /IV paracetamol/.test(s) ? [ins("prescribe", { drug: "paracetamol_iv" })] : ASIDE));
    const a = await say(rt, "Give her IV pay rasitamol, one gram, eight hourly.");
    await rt.settled();
    await say(rt, "IV paracetamol.", OWNER, { task: a.task_id });
    await rt.settled();
    expect(rx(port)).toHaveLength(0);
    expect(rt.view(a.task_id)!.questions.at(-1)!.text).toMatch(/How many should the pharmacy give for IV paracetamol/);
    await say(rt, "Three.", OWNER, { task: a.task_id });
    await rt.settled();
    await say(rt, "Three.", OWNER, { task: a.task_id });
    await rt.settled();
    expect(rx(port).map((w) => w.args)).toEqual([{ visit_id: VISIT, patient_id: PAT, drug: "paracetamol_iv", dose: "1 g", frequency: 3, quantity: 3, route: "iv" }]);
    await rt.stop();
  });
});

describe("CONV 1: the owner's agent writes the name said for an emergency arrival (D39)", () => {
  it("writes 'her name is Blessing Adeyemi' as one record_identity through the owner's agent, with no hand-off to the desk", async () => {
    const b = boot(() => ASIDE);
    const task = await arrival(b);
    await sayOn(b.rt, task, "Her name is Blessing Adeyemi.");
    await b.rt.settled();
    expect(of(b.port, IDENTITY_KIND).map((w) => w.args)).toEqual([{ visit_id: ARRIVAL_VISIT, patient_id: ARRIVAL, name: "Blessing Adeyemi" }]);
    expect(of(b.port, "delegate_task")).toHaveLength(0);
    const v = b.rt.view(task)!;
    expect(v.identities).toEqual([expect.objectContaining({ name: "Blessing Adeyemi", completes_by: "owner_agent", recorded_at: expect.any(String) })]);
    expect(v.notes.some((n) => /front desk/.test(n.text))).toBe(false);
    await b.rt.stop();
  });

  it("negative control: an owner without the kind keeps the hold for the front desk and writes no name", async () => {
    const b = boot(() => ASIDE);
    b.port.kinds = b.port.kinds.filter((k) => k !== IDENTITY_KIND);
    const task = await arrival(b);
    await sayOn(b.rt, task, "His name is Emeka Bassey.");
    await b.rt.settled();
    expect(of(b.port, IDENTITY_KIND)).toHaveLength(0);
    expect(b.rt.view(task)!.notes.some((n) => /^Name heard, held for the front desk to register, no phone yet\./.test(n.text))).toBe(true);
    await b.rt.stop();
  });

  it("takes the patient's own 'my name is', and never the owner's own voice saying it", async () => {
    const b = boot(() => ASIDE);
    const task = await arrival(b);
    await sayOn(b.rt, task, "My name is Uduak Etim, I am the doctor on call.", OWNER);
    await b.rt.settled();
    expect(of(b.port, IDENTITY_KIND)).toHaveLength(0);
    expect(b.rt.view(task)!.notes.some((n) => /your own voice/.test(n.text))).toBe(true);
    await sayOn(b.rt, task, "My name is Ngozi Okafor.", STRANGER);
    await b.rt.settled();
    expect(of(b.port, IDENTITY_KIND).map((w) => w.args["name"])).toEqual(["Ngozi Okafor"]);
    await b.rt.stop();
  });

  it("amends the name with a spelled correction, on the correcting line, with the earlier name kept", async () => {
    const b = boot(() => ASIDE);
    const task = await arrival(b);
    await sayOn(b.rt, task, "Her name is Blessing Adeyemu.");
    await b.rt.settled();
    const c = await sayOn(b.rt, task, "Adeyemi, spelt A-D-E-Y-E-M-I.");
    await b.rt.settled();
    expect(of(b.port, IDENTITY_KIND).map((w) => w.args["name"])).toEqual(["Blessing Adeyemu", "Blessing Adeyemi"]);
    const v = b.rt.view(task)!;
    const [first, second] = v.actions.filter((a) => a.kind === IDENTITY_KIND);
    expect(second).toMatchObject({ line_id: c.line_id, corrects_action_id: first!.action_id });
    expect(v.identities).toEqual([expect.objectContaining({ name: "Blessing Adeyemi", amended: [{ from: "Blessing Adeyemu", line_id: c.line_id }] })]);
    expect(spelledName("No, A D E Y E M I", "Blessing Adeyemu")).toEqual({ name: "Blessing Adeyemi" });
    expect(spelledName("Give IV fluids", "Blessing Adeyemu")).toBeNull();
    expect(identityFrom("Her name is Mrs Blessing Adeyemi")?.name).toBe("Blessing Adeyemi");
    await b.rt.stop();
  });

  it("on an emergency arrival before admission, the doctor's first vitals go to the triage row, later ones to the note (D32)", async () => {
    const b = boot((s) => (/pulse/i.test(s) ? [ins("record_observation", { pulse: 84, spo2: 97 })] : ASIDE));
    b.port.kinds = [...b.port.kinds, "record_clerking", "open_consult"];
    const task = await arrival(b);
    await sayOn(b.rt, task, "Pulse 84, sats 97.");
    await b.rt.settled();
    expect(of(b.port, "record_triage_vitals").map((w) => w.args)).toEqual([{ visit_id: ARRIVAL_VISIT, patient_id: ARRIVAL, pulse: 84, spo2: 97 }]);
    await sayOn(b.rt, task, "Pulse 84 again, sats 97.");
    await b.rt.settled();
    expect(of(b.port, "record_triage_vitals")).toHaveLength(1);
    await b.rt.stop();
  });
});

describe("SA-ENG 3: the identity summary names no one", () => {
  const NAMES = /Blessing|Adeyemi|Adebayo/i;
  it("keeps the name and the phone out of every record_identity summary, in the args only", async () => {
    expect(summariseWork(IDENTITY_KIND, { visit_id: ARRIVAL_VISIT, patient_id: ARRIVAL, name: "Blessing Adeyemi", phone: "08031234567" })).toBe("Name recorded for the arrival; the desk completes the registration");
    const b = boot(() => ASIDE);
    const task = await arrival(b);
    await sayOn(b.rt, task, "Her name is Blessing Adeyemi, her phone is 08031234567.");
    await b.rt.settled();
    await sayOn(b.rt, task, "Sorry, her name is Blessing Adebayo.");
    await b.rt.settled();
    const acts = b.rt.view(task)!.actions.filter((a) => a.kind === IDENTITY_KIND);
    expect(acts.length).toBeGreaterThanOrEqual(2);
    for (const a of acts) expect(a.summary, a.summary).not.toMatch(NAMES), expect(a.summary, a.summary).not.toMatch(/\d/);
    expect(of(b.port, IDENTITY_KIND).map((w) => w.args["name"])).toEqual(["Blessing Adeyemi", "Blessing Adebayo"]);
    await b.rt.stop();
  });
});

describe("SA-ENG 3b: identity notes and questions name no one (coordinator ruling)", () => {
  const NAMES = /Blessing|Adeyemi|Adebayo|Emeka|Bassey|Ada\b|Ade\b|Adu\b/i;
  // Every note and question the strip shows after the arrival opened.
  const shownSince = (b: ReturnType<typeof boot>, task: string, from: number) => { const v = b.rt.view(task)!; return [...v.notes.map((n) => n.text), ...v.questions.map((q) => q.text)].slice(from); };
  const before = (b: ReturnType<typeof boot>, task: string) => { const v = b.rt.view(task)!; return v.notes.length + v.questions.length; };
  it("writes, repeats and corrects a name with no name or digits in any note", async () => {
    const b = boot(() => ASIDE);
    const task = await arrival(b);
    const from = before(b, task);
    for (const line of ["Her name is Blessing Adeyemi, her phone is 08031234567.", "Her name is Blessing Adeyemi, her phone is 08031234567.", "Sorry, her name is Blessing Adebayo."]) { await sayOn(b.rt, task, line); await b.rt.settled(); }
    const shown = shownSince(b, task, from);
    expect(shown.some((x) => /^Already recorded/.test(x))).toBe(true);
    for (const x of shown) expect(x, x).not.toMatch(NAMES), expect(x, x).not.toMatch(/\d/);
    expect(b.rt.view(task)!.identities.at(-1)).toMatchObject({ name: "Blessing Adebayo" });
    await b.rt.stop();
  });

  it("holds a name for the front desk with no name or phone in the note", async () => {
    const b = boot(() => ASIDE);
    b.port.kinds = b.port.kinds.filter((k) => k !== IDENTITY_KIND);
    const task = await arrival(b);
    const from = before(b, task);
    await sayOn(b.rt, task, "His name is Emeka Bassey, his phone is 08031234567.");
    await b.rt.settled();
    const shown = shownSince(b, task, from);
    expect(shown.some((x) => /^Name heard, held for the front desk/.test(x))).toBe(true);
    for (const x of shown) expect(x, x).not.toMatch(NAMES), expect(x, x).not.toMatch(/\d/);
    expect(b.rt.view(task)!.identities.at(-1)).toMatchObject({ name: "Emeka Bassey", phone: "08031234567" });
    await b.rt.stop();
  });

  it("waits for the arrival's save with no name in the note", async () => {
    const b = boot(() => ASIDE);
    // The door's answer names the patient but not yet the visit, so the name waits.
    b.port.noVisit = true;
    const task = await arrival(b);
    const from = before(b, task);
    await sayOn(b.rt, task, "Her name is Blessing Adeyemi.");
    await b.rt.settled();
    const shown = shownSince(b, task, from);
    expect(shown.some((x) => /^Name heard\. I will record it once the arrival is saved\./.test(x))).toBe(true);
    for (const x of shown) expect(x, x).not.toMatch(NAMES);
    await b.rt.stop();
  });

  it("asks about an unclear spelling without naming either part", async () => {
    const b = boot(() => ASIDE);
    const task = await arrival(b);
    await sayOn(b.rt, task, "Her name is Ada Ade.");
    await b.rt.settled();
    const from = before(b, task);
    await sayOn(b.rt, task, "It is spelt A-D-U.");
    await b.rt.settled();
    const shown = shownSince(b, task, from);
    expect(shown.length).toBeGreaterThan(0);
    for (const x of shown) expect(x, x).not.toMatch(NAMES);
    await b.rt.stop();
  });
});

describe("CONV 1: read-backs whole, a longer yes after a refused match", () => {
  it("shows all nine long labels of a countersign read-back", async () => {
    const b = boot((s) => (/sign everything/i.test(s) ? [ins("countersign", {})] : ASIDE));
    const label = (i: number) => `${i}`.padEnd(120, "x");
    b.port.readBackAnswer = { items: Array.from({ length: 9 }, (_, i) => ({ stateId: `dddddddd-1111-4222-8333-44444444444${i}`, label: label(i), kind: "lab", controlled: false, sentAt: null })), itemsDigest: "a".repeat(64), readBackAt: "2026-10-29T10:05:00.000Z", seal: "S".repeat(43), awaitingSecond: [], changed: [] };
    const a = await say(b.rt, "Sign everything.");
    await b.rt.settled();
    const q = b.rt.view(a.task_id)!.questions.at(-1)!;
    for (let i = 0; i < 9; i++) expect(q.text).toContain(label(i));
    await b.rt.stop();
  });

  it("re-asks for a longer yes after an unmatched yes, and the owner's named yes past the first window sends once", async () => {
    const b = boot((s) => (/^Give morphine/.test(s) ? [ins("prescribe", { drug: "morphine", dose: "5 mg" })] : ASIDE));
    // Question times are the journal's own clock, so the window is shortened to 1 s rather than the clock moved.
    (b.rt as unknown as { o: { confirmWindowMs?: number } }).o.confirmWindowMs = 1000;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const now = () => new Date().toISOString();
    const a = await say(b.rt, "Give morphine 5 mg IV, one dose.");
    await b.rt.settled();
    await wait(600);
    await b.rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Yes.", source: "audio", voiceprint: STRANGER, spoken_at: now() }, a.task_id);
    await b.rt.settled();
    expect(rx(b.port)).toHaveLength(0);
    expect(b.rt.view(a.task_id)!.questions.at(-1)!.text).toMatch(/Say a longer yes that names it, such as "yes, go ahead with the morphine"/);
    await wait(700);
    await b.rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Yes, go ahead with the morphine.", source: "audio", voiceprint: OWNER, spoken_at: now() }, a.task_id);
    await b.rt.settled();
    expect(rx(b.port)).toHaveLength(1);
    await b.rt.stop();
  });
});

describe("CONV 2: a held order after a restart", () => {
  it("cancels a controlled order its pre-restart line authorised, says so, and sends nothing on the yes after the restart", async () => {
    const b = boot((s) => (/^Give morphine/.test(s) ? [ins("prescribe", { drug: "morphine", dose: "5 mg" })] : ASIDE));
    const a = await say(b.rt, "Give morphine 5 mg IV, one dose.");
    await b.rt.settled();
    expect(b.rt.view(a.task_id)!.actions.find((x) => x.kind === "prescribe")).toMatchObject({ state: "proposed", awaiting: "confirm" });
    await b.rt.stop();
    const again = clerkBoot((s) => (/^Give morphine/.test(s) ? [ins("prescribe", { drug: "morphine", dose: "5 mg" })] : ASIDE), { root: b.root, port: b.port, clock: b.clock });
    await again.rt.settled();
    await again.rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Yes, go ahead with the morphine.", source: "audio", voiceprint: OWNER }, a.task_id);
    await again.rt.settled();
    expect(rx(b.port)).toHaveLength(0);
    const v = again.rt.view(a.task_id)!;
    expect(v.actions.find((x) => x.kind === "prescribe")!.state).toBe("cancelled");
    expect(v.notes.some((n) => /did not survive the restart\. Say it again\./.test(n.text))).toBe(true);
    await again.rt.stop();
  });
});

describe("CONV 2: a ward vitals line names its screen", () => {
  it("attaches the stay page's vitals section to a record_observation, as every other kind does (lane SCR)", async () => {
    const b = boot((s) => (/^Pulse/.test(s) ? [ins("record_observation", { pulse: 88 })] : ASIDE));
    b.port.admitted = true;
    const a = await b.rt.say({ owner: DOC, target: { admission_id: ADMIT }, text: "Pulse 88.", source: "audio", voiceprint: OWNER });
    await b.rt.settled();
    expect(b.rt.task(a.task_id)!.actions.get(b.rt.task(a.task_id)!.order[0]!)).toMatchObject({ kind: "record_observation", screen: { page: "stay", section: "vitals", values: { pulse: "88" } } });
    await b.rt.stop();
  });
});

describe("CONV 2: no line ends in silence, and a bound answer ignores the window", () => {
  const notes = (rt: Rt, id: string) => rt.view(id)!.notes.map((n) => n.text);

  it("says so when the decision fails", async () => {
    const b = boot(() => []);
    const a = await say(b.rt, "Chart something unclear.");
    await b.rt.settled();
    expect(notes(b.rt, a.task_id)).toContain("I could not decide what that line asked for, so nothing was written from it. Say it again.");
    await b.rt.stop();
  });

  it("says so when a decision comes back after the task was paused", async () => {
    const b = boot((s) => (/blood count/.test(s) ? [ins("order_test", { test: "fbc" })] : ASIDE));
    const a = await say(b.rt, "Send a full blood count.");
    await say(b.rt, "Stop, I'll come back to this.");
    await b.rt.settled();
    expect(b.port.writes.filter((w) => w.kind === "order_test")).toHaveLength(0);
    expect(notes(b.rt, a.task_id).some((n) => /came while this task was paused, so nothing was written/.test(n))).toBe(true);
    await b.rt.stop();
  });

  it("says so when the agent restarted before deciding a line", async () => {
    const b = boot(() => ASIDE);
    const a = await say(b.rt, "Hello.");
    await b.rt.settled();
    await b.rt.stop();
    const st = openStream(b.root, `emr/${a.task_id}`, { writer: true });
    st.append("utterance.heard", { line_id: "u-lost0001", text: "Send a full blood count.", source: "text", spoken_at: new Date().toISOString() }, { recorded_at: 0, occurred_at: 0 });
    st.append("task.state_changed", { from: "done", to: "running", reason: "heard_u-lost0001" }, { recorded_at: 0, occurred_at: 0 });
    st.close();
    const again = clerkBoot(() => ASIDE, { root: b.root, port: b.port, clock: b.clock });
    await again.rt.settled();
    expect(again.rt.view(a.task_id)!.notes.map((n) => n.text)).toContain("The agent restarted before deciding your last line, so nothing was written from it. Say it again.");
    await again.rt.stop();
  });

  it("says so when the next instruction closes a question it did not name", async () => {
    const b = boot((s) => (/^Chart the thing/.test(s) ? [{ class: "unclear", confidence: 0.9, words: s, question: "Which thing do you mean?" }] : /blood count/.test(s) ? [ins("order_test", { test: "fbc" })] : ASIDE));
    const a = await say(b.rt, "Chart the thing.");
    await b.rt.settled();
    await say(b.rt, "Send a full blood count.");
    await b.rt.settled();
    expect(notes(b.rt, a.task_id)).toContain('Closed my question "Which thing do you mean?" when you went on.');
    await b.rt.stop();
  });

  it("a typed answer bound to its question finishes the request past the window, still held for the owner's voice", async () => {
    const b = boot((s) => (/^IV paracetamol one gram/.test(s) ? [ins("prescribe", { drug: "paracetamol_iv", dose: "1 g" })] : ASIDE));
    const a = await say(b.rt, "IV paracetamol one gram.");
    await b.rt.settled();
    const q = b.rt.view(a.task_id)!.questions.at(-1)!;
    expect(q.text).toMatch(/How many/);
    await b.rt.say({ owner: DOC, target: { patient_id: PAT }, text: "3", source: "text", question_id: q.question_id, spoken_at: new Date(Date.now() + 130_000).toISOString() }, a.task_id);
    await b.rt.settled();
    expect(b.rt.view(a.task_id)!.actions.find((x) => x.kind === "prescribe")).toMatchObject({ state: "proposed", awaiting: "owner_voice", args: { quantity: 3 } });
    await b.rt.stop();
  });
});

describe("CONV review fixes (codex review of ce4de52)", () => {
  it("1: the owner's bare count never releases a prescription Dr B asked about, though the owner's own question is open", async () => {
    const b = boot((s) => (/^Send a test/.test(s) ? [ins("order_test", {})] : /^IV paracetamol one gram/.test(s) ? [ins("prescribe", { drug: "paracetamol_iv", dose: "1 g" })] : ASIDE));
    const a = await say(b.rt, "Send a test.");
    await b.rt.settled();
    await say(b.rt, "IV paracetamol one gram.", DRB, { task: a.task_id });
    await b.rt.settled();
    expect(b.rt.view(a.task_id)!.questions.at(-1)!.text).toMatch(/How many/);
    await say(b.rt, "Three.", OWNER, { task: a.task_id });
    await b.rt.settled();
    expect(rx(b.port)).toHaveLength(0);
    await b.rt.stop();
  });

  it("4b: an uncertain prescription whose voice match a restart lost is read for once and never sent again", async () => {
    const b = boot((s) => (/^IV paracetamol one gram/.test(s) ? [ins("prescribe", { drug: "paracetamol_iv", dose: "1 g" })] : ASIDE));
    b.port.lose = true;
    const a = await say(b.rt, "IV paracetamol one gram, three doses.");
    await b.rt.settled();
    expect(b.rt.view(a.task_id)!.actions.find((x) => x.kind === "prescribe")!.state).toBe("uncertain");
    await b.rt.stop();
    const sent = b.port.commits;
    const again = clerkBoot(() => ASIDE, { root: b.root, port: b.port, clock: b.clock });
    await again.rt.settled();
    expect(b.port.commits).toBe(sent);
    const v = again.rt.view(a.task_id)!;
    expect(v.actions.find((x) => x.kind === "prescribe")!.state).toBe("cancelled");
    expect(v.notes.some((n) => /was not sent again\. Check the record/.test(n.text))).toBe(true);
    await again.rt.stop();
  });

  it("5: a spelling amends the part it names, and asks when two parts are as close", async () => {
    expect(spelledName("Bassey, spelt B-A-S-S-E-Y", "Blessing Bassei")).toEqual({ name: "Blessing Bassey" });
    expect(spelledName("spelt A-D-U", "Ada Ade")).toEqual({ ask: ["Ada", "Ade"], word: "Adu" });
    const b = boot(() => ASIDE);
    const task = await arrival(b);
    await sayOn(b.rt, task, "Her name is Ada Ade.");
    await b.rt.settled();
    await sayOn(b.rt, task, "It is spelt A-D-U.");
    await b.rt.settled();
    expect(of(b.port, IDENTITY_KIND).map((w) => w.args["name"])).toEqual(["Ada Ade"]);
    expect(b.rt.view(task)!.questions.at(-1)!.text).toBe("That spelling is as close to two parts of the name, so I did not change it. Say the full name.");
    await b.rt.stop();
  });

  it("7: a countersign yes after the 60 s window signs nothing and reads the batch back again", async () => {
    const b = boot(() => ASIDE);
    (b.rt as unknown as { o: { confirmWindowMs?: number } }).o.confirmWindowMs = 800;
    b.port.readBackAnswer = { items: [{ stateId: "dddddddd-1111-4222-8333-444444444441", label: "Full Blood Count", kind: "lab", controlled: false, sentAt: null }], itemsDigest: "a".repeat(64), readBackAt: "2026-10-29T10:05:00.000Z", seal: "S".repeat(43), awaitingSecond: [], changed: [] };
    const a = await say(b.rt, "Sign everything.");
    await b.rt.settled();
    const first = b.rt.view(a.task_id)!.questions.at(-1)!.question_id;
    await new Promise((r) => setTimeout(r, 900));
    // Question times are the journal's wall clock, so the yes is dated by it too.
    await b.rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Yes.", source: "audio", voiceprint: OWNER, spoken_at: new Date().toISOString() }, a.task_id);
    await b.rt.settled();
    expect(of(b.port, "countersign")).toHaveLength(0);
    const v = b.rt.view(a.task_id)!;
    expect(v.notes.some((n) => /^Not signed: that yes came more than 1 seconds after the read-back/.test(n.text))).toBe(true);
    expect(v.questions.at(-1)!.question_id).not.toBe(first);
    await b.rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Yes.", source: "audio", voiceprint: OWNER, spoken_at: new Date().toISOString() }, a.task_id);
    await b.rt.settled();
    expect(of(b.port, "countersign")).toHaveLength(1);
    await b.rt.stop();
  });

  it("8: a finding that comes back after a pause is said, never dropped", async () => {
    const b = boot((s) => (/^Chest/.test(s) ? [{ class: "finding", section: "examination", text: s, confidence: 0.9 }] : ASIDE));
    const a = await say(b.rt, "Chest is clear on both sides.");
    await say(b.rt, "Stop, I'll come back to this.");
    await b.rt.settled();
    expect(b.rt.view(a.task_id)!.notes.some((n) => /came while this task was paused/.test(n.text))).toBe(true);
    await b.rt.stop();
  });
});

describe("F6: a spelled surname always lands", () => {
  const A02S = "Let me spell her surname for you, A, D, E, Y, E, M, I, Adeyemi.";
  it("replaces the part the line names, whatever the distance", () => {
    expect(spelledName(A02S, "Blessing Adimi")).toEqual({ name: "Blessing Adeyemi" });
    expect(spelledName("Her surname is spelt O, K, O, R, O.", "Blessing Adimi")).toEqual({ name: "Blessing Okoro" });
    expect(spelledName("His last name, A-D-U.", "Ada Ade")).toEqual({ name: "Ada Adu" });
    expect(spelledName("Spell her first name, A, D, U.", "Ada Ade")).toEqual({ name: "Adu Ade" });
    expect(spelledName("Her first name is B, L, E, S, S, I, N, G.", "Plessing Adimi")).toEqual({ name: "Blessing Adimi" });
    expect(spelledName(A02S, "Blessing Adeyemi")).toBeNull();
  });

  it("with no part named, replaces the one part that shares the first letter, past two letters", () => {
    expect(spelledName("A, D, E, Y, E, M, I", "Blessing Adimi")).toEqual({ name: "Blessing Adeyemi" });
    expect(spelledName("Bassey, spelt B-A-S-S-E-Y", "Blessing Bassei")).toEqual({ name: "Blessing Bassey" });
  });

  it("still asks when two parts are candidates, or none is", () => {
    expect(spelledName("spelt A-D-U", "Ada Ade")).toEqual({ ask: ["Ada", "Ade"], word: "Adu" });
    expect(spelledName("spelt A, D, E, Y, E, M, I", "Ada Abu")).toEqual({ ask: ["Ada", "Abu"], word: "Adeyemi" });
    expect(spelledName("spelt O, K, O, R, O", "Blessing Adimi")).toEqual({ ask: [], word: "Okoro" });
    expect(spelledName("Her first name and her surname, spelt A, D, U.", "Ada Ade")).toEqual({ ask: ["Ada", "Ade"], word: "Adu" });
  });

  it("says it could not tell which part when no part is named and none shares the first letter", async () => {
    const b = boot(() => ASIDE);
    const task = await arrival(b);
    await sayOn(b.rt, task, "Her name is Blessing Adimi.");
    await b.rt.settled();
    await sayOn(b.rt, task, "It is spelt O, K, O, R, O.");
    await b.rt.settled();
    expect(of(b.port, IDENTITY_KIND).map((w) => w.args["name"])).toEqual(["Blessing Adimi"]);
    expect(b.rt.view(task)!.questions.at(-1)!.text).toBe("I could not tell which part of the name that spelling is for, so I did not change it. Say the full name, or say which part.");
    await b.rt.stop();
  });

  it("amends Adimi to Adeyemi on the record from A02S, and no note names her", async () => {
    const b = boot(() => ASIDE);
    const task = await arrival(b);
    await sayOn(b.rt, task, "She's talking small now. Her name na Blessing, Blessing Adimi.");
    await b.rt.settled();
    const v0 = b.rt.view(task)!, from = v0.notes.length + v0.questions.length;
    const c = await sayOn(b.rt, task, A02S);
    await b.rt.settled();
    expect(of(b.port, IDENTITY_KIND).map((w) => w.args["name"])).toEqual(["Blessing Adimi", "Blessing Adeyemi"]);
    const v = b.rt.view(task)!;
    expect(v.identities).toEqual([expect.objectContaining({ name: "Blessing Adeyemi", amended: [{ from: "Blessing Adimi", line_id: c.line_id }] })]);
    for (const x of [...v.notes.map((n) => n.text), ...v.questions.map((q) => q.text)].slice(from)) expect(x, x).not.toMatch(/Blessing|Adeyemi|Adimi/);
    await b.rt.stop();
  });
});
