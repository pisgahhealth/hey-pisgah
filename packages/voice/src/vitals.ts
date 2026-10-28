export const MEASURES = ["temp_c", "pulse", "resp_rate", "bp", "spo2"] as const;
export type Measure = (typeof MEASURES)[number];

// Vitals words first in the recognition hints, so the six-word cap and the hint limit never push them out.
export const VITALS_KEYWORDS = [
  "respiratory rate", "resp rate", "pulse", "temperature", "blood pressure", "SpO2", "sats", "point", "over", "degrees", "per minute"
] as const;

export type Rewrite = { from: string; to: string; measure: Measure | null; guessed: boolean };
export type VocabularyResult = { text: string; rewrites: Rewrite[] };

const LINK = "(?:is|was|of|at|now|about|around|reaches|reached|rate)";
// A guessed word only counts when a number follows within two linking words, as in "the polls is 88".
const BEFORE_NUMBER = `(?=\\s+(?:${LINK}\\s+){0,2}\\d)`;
type Rule = { re: RegExp; to: string; measure: Measure | null; guessed: boolean };
const RULES: readonly Rule[] = [
  { re: /\bresp(?:\.|iration|irations|iratory)?\s+rate\b/gi, to: "respiratory rate", measure: "resp_rate", guessed: false },
  { re: /\bR\.?R\b\.?/g, to: "respiratory rate", measure: "resp_rate", guessed: false },
  { re: new RegExp(`\\bresps?\\b${BEFORE_NUMBER}`, "gi"), to: "respiratory rate", measure: "resp_rate", guessed: false },
  { re: /\bB\.?P\b\.?/g, to: "blood pressure", measure: "bp", guessed: false },
  { re: /\b(?:O2\s+)?sats\b|\bSp\s?O2\b|\boxygen\s+sat(?:uration)?s?\b/gi, to: "SpO2", measure: "spo2", guessed: false },
  { re: /\btemp\b/gi, to: "temperature", measure: "temp_c", guessed: false },
  // Sound-alikes heard on a laptop mic on 28 Oct; a guessed word never acts unless the second ear names the same measure.
  { re: new RegExp(`\\b(?:polls?|pause|pals|pulls)\\b${BEFORE_NUMBER}`, "gi"), to: "pulse", measure: "pulse", guessed: true },
  { re: new RegExp(`\\b(?:harris|ras|rest|rice|wrist)\\s+(?:bridge|breach|rate|great)\\b${BEFORE_NUMBER}`, "gi"), to: "respiratory rate", measure: "resp_rate", guessed: true }
];

// Rewrites vitals abbreviations and known mishearings to the words the gate reads, and lists every rewrite.
export function vitalsVocabulary(text: string, o: { guesses?: boolean } = {}): VocabularyResult {
  const rewrites: Rewrite[] = [];
  let out = text;
  for (const r of RULES) {
    if (r.guessed && o.guesses === false) continue;
    out = out.replace(r.re, (m) => {
      if (m.trim().toLowerCase() === r.to.toLowerCase()) return m;
      rewrites.push({ from: m.trim(), to: r.to, measure: r.measure, guessed: r.guessed });
      return r.to;
    });
  }
  return { text: out, rewrites };
}

const MEASURE_WORDS: readonly [Measure, RegExp][] = [
  ["resp_rate", /^(?:respiratory rate|respiration rate|breathing rate|respirations)$/],
  ["bp", /^blood pressure$/],
  ["spo2", /^(?:spo2|oxygen saturation)$/],
  ["temp_c", /^(?:temperature|temp)$/],
  ["pulse", /^(?:pulse|heart rate)$/]
];
const PHRASES = ["respiratory rate", "respiration rate", "breathing rate", "blood pressure", "oxygen saturation", "heart rate"];
const NUMBER = /^\d+(?:\.\d+)?$/;
const FILLER = /^(?:uh|um|er|erm|hmm|mm|ah)$/;

// Words of a cleaned transcript, with two-word measure names kept together and punctuation dropped except a decimal point.
export function vitalsTokens(text: string): string[] {
  let t = ` ${text.toLowerCase().replace(/[^a-z0-9./ ]+/g, " ").replace(/\.(?!\d)/g, " ").replace(/\//g, " / ")} `;
  for (const p of PHRASES) t = t.replaceAll(` ${p} `, ` ${p.replace(" ", "_")} `);
  return t.split(/\s+/).filter(Boolean).map((w) => w.replace("_", " "));
}
const measureOf = (w: string): Measure | null => MEASURE_WORDS.find(([, re]) => re.test(w))?.[0] ?? null;

export type VitalsReading = Partial<Record<Measure, string[]>>;
// Every value said after each measure name, up to the next measure name; "128 over 76" and "128/76" read as one blood pressure.
export function readVitals(text: string): VitalsReading {
  const w = vitalsTokens(text);
  const out: VitalsReading = {};
  let cur: Measure | null = null;
  for (let i = 0; i < w.length; i++) {
    const m = measureOf(w[i]!);
    if (m) { cur = m; continue; }
    if (!cur || !NUMBER.test(w[i]!)) continue;
    if (cur === "bp" && (w[i + 1] === "over" || w[i + 1] === "/") && NUMBER.test(w[i + 2] ?? "")) { (out.bp ??= []).push(`${Number(w[i])}/${Number(w[i + 2])}`); i += 2; continue; }
    (out[cur] ??= []).push(String(Number(w[i])));
  }
  return out;
}

// The measures a transcript names, with or without a value.
export const measuresIn = (text: string): Measure[] => [...new Set(vitalsTokens(text).map(measureOf).filter((m): m is Measure => m !== null))];

// Every number in a transcript, in order, as plain decimals.
export const numbersIn = (text: string): string[] => vitalsTokens(text).filter((x) => NUMBER.test(x)).map((x) => String(Number(x)));

// How a finished transcript ends: "strong" when a value must follow (a measure name, "point", "over", or "the temperature is about"), "number" when a vitals line ends on a number or unit that may go on, else null.
export function danglingEnd(text: string): "strong" | "number" | null {
  const w = vitalsTokens(text).filter((x) => !FILLER.test(x));
  const last = w.at(-1);
  if (!last) return null;
  const recent = w.slice(-4);
  const vitals = w.some((x) => measureOf(x));
  if (last === "point" || last === "over") return vitals || recent.some((x) => NUMBER.test(x)) ? "strong" : null;
  if (measureOf(last)) return "strong";
  if (new RegExp(`^${LINK}$`).test(last) && recent.slice(0, -1).some((x) => measureOf(x))) return "strong";
  if ((NUMBER.test(last) || /^(?:degrees|celsius|percent|bpm)$/.test(last)) && vitals) return "number";
  return null;
}

// True when a transcript starts by carrying on a number: "point six", "over 80", "six", "degrees".
export function continuesNumber(text: string): boolean {
  const first = vitalsTokens(text).filter((x) => !FILLER.test(x))[0] ?? "";
  return NUMBER.test(first) || /^(?:point|over|degrees|celsius|percent|per|bpm|zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)$/.test(first);
}
