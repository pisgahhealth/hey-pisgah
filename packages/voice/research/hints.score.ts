import { readFileSync } from "node:fs";
import { wordError } from "./real.score.js";
import { valuesOf } from "./stability.score.js";
import { V2_LINES } from "./v2.lines.js";

// The names said in the scripts: the patients on screen, the staff spoken to, and the agent's own name.
export const PATIENT_NAMES = ["Mrs Okon", "Okon", "Bassey"];
export const STAFF_NAMES = ["Emeka", "Bisi", "Ada", "Nurse Ada", "Doctor Emeka", "Pisgah"];
// A ward drug list of 30 names: the drugs the scripts name, and the common ones a Nigerian medical ward stocks, so the hint list is not just the answers.
export const WARD_DRUGS = [
  "paracetamol", "Panadol", "ceftriaxone", "metronidazole", "amlodipine", "penicillin", "normal saline", "dextrose saline", "Ringer's lactate", "artemether lumefantrine",
  "artesunate", "amoxicillin", "Augmentin", "ciprofloxacin", "gentamicin", "ampicillin", "cloxacillin", "metformin", "insulin", "lisinopril",
  "nifedipine", "furosemide", "omeprazole", "ondansetron", "diclofenac", "tramadol", "pentazocine", "hydrocortisone", "salbutamol", "magnesium sulphate"
];
const HINTS = [...PATIENT_NAMES, ...STAFF_NAMES, ...WARD_DRUGS];

export type HintCondition = { id: string; label: string; hints: string[] | null; bias: string[] };
// No hint at all; the vitals words alone, as R1.b and the live serve sent; vitals with names and drugs; the same with English; English alone.
export const HINT_CONDITIONS: readonly HintCondition[] = [
  { id: "none", label: "no hints, no language", hints: null, bias: [] },
  { id: "vitals", label: "vitals words only (as shipped)", hints: [], bias: [] },
  { id: "names", label: "vitals, patient and staff names, ward drugs", hints: HINTS, bias: [] },
  { id: "names_en", label: "the same, with languageBias English", hints: HINTS, bias: ["English"] },
  { id: "en", label: "languageBias English only", hints: null, bias: ["English"] }
];

export type HintLine = { clip: string; source: "r1b" | "v2"; ref: string; values: string[]; names: string[]; drugs: string[] };
const has = (text: string, term: string) => ` ${text.toLowerCase().replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ")} `.includes(` ${term.toLowerCase().replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ")} `);
// The single-word names and drug names in a reference, so recall counts each one the person said.
const namesIn = (t: string) => [...new Set(["Okon", "Bassey", "Emeka", "Bisi", "Ada", "Pisgah"].filter((n) => has(t, n)))];
const drugsIn = (t: string) => [...new Set(WARD_DRUGS.filter((d) => has(t, d)))];

// Every scored R1.b line, and every usable v2 owner part, with what was said and the values, names and drugs in it.
export function hintLines(): HintLine[] {
  type R1 = { id: string; line: string | null; said: string; values: string[] };
  const r1 = (JSON.parse(readFileSync("packages/voice/research/real-set.json", "utf8")) as { clips: R1[] }).clips.filter((c) => c.line);
  type Cut = { id: string; part: string; status: string };
  const cuts = (JSON.parse(readFileSync("packages/voice/research/v2-real-set.json", "utf8")) as { cuts: Cut[] }).cuts.filter((c) => (c.part === "line" || c.part === "overlap_part") && (c.status === "ok" || c.status === "words_changed") && c.id !== "O083");
  const v2 = cuts.map((c) => {
    const l = V2_LINES.find((x) => x.id === c.id)!;
    const ref = c.part === "overlap_part" ? l.overlap!.words : l.words;
    return { clip: `v2-${c.id}${c.part === "overlap_part" ? "-part" : ""}`, source: "v2" as const, ref, values: valuesOf(ref), names: namesIn(ref), drugs: drugsIn(ref) };
  });
  return [...r1.map((c) => ({ clip: `r1b-${c.id}`, source: "r1b" as const, ref: c.said, values: [...c.values].sort(), names: namesIn(c.said), drugs: drugsIn(c.said) })), ...v2];
}

export type HintRow = { cond: string; run: number; clip: string; raw: string | null; voided: boolean; cost_usd: number; latency_ms: number };
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

// One condition over a set of lines: pooled word error, values right after the normaliser, and name and drug recall, per run and pooled.
export function scoreCondition(rows: readonly HintRow[], lines: readonly HintLine[]) {
  const byClip = new Map(lines.map((l) => [l.clip, l]));
  const ok = rows.filter((r) => r.raw !== null && !r.voided && byClip.has(r.clip));
  const w = wordError(ok.map((r) => ({ id: r.clip, ref: byClip.get(r.clip)!.ref, hyp: r.raw! })));
  let values = 0, right = 0, names = 0, namesHeard = 0, drugs = 0, drugsHeard = 0;
  const missedNames: Record<string, number> = {}, missedDrugs: Record<string, number> = {};
  for (const r of ok) {
    const l = byClip.get(r.clip)!;
    const got = valuesOf(r.raw!);
    const left = [...got];
    for (const v of l.values) { values += 1; const i = left.indexOf(v); if (i >= 0) { right += 1; left.splice(i, 1); } }
    for (const n of l.names) { names += 1; if (has(r.raw!, n)) namesHeard += 1; else missedNames[n] = (missedNames[n] ?? 0) + 1; }
    for (const d of l.drugs) { drugs += 1; if (has(r.raw!, d)) drugsHeard += 1; else missedDrugs[d] = (missedDrugs[d] ?? 0) + 1; }
  }
  return {
    readings: ok.length, wer: w.wer, ref_words: w.ref_words, errors: w.errors, values: { said: values, right, rate: values ? r4(right / values) : null },
    names: { said: names, heard: namesHeard, recall: names ? r4(namesHeard / names) : null, missed: missedNames }, drugs: { said: drugs, heard: drugsHeard, recall: drugs ? r4(drugsHeard / drugs) : null, missed: missedDrugs },
    cost_usd: Math.round(ok.reduce((n, r) => n + r.cost_usd, 0) * 1e6) / 1e6, top_misheard: w.misheard.slice(0, 8)
  };
}
