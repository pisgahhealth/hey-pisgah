import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelClient, type ChatCompletion } from "@hey-pisgah/model";
import { computeFacts } from "../src/nightly/facts.js";
import { investigateDay, investigatorMessage, criticMessage, scanNightPrompts } from "../src/nightly/investigate.js";
import { composeMemo, payloadHash, type Investigation, type Memo } from "../src/nightly/memo.js";
import { alertHash, heldTransport, memoPublisher, sendOnVerdict } from "../src/nightly/publish.js";
import { plantedFaults } from "../src/nightly/faults.js";
import { repairFromRecords } from "../src/nightly/repair.js";
import { sourcesHash } from "../src/nightly/sources.js";
import type { DayEvent, NightSources } from "../src/nightly/sources.js";
import { checkMemo, verifyMemo } from "../src/nightly/verify.js";

let n = 0;
const ev = (case_id: string, kind: string, actor_id: string | null, actor_role: string | null, at: number, subject: string | null = null): DayEvent =>
  ({ event_id: `ev-${String(++n).padStart(8, "0")}`, case_id, kind, actor_id, actor_role, occurred_at: at, recorded_at: at, subject, payload: {} });
const E1 = "cccccccc-1111-4222-8333-000000000001", E2 = "cccccccc-1111-4222-8333-000000000002", E3 = "cccccccc-1111-4222-8333-000000000003";

// Two journeys, three open items (one overdue, one done), and three recipients; the names exist only for the checks.
function sources(): NightSources {
  n = 0;
  const c1 = [ev("c-1", "record.proved", "nurse_1_agent", "agent", 600), ev("c-1", "record.proved", "nurse_1_agent", "agent", 610), ev("c-1", "question.asked", "nurse_1_agent", "agent", 612), ev("c-1", "question.answered", "nurse_1", "nurse", 614),
    ev("c-1", "record.proved", "doctor_1_agent", "agent", 590), ev("c-1", "write.refused", "doctor_1_agent", "agent", 595), ev("c-1", "step.observed", "doctor_1_agent", "agent", 620, "st05"), ev("c-1", "step.observed", "accounts_clerk_1_agent", "agent", 670, "st13")];
  const c2 = [ev("c-2", "record.proved", "nurse_1_agent", "agent", 700), ev("c-2", "record.proved", "doctor_1_agent", "agent", 701), ev("c-2", "step.observed", "doctor_1_agent", "agent", 710, "st05"), ev("c-2", "step.observed", "accounts_clerk_1_agent", "agent", 770, "st13")];
  return {
    day: "2026-10-30", cases: [{ case_id: "c-1", ward_id: "A", events: c1 }, { case_id: "c-2", ward_id: "A", events: c2 }],
    open: [
      { item_id: "oi-1", encounter: E1, owner: "doc-1", department: "doctor", kind: "question", title: "How often should observations be done?", state: "open", due_at: null, refs: ["emr/t-1#12"] },
      { item_id: "oi-2", encounter: E2, owner: "doc-1", department: "doctor", kind: "obligation", title: "Review the abdomen", state: "held", due_at: "2026-10-30T10:00:00.000Z", refs: ["emr/t-2#7"] },
      { item_id: "oi-3", encounter: E3, owner: "doc-1", department: "doctor", kind: "action", title: "Add observations to the care plan", state: "done", due_at: null, refs: ["emr/t-3#9"] }
    ],
    recipients: [
      { id: "doc-1", role: "doctor", department: "doctor", incoming: false, authorised: [E1, E2, E3] },
      { id: "doc-3", role: "doctor", department: "doctor", incoming: true, authorised: [E1] },
      { id: "nurse-1", role: "nurse", department: "nurse", incoming: true, authorised: [] }
    ],
    labels: ["Ada Obi", "Bassey Etim"]
  };
}
const NOW = new Date("2026-10-30T23:00:00.000Z");
const doctorInv = (): Investigation[] => [{
  department: "doctor", nothing_warrants_change: false, model: null, calls: 0, cost_usd: 0,
  causes: [{ finding_id: "sc-doctor-1", department: "doctor", text: "The 1 refused write may come from a door rule the agent did not meet.", cites: ["f-doctor-writes_refused"], critic: { by: "nurse", verdict: "holds", reason: "one refusal is recorded" } }],
  changes: [{ finding_id: "pc-doctor-1", department: "doctor", text: "Show the refusal reason on the strip at once.", cites: ["f-doctor-writes_refused"], scope: "department", critic: null }]
}];
const memoFor = (s: NightSources, id: string, inv = doctorInv()): Memo => composeMemo(s, s.recipients.find((r) => r.id === id)!, computeFacts(s), inv, NOW);
const publisher = (s: NightSources, extra: Partial<Parameters<typeof memoPublisher>[0]> = {}) => { const t = heldTransport(); return { t, p: memoPublisher({ sources: s, transport: t, now: () => NOW, ...extra }) }; };

describe("the nightly memo: facts by rule, findings labelled, names never", () => {
  it("computes each department's figures from the events, with the events cited", () => {
    const f = computeFacts(sources());
    expect(f.find((x) => x.fact_id === "f-nurse-records_proved")).toMatchObject({ value: 3, text: "The nurse's agent proved 3 records by a fresh read across 2 journeys." });
    expect(f.find((x) => x.fact_id === "f-ward-signoff_to_cleared_median_min")).toMatchObject({ value: 55, refs: expect.arrayContaining(["ev-00000007", "ev-00000008"]) });
    expect(f.every((x) => x.refs.length > 0)).toBe(true);
  });

  it("delivers a supported memo: facts, a labelled suspected cause and proposed change, the owner's unfinished work with the overdue item urgent, and a preview with no patient", async () => {
    const s = sources();
    const m = memoFor(s, "doc-1");
    expect(m.unfinished.map((i) => [i.item_id, i.state, i.encounter])).toEqual([["oi-1", "open", E1], ["oi-2", "overdue", E2]]);
    expect(m.urgent.map((i) => i.item_id)).toEqual(["oi-2"]);
    expect(m.suspected_causes[0]!.label).toBe("suspected cause");
    expect(m.proposed_changes[0]!.label).toBe("proposed change");
    const { t, p } = publisher(s);
    const r = await p.publish(m);
    expect(r).toMatchObject({ status: "delivered", verdict: { status: "verified" }, repairs: 0 });
    // The overdue item reaches the bell at once as its own alert, then the memo.
    expect(t.sent.map((d) => [d.kind, d.preview])).toEqual([["urgent", "Urgent: a held task for you is overdue."], ["memo", "Night memo: 3 recorded facts, 2 unfinished items for you, 1 urgent."]]);
    // The urgent alert carries only its own item, and its hash is over that exact payload.
    expect(t.sent[0]!.body).toMatchObject({ items: [{ item_id: "oi-2", state: "overdue" }] });
    expect(t.sent[0]!.payload_hash).toBe(alertHash(t.sent[0]!.body));
    expect(t.sent[1]!.payload_hash).toBe(payloadHash(m));
  });

  it("names an encounter only to a recipient the record authorises for it; the same shift is not enough", async () => {
    const s = sources();
    const m = memoFor(s, "doc-3");
    expect(m.unfinished.map((i) => [i.item_id, i.encounter])).toEqual([["oi-1", E1], ["oi-2", null]]);
    expect((await publisher(s).p.publish(m)).status).toBe("delivered");
    const leaked = { ...m, unfinished: m.unfinished.map((i) => ({ ...i, encounter: i.item_id === "oi-2" ? E2 : i.encounter })) };
    expect(checkMemo(leaked, s).map((f) => f.code)).toContain("unauthorised_encounter");
    // The nurse sees the nurse's facts and the ward's, aggregate, and none of the doctors' items.
    const nurse = memoFor(s, "nurse-1", []);
    expect(nurse.unfinished).toEqual([]);
    expect(nurse.facts.every((f) => f.department === "nurse" || f.department === "ward")).toBe(true);
    expect(nurse.nothing_warrants_change).toBe(true);
    expect((await publisher(s).p.publish(nurse)).status).toBe("delivered");
  });

  it("refuses an invented figure in a fact or in a cause, withholds the memo, and still sends the open work as a checked task alert", async () => {
    const s = sources();
    const m = memoFor(s, "doc-1");
    const bad = { ...m, facts: m.facts.map((f) => (f.fact_id === "f-doctor-writes_refused" ? { ...f, value: 4 } : f)) };
    expect(checkMemo(bad, s)).toContainEqual(expect.objectContaining({ item: "f-doctor-writes_refused", code: "invented_figure" }));
    const prose = { ...m, suspected_causes: m.suspected_causes.map((c) => ({ ...c, text: "The 9 refused writes come from one door rule." })) };
    expect(checkMemo(prose, s)).toContainEqual(expect.objectContaining({ item: "sc-doctor-1", code: "invented_figure" }));
    const { t, p } = publisher(s);
    const r = await p.publish(bad);
    expect(r.status).toBe("withheld");
    expect(r.review?.unverified.map((f) => f.code)).toEqual(["invented_figure"]);
    expect(t.sent.map((d) => d.kind)).toEqual(["task"]);
    expect(t.sent[0]!.preview).toBe("Unfinished work: 2 items for you, 1 urgent.");
    expect(JSON.stringify(t.sent[0]!.body)).not.toContain("refused write");
  });

  it("refuses a false completion: an open item marked done, or left out as though finished", () => {
    const s = sources();
    const m = memoFor(s, "doc-1");
    const done = { ...m, unfinished: m.unfinished.map((i) => (i.item_id === "oi-1" ? { ...i, state: "done" as const } : i)) };
    expect(checkMemo(done, s).map((f) => f.code)).toContain("false_completion");
    const omitted = { ...m, unfinished: m.unfinished.filter((i) => i.item_id !== "oi-2"), urgent: [] };
    expect(checkMemo(omitted, s).map((f) => f.code)).toEqual(expect.arrayContaining(["missing_open_item", "missing_urgent"]));
    const revived = { ...m, unfinished: [...m.unfinished, { item_id: "oi-3", kind: "action", title: "x", state: "open" as const, due_at: null, refs: [], encounter: null, department: "doctor" }] };
    expect(checkMemo(revived, s).map((f) => f.code)).toContain("false_completion");
  });

  it("refuses a payload changed after its verdict, and a verdict made against older records", async () => {
    const s = sources();
    const m = memoFor(s, "doc-1");
    const v = verifyMemo(m, s);
    expect(v.status).toBe("verified");
    const t = heldTransport();
    const changed = { ...m, proposed_changes: [{ ...m.proposed_changes[0]!, text: "Stop asking the doctor anything." }] };
    expect(await sendOnVerdict(changed, v, t)).toEqual({ ok: false, reason: "payload_changed_after_verification" });
    expect(t.sent).toEqual([]);
    expect(await sendOnVerdict(m, v, t)).toMatchObject({ ok: true });
    const later = { ...s, open: [...s.open, { ...s.open[0]!, item_id: "oi-4" }] };
    expect(checkMemo(m, later).map((f) => f.code)).toContain("stale_sources");
  });

  it("treats a checker that breaks as a verifier error: nothing is published and nothing is called disproved", async () => {
    const s = sources();
    const { t, p } = publisher(s, { check: () => { throw new Error("records unreadable"); } });
    const r = await p.publish(memoFor(s, "doc-1"));
    expect(r).toMatchObject({ status: "withheld", verdict: { status: "verifier_error", error: "records unreadable" } });
    expect(t.sent).toEqual([]);
  });

  it("refuses a patient's name anywhere and an encounter in the preview", () => {
    const s = sources();
    const m = memoFor(s, "doc-1");
    const named = { ...m, proposed_changes: [{ ...m.proposed_changes[0]!, text: "Call Ada Obi's family." }] };
    expect(checkMemo(named, s).map((f) => f.code)).toContain("patient_name");
    expect(checkMemo({ ...m, preview: `Night memo for ${E1}` }, s).map((f) => f.code)).toContain("preview_leak");
  });

  it("repairs only the failing statements once, then publishes; a repair that does not clear them leaves the memo withheld", async () => {
    const s = sources();
    const m = memoFor(s, "doc-1");
    const bad = { ...m, suspected_causes: m.suspected_causes.map((c) => ({ ...c, text: "The 9 refused writes come from one door rule." })) };
    const drop = async (x: Memo, fs: readonly { item: string }[]) => ({ ...x, suspected_causes: x.suspected_causes.filter((c) => !fs.some((f) => f.item === c.finding_id)) });
    const ok = await publisher(s, { repair: drop }).p.publish(bad);
    expect(ok).toMatchObject({ status: "delivered", repairs: 1 });
    const stuck = await publisher(s, { repair: async (x) => x, maxRepairs: 1 }).p.publish(bad);
    expect(stuck).toMatchObject({ status: "withheld", repairs: 1 });
  });

  it("runs one investigator per department and a critic round with explicit effort, and its prompts pass the deny-list scan", async () => {
    const s = sources();
    const facts = computeFacts(s);
    const seen: { tool: string; effort: unknown }[] = [];
    const mock = ({ body, hash }: { body: Record<string, unknown>; hash: string }): ChatCompletion => {
      const tool = ((body["tools"] as { function: { name: string } }[])[0]!).function.name;
      seen.push({ tool, effort: body["reasoning_effort"] ?? (body["chat_template_args"] as Record<string, unknown> | undefined)?.["reasoning_effort"] ?? null });
      const user = String((body["messages"] as { role: string; content: string }[]).find((m) => m.role === "user")!.content);
      const dept = /Department(?: reviewed)?: ([a-z ]+)/.exec(user)![1]!.trim().replace(/ /g, "_");
      const args = tool === "report_department"
        ? { causes: [{ text: `The ${dept} figures show one pattern.`, cites: [`f-${dept}-records_proved`] }], changes: [], nothing_warrants_change: true }
        : { verdicts: [{ index: 0, verdict: "challenged", reason: "the cited count alone does not show a pattern" }] };
      return { id: `mock-${hash.slice(0, 8)}`, object: "chat.completion", created: 0, model: String(body["model"]), choices: [{ index: 0, finish_reason: "tool_calls", logprobs: null, message: { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "c1", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    };
    const root = mkdtempSync(join(tmpdir(), "hp-night-"));
    const client = new ModelClient({ storeRoot: root, mode: "mock", mock });
    try {
      const r = await investigateDay(facts, { client, provider: "modal", model: "meta-models/Muse-Spark-Open-816B-A42B", effort: "medium", run_id: "run-night001" });
      expect(r.investigations.map((i) => i.department)).toEqual(["accounts_clerk", "doctor", "nurse"].filter((d) => facts.some((f) => f.department === d)));
      expect(seen.filter((x) => x.tool === "report_department")).toHaveLength(r.investigations.length);
      expect(seen.filter((x) => x.tool === "review_causes").length).toBeGreaterThanOrEqual(2);
      expect(r.investigations.find((i) => i.department === "nurse")!.causes[0]!.critic).toMatchObject({ verdict: "challenged" });
      expect(seen.map((x) => x.effort)).toEqual(seen.map(() => "medium"));
      expect(scanNightPrompts(r.prompts)).toEqual([]);
      expect(scanNightPrompts([investigatorMessage("doctor", facts), criticMessage("doctor", doctorInv()[0]!.causes, facts)])).toEqual([]);
    } finally { client.close(); }
  });

  it("survives a night with no unfinished items: the faults that need an item are named not applicable, the rest are still refused (the review's crash)", async () => {
    const s = { ...sources(), open: [] };
    const memos = s.recipients.map((r) => memoFor(s, r.id));
    expect(memos.every((m) => m.unfinished.length === 0)).toBe(true);
    const f = await plantedFaults(s, memos, NOW);
    expect(f.not_applicable).toEqual(["false_completion", "altered_description", "altered_destination", "altered_due_date"]);
    expect(f).toMatchObject({ tried: 4, refused: 4 });
    // With open work every fault applies, the three altered item fields included, and each is refused.
    const full = sources();
    const all = await plantedFaults(full, full.recipients.map((r) => memoFor(full, r.id)), NOW);
    expect(all).toMatchObject({ tried: 8, refused: 8, not_applicable: [] });
    expect(all.cases).toMatchObject({ altered_description: "unsupported_or_incomplete", altered_destination: "unsupported_or_incomplete", altered_due_date: "unsupported_or_incomplete" });
    const none = await plantedFaults({ ...s, labels: [] }, memos, NOW);
    expect(none.cases["patient_name"]).toBe("unsupported_or_incomplete");
  });

  it("reads the records again right before sending: changed task wording or work finished meanwhile is caught, and the memo goes out rebuilt or not at all", async () => {
    const before = sources();
    const m = memoFor(before, "doc-1");
    // While the model wrote, a task was reworded and the overdue one was done.
    const after: NightSources = { ...before, open: before.open.map((i) => (i.item_id === "oi-1" ? { ...i, title: "How often should the pain score be done?" } : i.item_id === "oi-2" ? { ...i, state: "done" as const } : i)) };
    const stale = publisher(before, { refresh: () => after });
    const r1 = await stale.p.publish(m);
    expect(r1.refreshed).toMatchObject({ changed: true, from: sourcesHash(before), to: sourcesHash(after), recomposed: false });
    expect(r1.status).toBe("withheld");
    expect(r1.verdict.failures.map((f) => f.code)).toContain("stale_sources");
    expect(stale.t.sent.filter((d) => d.kind === "memo")).toHaveLength(0);
    const fresh = publisher(before, { refresh: () => after, recompose: (src, x) => composeMemo(src, src.recipients.find((r) => r.id === x.recipient_id)!, computeFacts(src), doctorInv(), NOW) });
    const r2 = await fresh.p.publish(m);
    expect(r2).toMatchObject({ status: "delivered", refreshed: { changed: true, recomposed: true } });
    const sent = fresh.t.sent.find((d) => d.kind === "memo")!.body as Memo;
    expect(sent.unfinished.map((i) => [i.item_id, i.title])).toEqual([["oi-1", "How often should the pain score be done?"]]);
    expect(fresh.t.sent.map((d) => d.kind)).toEqual(["memo"]);
    // Unchanged records publish as before, with the refresh recorded.
    const same = await publisher(before, { refresh: () => before }).p.publish(m);
    expect(same).toMatchObject({ status: "delivered", refreshed: { changed: false } });
  });

  it("treats a refresh that cannot read the records as a verifier error and sends nothing", async () => {
    const s = sources();
    const { t, p } = publisher(s, { refresh: () => { throw new Error("store unreadable"); } });
    const r = await p.publish(memoFor(s, "doc-1"));
    expect(r.verdict.status).toBe("verifier_error");
    expect(t.sent).toHaveLength(0);
  });

  it("repairs a memo once from the records: an unsupported figure in a cause is left out and the rest delivered; a fault the records carry is withheld with its reason", async () => {
    const s = sources();
    const bad = doctorInv();
    bad[0]!.causes.push({ finding_id: "sc-doctor-2", department: "doctor", text: "About 40 refusals a week come from the door.", cites: ["f-doctor-writes_refused"], critic: null });
    const dropped: { finding_id: string; code: string }[] = [];
    const { t, p } = publisher(s, { maxRepairs: 1, repair: repairFromRecords(s, bad, NOW, dropped as never) });
    const r = await p.publish(memoFor(s, "doc-1", bad));
    expect(r).toMatchObject({ status: "delivered", repairs: 1 });
    expect(dropped).toMatchObject([{ finding_id: "sc-doctor-2", code: "invented_figure" }]);
    expect(r.final.suspected_causes.map((c) => c.finding_id)).toEqual(["sc-doctor-1"]);
    expect((t.sent.find((d) => d.kind === "memo")!.body as Memo).suspected_causes).toHaveLength(1);
    // A name inside the records' own task wording cannot be repaired away, so the memo is withheld with that reason.
    const named: NightSources = { ...s, open: s.open.map((i) => (i.item_id === "oi-1" ? { ...i, title: "Ask Bassey Etim about observations" } : i)) };
    const w = await publisher(named, { maxRepairs: 1, repair: repairFromRecords(named, doctorInv(), NOW) }).p.publish(memoFor(named, "doc-1"));
    expect(w).toMatchObject({ status: "withheld", repairs: 1 });
    expect(w.verdict.failures.map((f) => f.code)).toContain("patient_name");
  });

  it("reads the records again right before every delivery: a task done after the urgent alert is not in the memo, and a withheld memo's task alert carries only work still open", async () => {
    const before = sources();
    const m = memoFor(before, "doc-1");
    // The urgent alert goes, then the question is answered before the memo is sent.
    const after: NightSources = { ...before, open: before.open.map((i) => (i.item_id === "oi-1" ? { ...i, state: "done" as const } : i)) };
    let reads = 0;
    const recompose = (src: NightSources, x: Memo) => composeMemo(src, src.recipients.find((r) => r.id === x.recipient_id)!, computeFacts(src), doctorInv(), NOW);
    const { t, p } = publisher(before, { refresh: () => (++reads <= 1 ? before : after), recompose });
    const r = await p.publish(m);
    expect(t.sent.map((d) => d.kind)).toEqual(["urgent", "memo"]);
    const sent = t.sent.find((d) => d.kind === "memo")!.body as Memo;
    expect(sent.unfinished.map((i) => i.item_id)).toEqual(["oi-2"]);
    expect(r.status).toBe("delivered");
    expect(reads).toBeGreaterThanOrEqual(2);
    // A withheld memo: the task alert is built from the records read right before it goes.
    const bad: Memo = { ...m, facts: m.facts.map((f, k) => (k === 0 ? { ...f, value: f.value + 7 } : f)) };
    let reads2 = 0;
    const w = publisher(before, { refresh: () => (++reads2 <= 0 ? before : after), recompose: (src, x) => ({ ...recompose(src, x), facts: bad.facts }) });
    const r2 = await w.p.publish(bad);
    expect(r2.status).toBe("withheld");
    const alert = w.t.sent.find((d) => d.kind === "task");
    expect(alert).toBeDefined();
    expect((alert!.body as { items: { item_id: string }[] }).items.map((i) => i.item_id)).toEqual(["oi-2"]);
  });

  it("binds each actionable item's description, destination and due date to the records: an altered one is refused even when its id and state match", () => {
    const s = sources();
    const m = memoFor(s, "doc-1");
    expect(checkMemo(m, s)).toEqual([]);
    const alter = (f: (i: Memo["unfinished"][number]) => Memo["unfinished"][number]): Memo => {
      const unfinished = m.unfinished.map((i) => (i.item_id === "oi-2" ? f(i) : i));
      return { ...m, unfinished, urgent: m.urgent.map((u) => unfinished.find((i) => i.item_id === u.item_id)!) };
    };
    const codes = (x: Memo) => checkMemo(x, s).map((f) => f.code);
    expect(codes(alter((i) => ({ ...i, title: "Review the chest" })))).toContain("altered_description");
    expect(codes(alter((i) => ({ ...i, kind: "question" })))).toContain("altered_description");
    expect(codes(alter((i) => ({ ...i, department: "nurse" })))).toContain("altered_destination");
    expect(codes(alter((i) => ({ ...i, due_at: "2026-10-31T10:00:00.000Z" })))).toContain("altered_due_date");
    expect(codes(alter((i) => ({ ...i, refs: ["emr/t-9#1"] })))).toContain("altered_description");
    // The item delivered to someone it is not for: the nurse is incoming but the item is the doctor's department's.
    const nurseMemo = memoFor(s, "nurse-1");
    const moved: Memo = { ...nurseMemo, unfinished: [{ ...m.unfinished[1]!, encounter: null }], urgent: [] };
    expect(checkMemo(moved, s).map((f) => f.code)).toContain("altered_destination");
    // A ward-bound item reaches an incoming recipient only when it is for a ward they cover.
    const warded: NightSources = { ...s, open: s.open.map((i) => (i.item_id === "oi-1" ? { ...i, ward: "ward-b" } : i)), recipients: s.recipients.map((r) => (r.id === "doc-3" ? { ...r, wards: ["ward-a"] } : r)) };
    const doc3 = memoFor(warded, "doc-3");
    expect(doc3.unfinished.map((i) => i.item_id)).toEqual(["oi-2"]);
    expect(checkMemo(doc3, warded)).toEqual([]);
    const smuggled: Memo = { ...doc3, unfinished: [...doc3.unfinished, { ...memoFor(warded, "doc-1").unfinished[0]!, encounter: E1 }] };
    expect(checkMemo(smuggled, warded).map((f) => f.code)).toContain("altered_destination");
    // An urgent entry must be the unfinished item itself, not a reworded copy.
    const urgentCopy: Memo = { ...m, urgent: m.urgent.map((u) => ({ ...u, title: "Review the chest" })) };
    expect(codes(urgentCopy)).toContain("altered_description");
  });

  it("each altered field is refused through the publisher too, with nothing delivered (negative controls)", async () => {
    const s = sources();
    const m = memoFor(s, "doc-1");
    const cases: [string, Memo][] = [
      ["altered_description", { ...m, unfinished: m.unfinished.map((i) => (i.item_id === "oi-1" ? { ...i, title: "Stop the observations" } : i)) }],
      ["altered_destination", { ...m, unfinished: m.unfinished.map((i) => (i.item_id === "oi-1" ? { ...i, department: "accounts_clerk" } : i)) }],
      ["altered_due_date", { ...m, unfinished: m.unfinished.map((i) => (i.item_id === "oi-1" ? { ...i, due_at: "2026-10-30T09:00:00.000Z" } : i)) }]
    ];
    for (const [code, x] of cases) {
      const { t, p } = publisher(s);
      const r = await p.publish(x);
      expect(r.verdict.failures.map((f) => f.code)).toContain(code);
      expect(t.sent.filter((d) => d.kind === "memo")).toHaveLength(0);
    }
  });
});
