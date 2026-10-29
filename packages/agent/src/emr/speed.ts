import { measuresIn, numbersIn, type Measure } from "@hey-pisgah/voice";

// The speed levers of the vitals path, each switchable so it can be measured alone.
export type SpeedLevers = {
  // 1: the hold runs from the end of the spoken line, so a slow decision does not add a second wait.
  holdFromSpeech: boolean;
  // 2: a short first-stage call decides plain vitals lines for an owner who holds the clerking note.
  firstStage: boolean;
  // 3: writes and their proofs run on their own chain beside the decisions, and a proof read is tried again at 500 ms.
  proofBeside: boolean;
  // 4: the second ear starts when the line arrives, beside the gate, for a line that names a measure and a number.
  earWithGate: boolean;
  // 5: how many lines of one task may be decided at once when they name no measure in common.
  parallelLines: number;
  // 6: the decision starts while a line that ends on a number waits for the next chunk.
  decideWhileJoining: boolean;
};
export const LEVERS_OFF: SpeedLevers = { holdFromSpeech: false, firstStage: false, proofBeside: false, earWithGate: false, parallelLines: 1, decideWhileJoining: false };
export const MAX_PARALLEL_LINES = 3;
export const LEVERS_ON: SpeedLevers = { holdFromSpeech: true, firstStage: true, proofBeside: true, earWithGate: true, parallelLines: MAX_PARALLEL_LINES, decideWhileJoining: true };
// The levers the sandbox runs showed to help; the first stage is left off because its call was slower than the full gate.
export const KEPT_LEVERS = "1,3,4,5,6";
// The proof read is tried again this soon when the first read is slow or finds nothing yet.
export const PROOF_HEDGE_MS = 500;

// Reads "all", "none" or a list of lever numbers such as "1,2,3" into levers.
export function leversFrom(spec: string | undefined): SpeedLevers {
  const s = (spec ?? "").trim().toLowerCase();
  if (s === "all") return { ...LEVERS_ON };
  const on = new Set(s.split(/[\s,]+/).filter(Boolean).map(Number));
  return {
    holdFromSpeech: on.has(1), firstStage: on.has(2), proofBeside: on.has(3), earWithGate: on.has(4),
    parallelLines: on.has(5) ? MAX_PARALLEL_LINES : 1, decideWhileJoining: on.has(6)
  };
}
export const leverList = (v: SpeedLevers): number[] =>
  [v.holdFromSpeech, v.firstStage, v.proofBeside, v.earWithGate, v.parallelLines > 1, v.decideWhileJoining].flatMap((x, i) => (x ? [i + 1] : []));

// How long a proposed action still waits: the whole hold from the anchor, which is the end of the spoken line under lever 1.
export const holdLeftMs = (holdMs: number, anchorMs: number | null, nowMs: number): number =>
  anchorMs === null || !Number.isFinite(anchorMs) ? holdMs : Math.max(0, Math.min(holdMs, anchorMs + holdMs - nowMs));

// True when a line names a measure and holds a number, which every vitals write needs, so the second ear may start before the gate answers.
export const willWriteNumber = (text: string): boolean => measuresIn(text).length > 0 && numbersIn(text).length > 0;
// The measures two lines have in common; lines that share one are decided in order.
export const sharedMeasures = (a: string, b: string): Measure[] => { const m = new Set(measuresIn(b)); return measuresIn(a).filter((x) => m.has(x)); };

// Reads once, and once more at the hedge time if the first read is slow or finds nothing; the first proof found wins.
export async function hedgedRead<T>(read: () => Promise<T | null>, hedgeMs = PROOF_HEDGE_MS): Promise<T | null> {
  const t0 = Date.now();
  const first = read().then((v) => ({ v, e: null as unknown }), (e: unknown) => ({ v: null as T | null, e }));
  const early = await Promise.race([first, new Promise<null>((r) => setTimeout(() => r(null), hedgeMs))]);
  if (early && early.v !== null) return early.v;
  if (early) await new Promise((r) => setTimeout(r, Math.max(0, hedgeMs - (Date.now() - t0))));
  const second = read().then((v) => ({ v, e: null as unknown }), (e: unknown) => ({ v: null as T | null, e }));
  const done = early ? [early] : [];
  const pending = early ? [second] : [first, second];
  while (pending.length) {
    const r = await Promise.race(pending.map((p, i) => p.then((x) => ({ x, i }))));
    if (r.x.v !== null) return r.x.v;
    done.push(r.x);
    pending.splice(r.i, 1);
  }
  const err = done.find((d) => d.e !== null && d.e !== undefined);
  if (err && done.every((d) => d.e !== null && d.e !== undefined)) throw err.e;
  return null;
}
