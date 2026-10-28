import { loadPool } from "@hey-pisgah/cases";
import { readStream } from "@hey-pisgah/store";
import { describe, expect, it } from "vitest";
import { denyScan } from "../src/deny.js";
import { checkAfter, checkBefore, holds } from "../src/prediction.js";
import { ARMS, appTexts } from "../src/prompts.js";
import { STREAMS } from "../src/session.js";
import { UNKNOWN_ID } from "../src/unknown.js";
import { DESCRIPTIONS } from "../src/tools.js";
import { ENGINE_SEMANTICS } from "../src/views.js";
import { LEARNED, LONG, SHORT, eventId, evidence, hyp, pool, pred, session } from "./helpers.js";

const facts = (id: string) => pool().get(id)?.facts ?? null;
const H = (id: string, if_true: unknown, if_false: unknown) => ({ hypothesis_id: id, if_true, if_false }) as never;

describe("deny list over prompts and tool descriptions", () => {
  it("finds no denied term in any arm's prompt, kickoff, nudge, descriptions or schemas", () => {
    for (const arm of ARMS) expect(denyScan(appTexts(arm))).toEqual([]);
    expect(Object.keys(DESCRIPTIONS).length).toBe(18);
  });
  it("catches planted terms, including a Reasoning strength line", () => {
    const planted = ["Reasoning strength: 8.", "prepare the draft before sign-off", "family F1", "start it earlier"];
    expect(denyScan(planted.map((text, i) => ({ label: String(i), text }))).length).toBe(4);
  });
});

describe("engine semantics", () => {
  it("are published in the definition view, hashed with the tools and scanned with the prompts", () => {
    const s = session();
    const sem = s.definition().engine_semantics as string[];
    expect(sem).toEqual([...ENGINE_SEMANTICS]);
    expect(sem.some((l) => l.includes("if it has triggers, at least one of its triggers has fired"))).toBe(true);
    expect(sem.some((l) => l.includes("removing, adding or moving an edge never changes a trigger"))).toBe(true);
    expect(sem.some((l) => l.includes("prepare_document and that are not external"))).toBe(true);
    for (const arm of ARMS) expect(appTexts(arm).map((t) => t.label)).toContain("engine_semantics");
    expect(denyScan([{ label: "semantics", text: JSON.stringify(ENGINE_SEMANTICS) }])).toEqual([]);
    s.close();
  });
});

describe("uniform unknown_id", () => {
  it("answers the same object for a dev id, a reserved-shaped id and garbage on every id tool", () => {
    const s = session();
    const dev = loadPool("dev")[0]!.case_id;
    for (const id of [dev, "c-zz99zz99", "nonsense", 42]) {
      const answers = [
        s.timeline({ case_id: id as string, order: "occurred" }),
        s.record({ case_id: id as string, record_kind: "take_home_order" }),
        s.intervals({ case_ids: [LONG[0], id as string], from: { kind: "step.completed", step_id: "st05" }, to: { kind: "step.completed", step_id: "st16" }, clock: "occurred" }),
        s.queue({ case_id: id as string, at_min: 600 }),
        s.staff({ case_id: id as string, role: "nurse" }),
        s.getExperiment({ experiment_id: "x-12345678" }),
        s.validationReport({ proposal_id: "p-12345678" }),
        typeof id !== "string" ? UNKNOWN_ID : s.recordHypothesis({ statement: "s", mechanism: "m", subject_refs: [], competing: { none_identified_reason: "r" }, evidence: [...evidence().slice(0, 2), { event_id: "ev-00000000", case_id: id, stance: "context", note: "" }], if_true: pred("intervention_lt_control", 30), if_false: pred("no_difference", 10), refuted_if: "r" })
      ];
      const hyp = answers.pop()!;
      for (const a of answers) expect(JSON.stringify(a)).toBe(JSON.stringify(UNKNOWN_ID));
      if (typeof id === "string") expect(hyp).toEqual({ ...UNKNOWN_ID, field: "evidence[2]", detail: "The event_id is not an event of the case_id given with it in this pool." });
    }
    s.close();
  });
});

describe("record_hypothesis errors", () => {
  it("name the field that held an unknown id and never the id", () => {
    const s = session();
    const h1 = hyp(s);
    const base = { statement: "s", mechanism: "m", subject_refs: [], competing: { none_identified_reason: "r" }, evidence: evidence(), if_true: pred("intervention_lt_control", 30), if_false: pred("no_difference", 10), refuted_if: "r" };
    const wrongCase = [...evidence().slice(0, 2), { ...evidence()[2]!, case_id: LONG[1] }];
    const reserved = "c-zz99zz99";
    const answers = [
      s.recordHypothesis({ ...base, competing: [h1, "h-0ther5e5"] }),
      s.recordHypothesis({ ...base, revises: "h-0ther5e5" }),
      s.recordHypothesis({ ...base, evidence: wrongCase }),
      s.recordHypothesis({ ...base, if_false: pred("no_difference", 10, "post_signoff_wait_min", [LONG[0], reserved]) })
    ];
    expect(answers.map((a) => a.field)).toEqual(["competing[1]", "revises", "evidence[2]", "if_false.scope.cases[1]"]);
    for (const a of answers) {
      expect(a).toMatchObject(UNKNOWN_ID);
      expect(JSON.stringify(a)).not.toMatch(/h-0ther5e5|c-zz99zz99|ev-[0-9a-f]{8}|c-[0-9a-f]{8}/);
    }
    s.close();
  });
});

describe("investigation reads", () => {
  it("pages a timeline under the cap and wraps notes as untrusted_text", () => {
    const s = session();
    const c = pool().get(SHORT)!;
    const first = s.timeline({ case_id: SHORT, order: "recorded", limit: 20 });
    expect(first.returned).toBe(20);
    expect(first.next_offset).toBe(20);
    expect(JSON.stringify(first).length).toBeLessThan(12_500);
    const notes = s.timeline({ case_id: SHORT, order: "occurred", kinds: ["note.recorded"] }).items as { note: { untrusted_text: string } }[];
    expect(notes.length).toBe(c.notes.length);
    for (const n of notes) expect(Object.keys(n.note)).toEqual(["untrusted_text"]);
    expect(s.viewed.has(SHORT)).toBe(true);
    s.close();
  });
  it("computes intervals from the events, not from the model", () => {
    const s = session();
    const r = s.intervals({ case_ids: [...LONG], from: { kind: "step.completed", step_id: "st05" }, to: { kind: "step.completed", step_id: "st16" }, clock: "occurred" });
    const rows = r.rows as { case_id: string; minutes: number }[];
    for (const row of rows) {
      const ev = pool().get(row.case_id)!.events;
      const a = ev.find((e) => e.kind === "step.completed" && e.subject === "st05")!;
      const b = ev.find((e) => e.kind === "step.completed" && e.subject === "st16")!;
      expect(row.minutes).toBe(b.occurred_at - a.occurred_at);
    }
    s.close();
  });
});

describe("prediction check fixtures", () => {
  const cases = [...LONG];
  it("tells two disjoint predictions apart and leaves overlapping ones together", () => {
    const h1 = H("h-00000001", pred("intervention_lt_control", 30), pred("no_difference", 10));
    const h2 = H("h-00000002", pred("no_difference", 10), pred("intervention_lt_control", 30));
    const h3 = H("h-00000003", pred("intervention_lt_control", 5), pred("no_difference", 2));
    const b = checkBefore([h1, h2, h3], cases, facts);
    expect(b.speaks_to).toEqual(["h-00000001", "h-00000002", "h-00000003"]);
    expect(b.distinguishes).toEqual([["h-00000001", "h-00000002"]]);
    const deltas = Object.fromEntries(cases.map((c) => [c, { post_signoff_wait_min: -80 }]));
    const a = checkAfter([h1, h2, h3], b, cases, deltas, facts);
    expect(a.per_hypothesis).toEqual({ "h-00000001": { landed: "if_true" }, "h-00000002": { landed: "if_false" }, "h-00000003": { landed: "if_true" } });
    expect(a.contradicted).toEqual(["h-00000002"]);
  });
  it("reports inconclusive when the metric was not observed", () => {
    const h1 = H("h-00000001", pred("intervention_lt_control", 30), pred("no_difference", 10));
    const b = checkBefore([h1], cases, facts);
    const deltas = Object.fromEntries(cases.map((c) => [c, { post_signoff_wait_min: null }]));
    const a = checkAfter([h1], b, cases, deltas, facts);
    expect(a.per_hypothesis["h-00000001"]).toEqual({ landed: "inconclusive" });
    expect(a.contradicted).toEqual([]);
    expect(holds(pred("intervention_lt_control", 30) as never, cases, deltas, facts)).toBeNull();
  });
  it("reports inconclusive when the result falls between the two predictions", () => {
    const h1 = H("h-00000001", pred("intervention_lt_control", 30), pred("no_difference", 10));
    const deltas = Object.fromEntries(cases.map((c) => [c, { post_signoff_wait_min: -20 }]));
    const a = checkAfter([h1], checkBefore([h1], cases, facts), cases, deltas, facts);
    expect(a.per_hypothesis["h-00000001"]).toEqual({ landed: "inconclusive" });
    expect(a.contradicted).toEqual(["h-00000001"]);
  });
  it("scopes a prediction by condition over the case facts", () => {
    const byWard = { metric: "post_signoff_wait_min", comparison: "no_difference", tolerance_min: 5, scope: { condition: { fact: "ward_id", eq: "C" } } };
    const h = H("h-00000004", byWard, pred("intervention_lt_control", 30));
    expect(checkBefore([h], ["c-178cad1d"], facts).speaks_to).toEqual(["h-00000004"]);
  });
});

describe("hypothesis records", () => {
  it("hashes, stores and revises without editing the old record", () => {
    const s = session();
    const h1 = hyp(s);
    const h2 = hyp(s, { revises: h1, statement: "s2" });
    expect(s.hypotheses.get(h1)!.status).toBe("revised");
    expect(s.hypotheses.get(h2)!.revises).toBe(h1);
    const recs = readStream(s.o.storeRoot, STREAMS.hypotheses);
    expect(recs.filter((e) => e.record_type === "hypothesis.recorded").length).toBe(2);
    expect(recs.some((e) => e.record_type === "hypothesis.status_changed" && (e.payload as { status: string }).status === "revised")).toBe(true);
    s.close();
  });
  it("refuses evidence from one case, a tolerance over the cap and identical predictions", () => {
    const s = session();
    const one = [0, 1, 2].map(() => ({ event_id: eventId(LONG[0], "st05"), case_id: LONG[0], stance: "context", note: "" }));
    expect(s.recordHypothesis({ statement: "s", mechanism: "m", subject_refs: [], competing: { none_identified_reason: "r" }, evidence: one, if_true: pred("intervention_lt_control", 30), if_false: pred("no_difference", 10), refuted_if: "r" }).error).toBe("invalid_arguments");
    expect(() => hyp(s, { if_true: pred("intervention_lt_control", 2, "rework_events") })).not.toThrow();
    expect(s.recordHypothesis({ statement: "s", mechanism: "m", subject_refs: [], competing: { none_identified_reason: "r" }, evidence: evidence(), if_true: pred("intervention_lt_control", 9, "rework_events"), if_false: pred("no_difference", 1), refuted_if: "r" }).error).toBe("tolerance_cap");
    expect(s.recordHypothesis({ statement: "s", mechanism: "m", subject_refs: [], competing: { none_identified_reason: "r" }, evidence: evidence(), if_true: pred("no_difference", 10), if_false: pred("no_difference", 5), refuted_if: "r" }).error).toBe("invalid_arguments");
    s.close();
  });
  it("refuses a planted retain without a matching if_true and counts it", () => {
    const s = session();
    const h1 = hyp(s, { if_true: pred("intervention_gt_control", 30), if_false: pred("intervention_lt_control", 30) });
    const h2 = hyp(s, { competing: [h1] });
    expect(s.setStatus({ hypothesis_id: h1, status: "retained", experiment_ids: [], evidence_event_ids: [], note: "planted" }).error).toBe("status_refused");
    const x = s.runExperiment({ hypothesis_id: h1, distinguishes: [h2], base: { version: 1 }, ops: LEARNED, case_ids: [...LONG], note: "n" });
    expect(x.ok).toBe(true);
    expect(s.setStatus({ hypothesis_id: h1, status: "retained", experiment_ids: [x.experiment_id], evidence_event_ids: [], note: "planted" }).error).toBe("status_refused");
    expect(s.counters.say_do_mismatches).toBe(2);
    expect(s.hypotheses.get(h1)!.status).toBe("open");
    expect(s.setStatus({ hypothesis_id: h1, status: "rejected", experiment_ids: [x.experiment_id], evidence_event_ids: [], note: "landed if_false" }).ok).toBe(true);
    expect(s.setStatus({ hypothesis_id: h2, status: "retained", experiment_ids: [x.experiment_id], evidence_event_ids: [], note: "landed if_true" }).ok).toBe(true);
    const refused = readStream(s.o.storeRoot, STREAMS.hypotheses).filter((e) => e.record_type === "hypothesis.status_refused");
    expect(refused.length).toBe(2);
    s.close();
  });
});
