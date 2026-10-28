import { describe, expect, it } from "vitest";
import { MAX_KEYWORDS, VITALS_KEYWORDS, buildKeywords, cleanTranscript, continuesNumber, danglingEnd, numbersIn, readVitals, vitalsVocabulary } from "../src/index.js";

// Lines Voice Transcribe returned in the first real-mic session on a laptop (28 Oct 2026), as the serve store kept them.
const REAL = {
  cutBefore: "uh the temperature is about",
  cutAfter: "there is 7.6.",
  polls: "the polls polls is 88.",
  harris: "Harris Bridge reaches 18. Hmm.",
  pause: "Oh well, okay, I think I haven't made a mistake. Actually the pause was 92, not 88."
};

describe("vitals vocabulary pass", () => {
  it("reads the misheard pulse and respiratory rate as guesses, never as plain words", () => {
    const p = vitalsVocabulary(cleanTranscript(REAL.polls));
    expect(p.text).toBe("the pulse is 88.");
    expect(p.rewrites).toEqual([{ from: "polls", to: "pulse", measure: "pulse", guessed: true }]);
    expect(vitalsVocabulary(cleanTranscript(REAL.pause)).text).toContain("Actually the pulse was 92, not 88.");
    const h = vitalsVocabulary(REAL.harris);
    expect(h.text).toBe("respiratory rate reaches 18. Hmm.");
    expect(h.rewrites[0]).toMatchObject({ measure: "resp_rate", guessed: true });
    expect(readVitals(h.text)).toEqual({ resp_rate: ["18"] });
  });

  it("expands ward abbreviations without guessing, and leaves words alone when no number follows", () => {
    const v = vitalsVocabulary("RR 18, sats 97, BP 120 over 80, temp 37.2, resp rate 20");
    expect(v.text).toBe("respiratory rate 18, SpO2 97, blood pressure 120 over 80, temperature 37.2, respiratory rate 20");
    expect(v.rewrites.every((r) => !r.guessed)).toBe(true);
    expect(readVitals(v.text)).toEqual({ resp_rate: ["18", "20"], spo2: ["97"], bp: ["120/80"], temp_c: ["37.2"] });
    expect(vitalsVocabulary("Stop, I'll pause here and the polls closed early.").rewrites).toEqual([]);
    expect(vitalsVocabulary(REAL.harris, { guesses: false }).text).toBe(REAL.harris);
  });

  it("puts vitals words first in the hints, inside the six-word cap, ahead of a full list", () => {
    const docs = Array.from({ length: 150 }, (_, i) => `document ${i}`);
    const k = buildKeywords({ vitals: VITALS_KEYWORDS, wards: [], documents: docs, staff: [], beds: [] });
    expect(k.slice(0, VITALS_KEYWORDS.length)).toEqual([...VITALS_KEYWORDS]);
    expect(k).toHaveLength(MAX_KEYWORDS);
    expect(k.every((x) => x.split(" ").length <= 6)).toBe(true);
  });
});

describe("where a listen cut may fall", () => {
  it("knows a line that stops where a value must follow", () => {
    expect(danglingEnd(cleanTranscript(REAL.cutBefore))).toBe("strong");
    expect(danglingEnd(cleanTranscript("Temperature thirty-seven point"))).toBe("strong");
    expect(danglingEnd("Blood pressure 128 over")).toBe("strong");
    expect(danglingEnd("Chart the pulse")).toBe("strong");
    expect(danglingEnd("Chart pulse 96.")).toBe("number");
    expect(danglingEnd(vitalsVocabulary(REAL.harris).text)).toBe("number");
    expect(danglingEnd("I'm a better surgeon than I was 10 years ago")).toBeNull();
    expect(danglingEnd("Good morning, Charlie.")).toBeNull();
    expect(danglingEnd(REAL.cutAfter)).toBeNull();
  });

  it("knows a next line that carries a number on", () => {
    expect(continuesNumber("six.")).toBe(true);
    expect(continuesNumber(cleanTranscript("point six"))).toBe(true);
    expect(continuesNumber("over 80")).toBe(true);
    expect(continuesNumber("Emeka, the coffee machine is broken.")).toBe(false);
    expect(numbersIn("blood pressure 128/76, pulse 96.")).toEqual(["128", "76", "96"]);
  });
});
