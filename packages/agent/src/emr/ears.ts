import { ModelError, type ChatMessage, type ModelClient, type ProviderId } from "@hey-pisgah/model";
import { cleanTranscript, measuresIn, numbersIn, readVitals, vitalsVocabulary, type Measure } from "@hey-pisgah/voice";
import type { IntentRoute } from "./intent.js";

// The second reading of one clip, from a model that hears the audio itself; `also` holds further readings that must each agree too.
export type EarReading = { text: string; provider: ProviderId | "local"; model: string; response_id: string | null; cost_usd: number; fallback_reason: string | null; calls?: number; also?: EarReading[] };
export type SecondEar = (wav: Uint8Array, meta: { run_id: string; task_id: string; line_id: string }) => Promise<EarReading>;

// Spark Open on Modal took an audio_url data URI on 28 Oct; hosted Spark 1.3 refused audio_url and took input_audio, so it is the disclosed fallback.
export const EAR_ROUTE: IntentRoute = { provider: "modal", model: "meta-models/Muse-Spark-Open-816B-A42B" };
export const EAR_FALLBACK: IntentRoute = { provider: "meta", model: "muse-spark-1.3" };
// Without a line naming the clip the model said no audio was attached in 4 of 7 probe calls; with it, 8 of 8 read the clip.
// A list of vitals words in this prompt made the model add vitals nobody said (live run 9), so the prompt names none.
export const EAR_SYSTEM = [
  "The user message holds one short audio clip of a clinician speaking, given as an audio part. Write down exactly what is said in it, word for word.",
  "Write only words that are in the clip, and write numbers as digits."
].join("\n");
export const EAR_SETTINGS = { effort: "low" as const, max_completion_tokens: 2000, route: EAR_ROUTE, fallback: EAR_FALLBACK };

function audioPart(provider: ProviderId, b64: string): unknown {
  return provider === "meta" ? { type: "input_audio", input_audio: { data: b64, format: "wav" } } : { type: "audio_url", audio_url: { url: `data:audio/wav;base64,${b64}` } };
}

// The second ear on Spark audio input: one transcription call at effort low, with one move to the fallback route on a provider error.
export function sparkEar(client: ModelClient, settings = EAR_SETTINGS): SecondEar {
  return async (wav, meta) => {
    const b64 = Buffer.from(wav).toString("base64");
    const run = async (r: IntentRoute, fallback_reason: string | null): Promise<EarReading> => {
      const messages = [
        { role: "system", content: EAR_SYSTEM },
        { role: "user", content: [{ type: "text", text: "Here is the clip:" }, audioPart(r.provider, b64), { type: "text", text: "Transcribe the clip above. Return only the transcript." }] }
      ] as unknown as ChatMessage[];
      const res = await client.call({
        provider: r.provider, model: r.model, effort: settings.effort, max_completion_tokens: settings.max_completion_tokens, messages,
        purpose: "emr.ear", run_id: meta.run_id, task_id: meta.task_id, task_state: "running", thread: "side", affinity_key: null
      });
      const content = res.completion.choices[0]?.message?.content;
      return { text: typeof content === "string" ? content.trim().slice(0, 2000) : "", provider: r.provider, model: r.model, response_id: res.row.response_id, cost_usd: res.row.cost_usd, fallback_reason };
    };
    let first: EarReading;
    try {
      first = await run(settings.route, null);
    } catch (e) {
      if (!(e instanceof ModelError) || !settings.fallback || (e.code !== "provider_error" && e.code !== "no_key")) throw e;
      return run(settings.fallback, `${settings.route.provider}_${e.code}`);
    }
    // A reply with no number at all is the model saying it heard no audio (seen in the probe and in a live run), so it reads once more.
    if (numbersIn(cleanTranscript(first.text)).length) return first;
    const again = await run(settings.route, null);
    return { ...again, cost_usd: first.cost_usd + again.cost_usd, calls: 2 };
  };
}

export const MEASURE_LABEL: Record<Measure, string> = { temp_c: "temperature", pulse: "pulse", resp_rate: "respiratory rate", bp: "blood pressure", spo2: "SpO2" };
export type MeasureCheck = { measure: Measure; first: string; second: string | null; agree: boolean };
export type EarsCheck = { agree: boolean; measures: MeasureCheck[] };

export const normValue = (m: Measure, v: unknown): string =>
  m === "bp" ? String(v).replace(/\s+/g, "").split("/").map((n) => String(Number(n))).join("/") : String(Number(v));

function bpHeard(nums: readonly string[], bp: string): boolean {
  const [a, b] = bp.split("/");
  return nums.some((n, i) => n === a && nums[i + 1] === b);
}

// The rule, before any vitals write from speech: every value must be in the second reading, and a measure word the first reading guessed must be named there too.
export function compareReadings(values: Partial<Record<Measure, unknown>>, second: string, guessed: ReadonlySet<Measure> = new Set()): EarsCheck {
  const clean = cleanTranscript(second);
  const t2 = vitalsVocabulary(clean).text;
  const named = readVitals(t2);
  // A measure the first reading only guessed must be named plainly by the second, not by the same guess.
  const plain = readVitals(vitalsVocabulary(clean, { guesses: false }).text);
  const nums = numbersIn(t2);
  const measures: MeasureCheck[] = [];
  for (const [m, v] of Object.entries(values) as [Measure, unknown][]) {
    if (v === null || v === undefined || v === "") continue;
    const first = normValue(m, v);
    const said = ((guessed.has(m) ? plain : named)[m] ?? []).map((x) => normValue(m, x));
    const heard = m === "bp" ? bpHeard(nums, first) : nums.includes(first);
    const agree = said.includes(first) || (!guessed.has(m) && heard && said.length === 0);
    measures.push({ measure: m, first, second: agree ? first : said[0] ?? null, agree });
  }
  return { agree: measures.every((x) => x.agree), measures };
}

// Every reading a second ear returned, the first with its own cost and then each one in `also`; the top reading carries the sum.
export function readingsOf(r: EarReading): EarReading[] {
  const also = r.also ?? [];
  if (!also.length) return [r];
  const { also: _drop, ...first } = r;
  const own = Math.max(0, Math.round((r.cost_usd - also.reduce((n, x) => n + x.cost_usd, 0)) * 1e9) / 1e9);
  return [{ ...first, cost_usd: own, calls: Math.max(1, (r.calls ?? 1) - also.reduce((n, x) => n + (x.calls ?? 1), 0)) }, ...also];
}

// The rule over several readings: a value agrees only when every reading agrees on it, and the first reading that differs is the one shown.
export function compareAll(values: Partial<Record<Measure, unknown>>, r: EarReading, guessed: ReadonlySet<Measure> = new Set()): EarsCheck {
  const checks = readingsOf(r).map((x) => compareReadings(values, x.text, guessed));
  const measures = checks[0]!.measures.map((m, i) => checks.find((c) => !c.measures[i]!.agree)?.measures[i] ?? m);
  return { agree: checks.every((c) => c.agree), measures };
}

export type Choice = { measures: Measure[]; options: Record<string, string>[]; yes: boolean };
const say = (xs: readonly string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}` : xs[0] ?? "");

// The one-word question when the readings differ, showing both, and the choice a short answer may pick from.
export function disagreementQuestion(check: EarsCheck): { text: string; choice: Choice } {
  const off = check.measures.filter((x) => !x.agree);
  if (off.length === 1) {
    const x = off[0]!;
    const name = MEASURE_LABEL[x.measure];
    if (x.second === null) {
      return {
        text: `${name[0]!.toUpperCase()}${name.slice(1)} ${x.first}: the second reading did not hear it. Say yes to chart ${x.first}, or say the number.`,
        choice: { measures: [x.measure], options: [{ [x.measure]: x.first }], yes: true }
      };
    }
    return {
      text: `${name[0]!.toUpperCase()}${name.slice(1)}: one reading heard ${x.first}, the other ${x.second}. Say ${x.first} or ${x.second}.`,
      choice: { measures: [x.measure], options: [{ [x.measure]: x.first }, { [x.measure]: x.second }], yes: false }
    };
  }
  const parts = off.map((x) => `${MEASURE_LABEL[x.measure]} ${x.first} or ${x.second ?? "not heard"}`);
  return {
    text: `The two readings differ: ${parts.join("; ")}. Say the right numbers.`,
    choice: { measures: off.map((x) => x.measure), options: off.flatMap((x) => [{ [x.measure]: x.first }, ...(x.second ? [{ [x.measure]: x.second }] : [])]), yes: false }
  };
}

// The question for an unclear vitals line: what was heard, in quotes, and what one word would settle it.
export function quotedQuestion(words: string, fallback: string | null): { text: string; choice: Choice | null } {
  const quote = `I heard "${words.replace(/\s+/g, " ").trim().slice(0, 140)}".`;
  const r = readVitals(words);
  const ms = measuresIn(words);
  if (ms.length === 1) {
    const m = ms[0]!;
    const vals = [...new Set((r[m] ?? []).map((v) => normValue(m, v)))];
    if (vals.length >= 2) return { text: `${quote} Say ${say(vals)}.`, choice: { measures: [m], options: vals.map((v) => ({ [m]: v })), yes: false } };
    return { text: `${quote} What is the ${MEASURE_LABEL[m]}? Say the number.`, choice: { measures: [m], options: [], yes: false } };
  }
  return { text: `${quote} ${fallback ?? "Please say it again."}`, choice: null };
}

const YES = /^(?:yes|yeah|yep|yes please|correct|that'?s right|right)$/;
const NO = /^(?:no|nope|neither|cancel|leave it|don'?t)$/;
const PAD = /\b(?:it'?s|it is|its|the|please|chart|record|put|that|make it|say|was|is)\b/g;
// Reads a short spoken answer to a choice: yes, no, or the numbers that pick one value per measure; anything longer goes to the gate.
export function answerChoice(text: string, c: Choice): Record<string, string> | "no" | null {
  const t = text.toLowerCase().replace(/[^a-z0-9./' ]+/g, " ").replace(/\.(?!\d)/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.split(" ").length > 5) return null;
  if (NO.test(t)) return "no";
  if (YES.test(t)) return c.yes && c.options.length === 1 ? { ...c.options[0]! } : null;
  const rest = t.replace(PAD, " ").replace(/\s+/g, " ").trim();
  if (/[a-z]/.test(rest.replace(/\bover\b/g, ""))) return null;
  const nums = numbersIn(rest.replace(/\bover\b/g, "/"));
  if (c.measures.length === 1) {
    const m = c.measures[0]!;
    if (m === "bp") return nums.length === 2 ? { bp: `${nums[0]}/${nums[1]}` } : null;
    return nums.length === 1 ? { [m]: nums[0]! } : null;
  }
  // Each number must belong to exactly one measure's shown readings.
  const out: Record<string, string> = {};
  for (const n of nums) {
    const hits = c.options.filter((o) => Object.values(o)[0] === n).map((o) => Object.keys(o)[0]!);
    if (hits.length !== 1 || out[hits[0]!]) return null;
    out[hits[0]!] = n;
  }
  return Object.keys(out).length === c.measures.length ? out : null;
}
