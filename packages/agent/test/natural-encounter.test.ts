import { describe, expect, it } from "vitest";
import { EMERGENCY_KIND, IDENTITY_KIND, afterIdentity, identityFrom } from "../src/emr/entry.js";
import type { EmrCommit, EmrContext, EmrTarget, Provenance, WorkArgs } from "../src/emr/port.js";
import { ClerkFake, DOC, clerkBoot, ins, type W } from "./clerking-helpers.js";

const PATIENT = "dddddddd-1111-4222-8333-444444444444";
const VISIT = "eeeeeeee-1111-4222-8333-444444444444";
const OWNER = { vector: [5], ms: 20, model: "nemo_en_titanet_small" as const };
class Hospital extends ClerkFake {
  override kindsFor(): readonly string[] { return [...super.kindsFor(), EMERGENCY_KIND, IDENTITY_KIND, "record_triage_vitals", "order_test"]; }
  orderables() { return { tests: { fbc: ["FBC", "full blood count"] }, drugs: {} }; }
  async speaker() { return { speaker: "owner" as const, token: `v1.1761700000001.${"A".repeat(43)}` }; }
  override async resolve(_target: EmrTarget): Promise<EmrContext> {
    return { admission_id: "", patient_id: PATIENT, visit_id: VISIT, label: "Unknown arrival", facts: {}, keywords: [] };
  }
  override async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    const result = await super.commit(kind, args, key, prov);
    return kind === EMERGENCY_KIND ? { ok: true, record_id: PATIENT, record_version: 1, event_ids: [`visit:${VISIT}`], replayed: false } : result;
  }
}
const gate = (said: string): W[] => [
  ...(/pulse 110/i.test(said) ? [ins("record_triage_vitals", { words: "pulse 110", pulse: 110 })] : []),
  ...(/send FBC/i.test(said) ? [ins("order_test", { words: "send FBC", test: "fbc" })] : []),
];

describe("natural mixed instructions", () => {
  it("keeps the vitals and test after naming the arrival", async () => {
    const port = new Hospital();
    const b = clerkBoot(gate, { port });
    try {
      const task = await b.rt.emergency(DOC, { text: "Hey Pisgah, emergency", spoken_at: new Date().toISOString(), args: { unidentified_ref: "Unknown arrival", reason: "Emergency arrival" } });
      await b.rt.settled();
      const line = "Her name is Grace Okafor, pulse 110, send FBC";
      const heard = await b.rt.say({ owner: DOC, target: { patient_id: PATIENT }, text: line, source: "audio", voiceprint: OWNER }, task.task_id);
      await b.rt.settled();
      expect(port.writes.filter((w) => w.kind === IDENTITY_KIND)).toHaveLength(1);
      expect(port.writes.filter((w) => w.kind === "record_triage_vitals").map((w) => w.args.pulse)).toEqual([110]);
      expect(port.writes.filter((w) => w.kind === "order_test").map((w) => w.args.test)).toEqual(["fbc"]);
      expect(b.rt.view(task.task_id)!.transcript.find((l) => l.id === heard.line_id)?.text).toBe(line);
    } finally { await b.rt.stop(); }
  });

  it("retains instructions before a naming phrase and after a phone", () => {
    const said = "Pulse 110. Her name is Grace Okafor, phone 08031234567, send FBC";
    const rest = afterIdentity(said, identityFrom(said)!);
    expect(rest).toContain("Pulse 110");
    expect(rest).toContain("send FBC");
    expect(rest).not.toContain("08031234567");
  });
  it("keeps the clinical clauses on the first emergency line", async () => {
    const port = new Hospital();
    const b = clerkBoot(gate, { port });
    try {
      const heard = await b.rt.say({ owner: DOC, target: {}, text: "Hey Pisgah, emergency, her name is Grace Okafor, pulse 110, send FBC", source: "audio", voiceprint: OWNER });
      await b.rt.settled();
      expect(port.writes.filter((w) => w.kind === EMERGENCY_KIND)).toHaveLength(1);
      expect(port.writes.filter((w) => w.kind === IDENTITY_KIND)).toHaveLength(1);
      expect(port.writes.filter((w) => w.kind === "record_triage_vitals").map((w) => w.args.pulse)).toEqual([110]);
      expect(port.writes.filter((w) => w.kind === "order_test").map((w) => w.args.test)).toEqual(["fbc"]);
      expect(b.rt.view(heard.task_id)!.patient_id).toBe(PATIENT);
    } finally { await b.rt.stop(); }
  });

  it("retains an unclear order across unrelated work and restart, then uses its answer", async () => {
    const port = new Hospital();
    const script = (said: string): W[] => said === "Send a blood test" ? [{ class: "unclear", kind: "order_test", words: said, question: "Which blood test?" }] : said === "FBC" ? [ins("order_test", { words: said, test: "fbc" })] : gate(said).length ? gate(said) : [{ class: "aside", words: said }];
    const first = clerkBoot(script, { port });
    const said = { owner: DOC, target: { patient_id: PATIENT }, source: "audio" as const, voiceprint: OWNER };
    const a = await first.rt.say({ ...said, text: "Send a blood test" });
    await first.rt.settled();
    await first.rt.say({ ...said, text: "Yes" }, a.task_id);
    await first.rt.say({ ...said, text: "Pulse 110" }, a.task_id);
    await first.rt.settled();
    expect(first.rt.view(a.task_id)!.questions.map((q) => q.text)).toContain("Which blood test?");
    expect(port.writes.filter((w) => w.kind === "order_test")).toHaveLength(0);
    await first.rt.stop();
    first.client.close();
    const second = clerkBoot(script, { port, root: first.root, clock: first.clock });
    try {
      await second.rt.say({ ...said, text: "FBC" }, a.task_id);
      await second.rt.settled();
      expect(port.writes.filter((w) => w.kind === "order_test").map((w) => w.args.test)).toEqual(["fbc"]);
      expect(second.rt.view(a.task_id)!.questions).toHaveLength(0);
    } finally { await second.rt.stop(); }
  });

  it("does not mark an unidentified request answered by unrelated vitals", async () => {
    const port = new Hospital();
    const b = clerkBoot((s) => s === "Send it" ? [{ class: "unclear", words: s, question: "What should I send?" }] : gate(s), { port });
    try {
      const a = await b.rt.say({ owner: DOC, target: { patient_id: PATIENT }, text: "Send it", source: "audio", voiceprint: OWNER });
      await b.rt.settled();
      await b.rt.say({ owner: DOC, target: { patient_id: PATIENT }, text: "Pulse 110", source: "audio", voiceprint: OWNER }, a.task_id);
      await b.rt.settled();
      expect(b.rt.view(a.task_id)!.questions.map((q) => q.text)).toContain("What should I send?");
    } finally { await b.rt.stop(); }
  });

  it("shows interrupted arrival continuations after restart without replaying their authority", async () => {
    const port = new Hospital();
    const first = clerkBoot(gate, { port });
    const task = await first.rt.emergency(DOC, { text: "Hey Pisgah, emergency, pulse 110, send FBC", spoken_at: new Date().toISOString(), args: { unidentified_ref: "Unknown arrival", reason: "Emergency arrival" } });
    first.rt.holdArrivalContinuation(DOC, task.task_id);
    await first.rt.settled();
    await first.rt.stop();
    first.client.close();
    const second = clerkBoot(gate, { port, root: first.root });
    try {
      await second.rt.settled();
      expect(second.rt.view(task.task_id)!.notes.some((n) => /interrupted by restart/.test(n.text))).toBe(true);
      expect(port.writes.filter((w) => w.kind === "order_test" || w.kind === "record_triage_vitals")).toHaveLength(0);
      expect(second.rt.task(task.task_id)!.continuations).toEqual([expect.objectContaining({ state: "dropped" })]);
    } finally { await second.rt.stop(); }
  });

  it.each(["unclear", "instruction"] as const)("does not let an uncertain %s answer release a pending order", async (answerClass) => {
    const port = new Hospital();
    const b = clerkBoot((text) => text === "Send a blood test" ? [{ words: text, class: "unclear", kind: "order_test", question: "Which blood test?" }] : [{ words: text, class: answerClass, kind: "order_test", test: "fbc", confidence: 0.1, question: "Did you mean FBC?" }], { port });
    try {
      const input = { owner: DOC, target: { patient_id: PATIENT }, source: "audio" as const, voiceprint: OWNER };
      const task = await b.rt.say({ ...input, text: "Send a blood test" });
      await b.rt.settled();
      await b.rt.say({ ...input, text: "FBC" }, task.task_id);
      await b.rt.settled();
      expect(port.writes.filter((w) => w.kind === "order_test")).toHaveLength(0);
      expect(b.rt.view(task.task_id)!.questions.map((q) => q.text)).toContain("Which blood test?");
    } finally { await b.rt.stop(); }
  });

});
