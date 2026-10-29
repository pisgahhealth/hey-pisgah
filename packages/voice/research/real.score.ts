import { cleanTranscript } from "../src/numbers.js";
import { numbersIn, vitalsVocabulary } from "../src/vitals.js";
import type { Line } from "./lines.js";
import type { RealClip } from "./real.lines.js";
import { SV_RULE, svSpeaker, type SvRule } from "./score.js";

export type VoiceRow = { who: string; cos_owner: number; pitch_hz: number | null; cluster: "main" | "second" };
export type Voices = { model: string; clips: Record<string, VoiceRow> };

// The real clips as labelled lines, so the R1 scorer runs on them unchanged.
export const realLines = (clips: readonly RealClip[]): Line[] =>
  clips.filter((c) => c.set === "tuning" || c.set === "final").map((c) => ({ id: c.id, set: c.set as Line["set"], who: c.who, words: c.said, addressee: c.addressee!, kind: c.kind!, overlap: null, noisy: false, synthetic_only: false }));

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

// Per scripted person: how close their lines sit to the owner's enrolment, their pitch, and how many fall in the second voice cluster.
export function voiceGroups(v: Voices) {
  const rows = Object.entries(v.clips).filter(([id]) => /^[THX]/.test(id));
  return Object.fromEntries(["S", "B", "N", "P", "R"].map((w) => {
    const xs = rows.filter(([, r]) => r.who === w);
    const cos = xs.map(([, r]) => r.cos_owner), hz = xs.map(([, r]) => r.pitch_hz).filter((h): h is number => h !== null && h < 380);
    return [w, { n: xs.length, cos_owner_median: r4(median(cos)), cos_owner_min: Math.min(...cos), cos_owner_max: Math.max(...cos), pitch_median_hz: Math.round(median(hz)), second_voice: xs.filter(([, r]) => r.cluster === "second").map(([id]) => id).sort() }];
  }));
}

// The owner rule set on the tuning lines only: halfway between the lowest owner-voice score and the highest second-voice score.
export function tuneOwnerMin(v: Voices): { owner_min: number; owner_low: number; second_high: number } {
  const t = Object.entries(v.clips).filter(([id]) => id.startsWith("T"));
  const owner = t.filter(([, r]) => r.who === "S" && r.cluster === "main").map(([, r]) => r.cos_owner);
  const second = t.filter(([, r]) => r.cluster === "second").map(([, r]) => r.cos_owner);
  const lo = Math.min(...owner), hi = Math.max(...second);
  return { owner_min: Math.round(((lo + hi) / 2) * 100) / 100, owner_low: lo, second_high: hi };
}

// With one enrolled voice the rule has no colleague template, so B and N score zero and the margin is over nothing.
export const onlyOwner = (cos: number) => ({ S: cos, B: 0, N: 0 });

// Attribution by voice, on the held-out lines: the owner's own lines must pass, and every second-voice clip must not.
export function byVoice(v: Voices, ids: readonly string[], rule: SvRule = SV_RULE) {
  const rows = ids.map((id) => ({ id, r: v.clips[id]!, said: svSpeaker(onlyOwner(v.clips[id]!.cos_owner), rule) }));
  const owner = rows.filter((x) => x.r.who === "S" && x.r.cluster === "main"), second = rows.filter((x) => x.r.cluster === "second");
  const acting = rows.filter((x) => x.r.who !== "S" && x.r.cluster === "main");
  return {
    owner_min: rule.owner_min,
    owner_lines_passed: { n: owner.filter((x) => x.said === "owner").length, of: owner.length, refused: owner.filter((x) => x.said !== "owner").map((x) => x.id) },
    second_voice_passed: { n: second.filter((x) => x.said === "owner").length, of: second.length, ids: second.filter((x) => x.said === "owner").map((x) => x.id) },
    owner_acting_other_parts_passed: { n: acting.filter((x) => x.said === "owner").length, of: acting.length }
  };
}

const NUMBER_WORD = /^(\d+(\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|point)$/;
const FILLER = /^(uh|um|umum|ah|hmm|hm|mm|eh|oh)$/;
const EXPAND: Record<string, string> = { "it's": "it is", "i'm": "i am", "i've": "i have", "don't": "do not", "didn't": "did not", "that's": "that is", "we'll": "we will", "we're": "we are", "let's": "let us", "she's": "she is", "you're": "you are", "what's": "what is", "i'll": "i will" };

// Words for the word error count: lower case, no speaker marks, no fillers, contractions opened, and numbers left to the number count.
export function words(t: string): string[] {
  return t.toLowerCase().replace(/\[[a-z]\]/g, " ").replace(/[’]/g, "'").replace(/-/g, " ").replace(/[^a-z0-9.' ]/g, " ").split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, "").replace(/\.+$/, "")).filter(Boolean)
    .flatMap((w) => (EXPAND[w] ?? w).split(" ")).filter((w) => !FILLER.test(w) && !NUMBER_WORD.test(w));
}

// Word-level edit alignment, returning the error count and each substitution, deletion and insertion.
export function align(ref: string[], hyp: string[]) {
  const n = ref.length, m = hyp.length, d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
  const ops: { op: "sub" | "del" | "ins"; ref: string | null; hyp: string | null }[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) { if (ref[i - 1] !== hyp[j - 1]) ops.push({ op: "sub", ref: ref[i - 1]!, hyp: hyp[j - 1]! }); i--; j--; }
    else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) { ops.push({ op: "del", ref: ref[i - 1]!, hyp: null }); i--; }
    else { ops.push({ op: "ins", ref: null, hyp: hyp[j - 1]! }); j--; }
  }
  return { errors: d[n]![m]!, ref_words: n, ops: ops.reverse() };
}

// Word error over a set of clips, pooled, with the misheard words gathered from every substitution.
export function wordError(pairs: readonly { id: string; ref: string; hyp: string }[]) {
  let errors = 0, total = 0;
  const misheard = new Map<string, { n: number; ids: string[] }>();
  for (const p of pairs) {
    const a = align(words(p.ref), words(p.hyp));
    errors += a.errors; total += a.ref_words;
    for (const o of a.ops) if (o.op === "sub") { const k = `${o.ref} -> ${o.hyp}`; const e = misheard.get(k) ?? { n: 0, ids: [] }; e.n++; e.ids.push(p.id); misheard.set(k, e); }
  }
  return { clips: pairs.length, ref_words: total, errors, wer: total ? r4(errors / total) : null, misheard: [...misheard.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).map(([k, e]) => ({ heard: k, n: e.n, ids: e.ids })) };
}

const UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const say2 = (n: number) => (n < 20 ? UNITS[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${UNITS[n % 10]}` : ""}`);

// The ward ways of saying a value from 100 to 199 ("one thirty", "hundred and twelve"), which the normaliser may not turn into digits.
export function spokenForms(v: string): string[] {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 100 || n > 199) return [];
  if (n === 100) return ["hundred"];
  const rest = say2(n - 100);
  return [...(n - 100 >= 10 ? [`one ${rest}`] : []), `hundred and ${rest}`];
}

// Each clinical value said: whether Voice Transcribe heard it, and whether it survives the shipped number normaliser.
export function numberAccuracy(rows: readonly { id: string; values: readonly string[]; heard: string }[]) {
  const per = rows.filter((r) => r.values.length).map((r) => {
    const got = numbersIn(vitalsVocabulary(cleanTranscript(r.heard)).text);
    const plain = ` ${r.heard.toLowerCase().replace(/-/g, " ").replace(/[^a-z0-9. ]/g, " ").replace(/\s+/g, " ")} `;
    const missed = r.values.filter((v) => !got.includes(v));
    const heardInWords = missed.filter((v) => spokenForms(v).some((f) => plain.includes(` ${f} `)));
    return { id: r.id, said: r.values, got, missed, normaliser_lost: heardInWords };
  });
  const values = per.reduce((s, p) => s + p.said.length, 0), wrong = per.reduce((s, p) => s + p.missed.length, 0), lost = per.reduce((s, p) => s + p.normaliser_lost.length, 0);
  return { clips: per.length, values, heard: values - wrong + lost, right_after_normaliser: values - wrong, wrong_after_normaliser: wrong, lost_by_normaliser: lost, failures: per.filter((p) => p.missed.length) };
}
