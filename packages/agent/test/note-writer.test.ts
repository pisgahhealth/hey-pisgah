import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelClient, ModelError, type ChatCompletion, type MockResponder } from "@hey-pisgah/model";
import { NOTE_PROMPT, NOTE_SECTIONS, coveredByNote, faithful, noteMessage, noteTool, noteWrites, writeNote, type NoteOutput, type SaidLine } from "../src/emr/note-writer.js";
import { denyHits } from "../src/emr/gate.js";
import { addressSwap, cleanNoteText, sourceClause } from "../src/emr/work.js";

// Samuel's 3 Nov 14:36 emergency, as the store kept the long line; the opening line is the clause the gate kept from it.
const OPENING = "she's about she looks about 30 years old uh she was brought in with high fever and a bit of confusion.";
const LONG = "how you feeling how you feeling ah doctor I've been having fever for three days I've been vomiting I tried to take medication but today when I went to the market to buy some things I fell off I fainted doctor okay that's fine don't worry we're going to take care of you is there any medicine that you're allergic to doctor I think penicillin okay that's fine just lie down I'll have to do an examination for you real quick you're quite pale open your eyes for me please okay you look febrile and a bit drowsy well really drowsy your neck is also not stiff well my initial diagnosis for you is that you have severe malaria okay what we'll do now is to send a request to the lab Nurse please come take a sample the lab needs to do a full blood count test the malaria parasite test and urinalysis okay and also get stats on IV paracetamol 120 milligrams please get to the pharmacy and get that maybe do it for 12 hours and then we observe her again also give her paracetamol one gram y";
const LINES: SaidLine[] = [
  { text: OPENING, at: "2026-11-03T13:36:51.400Z", speaker: { speaker: "unverified", reason: "no_match" } },
  { text: LONG, at: "2026-11-03T13:37:34.420Z", speaker: { speaker: "unverified", reason: "mixed_speakers" } }
];
// The 07:37 run's examination, where the neck was stiff.
const EXAM_0737 = "you look pretty pale and it seems like you're also drowsy and febrile your neck too is a bit stiff";

// The recorded model answer for the 14:36 encounter, in the note tool's shape.
const GOOD: NoteOutput = {
  presenting_complaint: { text: "High fever and mild confusion", from: ["brought in with high fever and a bit of confusion"] },
  history: { text: "Three days of fever and vomiting; tried unspecified medication; fainted at the market today.", from: ["I've been having fever for three days I've been vomiting I tried to take medication but today when I went to the market to buy some things I fell off I fainted"] },
  allergies: { text: "Penicillin (patient unsure)", from: ["I think penicillin"] },
  examination: { text: "Pale, febrile, very drowsy; neck not stiff.", from: ["you're quite pale", "you look febrile and a bit drowsy well really drowsy", "your neck is also not stiff"] },
  assessment: { text: "Severe malaria", from: ["my initial diagnosis for you is that you have severe malaria"] }
};

const reply = (args: unknown, hash: string, model: string): ChatCompletion => ({
  id: `rec-${hash.slice(0, 12)}`, object: "chat.completion", created: 0, model,
  choices: [{ index: 0, finish_reason: "tool_calls", logprobs: null, message: { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "note", arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 1400, completion_tokens: 700, total_tokens: 2100 }
});
const recorded = (answer: unknown, seen: Record<string, unknown>[] = []): MockResponder => ({ body, hash }) => { seen.push(body); return reply(answer, hash, String(body["model"])); };
const clientWith = (mock: MockResponder) => new ModelClient({ storeRoot: mkdtempSync(join(tmpdir(), "hp-note-")), mode: "mock", mock });
const meta = { run_id: "run-note0001", task_id: "t-note0001" };
const one = (section: keyof NoteOutput, v: { text: string; from: string[] }): NoteOutput => ({ ...Object.fromEntries(NOTE_SECTIONS.map((s) => [s, null])), [section]: v }) as NoteOutput;

describe("the clinician's note from the encounter's said lines", () => {
  it("writes Samuel's 14:36 encounter in clinical register with nothing refused", async () => {
    const seen: Record<string, unknown>[] = [];
    const r = await writeNote(clientWith(recorded(GOOD, seen)), LINES, meta);
    expect(r.error).toBeNull();
    for (const s of NOTE_SECTIONS) expect(r.sections[s].refused).toEqual([]);
    expect(r.sections.presenting_complaint.text).toBe("High fever and mild confusion");
    expect(r.sections.history.text).toBe("Three days of fever and vomiting; tried unspecified medication; fainted at the market today.");
    expect(r.sections.allergies.text).toBe("Penicillin (patient unsure)");
    expect(r.sections.examination.text).toBe("Pale, febrile, very drowsy; neck not stiff.");
    expect(r.sections.assessment.text).toBe("Severe malaria");
    // The gate's route, effort and one structured tool, with the said lines as untrusted data and their times and voices.
    expect(seen[0]).toMatchObject({ model: "meta-models/Muse-Spark-Open-816B-A42B" });
    expect(JSON.stringify(seen[0]!["tools"])).toContain("\"note\"");
    expect(noteMessage(LINES)).toContain("13:37:34");
    expect(noteMessage(LINES)).toContain("more than one voice");
    expect(noteMessage(LINES)).toContain("untrusted_text");
    expect(r.cost_usd).toBeGreaterThan(0);
    expect(r.model).toBe("meta-models/Muse-Spark-Open-816B-A42B");
  });

  it("no section of the accepted note holds an order, a drug given now, or chatter", async () => {
    const r = await writeNote(clientWith(recorded(GOOD)), LINES, meta);
    const all = NOTE_SECTIONS.map((s) => r.sections[s].text ?? "").join(" | ");
    for (const w of [/paracetamol/i, /\bIV\b/, /\b120\b/, /urinalysis/i, /blood count/i, /\blab\b/i, /pharmacy/i, /don't worry/i, /open your eyes/i, /\bnurse\b/i, /\byou\b/i, /\bI\b/, /\bokay\b/i]) expect(all).not.toMatch(w);
  });

  it("refuses the 14:36 defect, the whole line pasted into a section", () => {
    const why = faithful("history", LONG, [LONG], LINES).join();
    for (const r of [/chatter "don't worry"/, /chatter "nurse"/, /person "i've"/, /order word lab/, /dose in note text/, /drug paracetamol not said|order word iv/]) expect(why).toMatch(r);
    expect(faithful("assessment", LONG, [LONG], LINES).join()).toMatch(/drug paracetamol in assessment/);
  });

  it("refuses a section whose number is not in the source words", () => {
    expect(faithful("history", "Five days of fever and vomiting", ["I've been having fever for three days I've been vomiting"], LINES)).toContain("number 5 not said");
  });

  it("refuses a section whose unit is not in the source words", () => {
    expect(faithful("history", "Three hours of fever", ["I've been having fever for three days"], LINES)).toContain("unit hour not said");
  });

  it("refuses a dropped negation and an added one", () => {
    expect(faithful("examination", "Neck stiff", ["your neck is also not stiff"], LINES).join()).toMatch(/stiff/);
    const exam0737: SaidLine[] = [{ text: EXAM_0737, at: "2026-11-03T06:39:00.000Z", speaker: { speaker: "owner", reason: null } }];
    expect(faithful("examination", "Pale, drowsy, febrile; neck not stiff", ["you look pretty pale", "you're also drowsy and febrile", "your neck too is a bit stiff"], exam0737).join()).toMatch(/stiff/);
    expect(faithful("examination", "Pale, drowsy, febrile; neck mildly stiff", ["you look pretty pale", "you're also drowsy and febrile", "your neck too is a bit stiff"], exam0737)).toEqual([]);
    expect(faithful("history", "Denies vomiting", ["I've been vomiting"], LINES).join()).toMatch(/vomit/);
  });

  it("refuses a finding that was never said", () => {
    expect(faithful("examination", "Pale, jaundiced, febrile", ["you're quite pale", "you look febrile and a bit drowsy"], LINES).join()).toMatch(/jaundiced/);
  });

  it("refuses words that are not in the said lines", () => {
    expect(faithful("assessment", "Severe malaria", ["the diagnosis is severe malaria"], LINES).join()).toMatch(/not in the said lines/);
  });

  it("refuses dropped or added doubt", () => {
    expect(faithful("allergies", "Penicillin", ["I think penicillin"], LINES).join()).toMatch(/doubt/);
    expect(faithful("assessment", "Possible severe malaria", ["my initial diagnosis for you is that you have severe malaria"], LINES).join()).toMatch(/doubt/);
  });

  it("refuses a drug, a dose or an order in note text, and a drug outside allergies and history", () => {
    const from = ["also get stats on IV paracetamol 120 milligrams please get to the pharmacy"];
    expect(faithful("assessment", "Severe malaria; IV paracetamol 120 mg", ["my initial diagnosis for you is that you have severe malaria", ...from], LINES).join()).toMatch(/dose|drug|order/);
    expect(faithful("examination", "Paracetamol", ["IV paracetamol 120 milligrams"], LINES).join()).toMatch(/drug paracetamol/);
    expect(faithful("history", "Full blood count sent", ["the lab needs to do a full blood count test"], LINES).join()).toMatch(/order/);
  });

  it("refuses chatter to the patient or staff and any first or second person", () => {
    expect(faithful("examination", "Pale; open your eyes", ["you're quite pale open your eyes for me please"], LINES).join()).toMatch(/chatter|person/);
    expect(faithful("history", "Don't worry, fever for three days", ["don't worry", "I've been having fever for three days"], LINES).join()).toMatch(/chatter/);
    expect(faithful("history", "I've been vomiting", ["I've been vomiting"], LINES).join()).toMatch(/person/);
  });

  it("the writer drops a refused section and keeps the faithful ones, so the caller writes its clause text there", async () => {
    const bad: NoteOutput = { ...GOOD, examination: { text: "Pale, febrile, drowsy; neck stiff", from: GOOD.examination!.from }, assessment: { text: "Severe malaria; IV paracetamol 120 mg started", from: [...GOOD.assessment!.from, "IV paracetamol 120 milligrams"] } };
    const r = await writeNote(clientWith(recorded(bad)), LINES, meta);
    expect(r.sections.examination.text).toBeNull();
    expect(r.sections.examination.proposed).toBe("Pale, febrile, drowsy; neck stiff");
    expect(r.sections.examination.refused.length).toBeGreaterThan(0);
    expect(r.sections.assessment.text).toBeNull();
    expect(r.sections.history.text).toBe(GOOD.history!.text);
    // The caller's own clause path for the refused examination keeps the source meaning, negation included.
    const clause = sourceClause("your neck is also not stiff", "you look febrile; your neck is also not stiff.");
    expect(addressSwap(cleanNoteText(clause!))).toBe("Neck is also not stiff.");
  });

  it("a model failure refuses every section without throwing, after the fallback route", async () => {
    const inner = clientWith(recorded(GOOD));
    const failing = Object.create(inner) as ModelClient;
    const providers: string[] = [];
    failing.call = async (args) => { providers.push(args.provider); throw new ModelError("provider_error", "down", { provider: args.provider }); };
    const r = await writeNote(failing, LINES, meta);
    expect(providers).toEqual(["modal", "meta"]);
    expect(r.error).toMatch(/provider_error/);
    for (const s of NOTE_SECTIONS) expect(r.sections[s]).toMatchObject({ text: null, refused: ["model_unavailable"] });
  });

  it("a section the model leaves null is absent, not refused", async () => {
    const r = await writeNote(clientWith(recorded(one("assessment", GOOD.assessment!))), LINES, meta);
    expect(r.sections.history).toMatchObject({ text: null, refused: [], proposed: null });
    expect(r.sections.assessment.text).toBe("Severe malaria");
  });

  it("gives the record's clerking writes and says which of the gate's clauses the note stands in for", async () => {
    const r = await writeNote(clientWith(recorded(GOOD)), LINES, meta);
    expect(noteWrites(r)).toEqual([
      { section: "presenting_complaint", text: "High fever and mild confusion" },
      { section: "history", text: GOOD.history!.text },
      { section: "history", text: "Allergies: Penicillin (patient unsure)" },
      { section: "examination", text: "Pale, febrile, very drowsy; neck not stiff." },
      { section: "assessment", text: "Severe malaria" }
    ]);
    // The 14:36 gate's clause words: each the note covers is replaced, and the age the note left out keeps today's clause path.
    expect(coveredByNote(r, "I've been having fever for three days I've been vomiting I tried to take medication but today when I went to the market to buy some things I fell off I fainted")).toBe(true);
    expect(coveredByNote(r, "I think penicillin")).toBe(true);
    expect(coveredByNote(r, "you're quite pale open your eyes for me please okay you look febrile and a bit drowsy well really drowsy your neck is also not stiff")).toBe(true);
    expect(coveredByNote(r, "she's about she looks about 30 years old")).toBe(false);
    const refused = await writeNote(clientWith(recorded({ ...GOOD, examination: { text: "Neck stiff", from: GOOD.examination!.from } })), LINES, meta);
    expect(coveredByNote(refused, "your neck is also not stiff")).toBe(false);
    expect(noteWrites(refused).map((w) => w.section)).not.toContain("examination");
  });

  it("the note prompt and tool hold no denied term and ask for strict JSON", () => {
    expect(denyHits(`${NOTE_PROMPT}\n${JSON.stringify(noteTool())}`)).toEqual([]);
    expect(JSON.stringify(noteTool())).toContain("additionalProperties");
  });
});
