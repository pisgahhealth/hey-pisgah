import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, type SessionOptions } from "../src/session.js";
import { DiscoveryPool } from "../src/pool.js";

export const tempRoot = (): string => mkdtempSync(join(tmpdir(), "hp-intel-"));
const sharedPool = new DiscoveryPool();
export const pool = (): DiscoveryPool => sharedPool;

export function session(o: Partial<SessionOptions> = {}): Session {
  return new Session({ storeRoot: tempRoot(), runId: "run-1e57aaaa", arm: "adaptive", pool: sharedPool, now: () => new Date("2026-10-30T09:00:00Z"), ...o });
}

// Two cases where the wait after the clinical discharge is long, one where it is short.
export const LONG = ["c-491dbab0", "c-8c9cd194", "c-ed324a69"] as const;
export const SHORT = "c-11060afa";
export const LEARNED = [{ op: "remove_soft_edge", edge_id: "e04" }, { op: "set_prep_trigger", target: { step: "st06" }, when: { after: { step: "st02" } } }];

export function eventId(caseId: string, subject: string): string {
  const e = sharedPool.get(caseId)!.events.find((x) => x.kind === "step.completed" && x.subject === subject);
  if (!e) throw new Error(`no ${subject} in ${caseId}`);
  return e.event_id;
}

export const evidence = () => [
  { event_id: eventId(LONG[0], "st05"), case_id: LONG[0], stance: "context", note: "clinical discharge" },
  { event_id: eventId(LONG[0], "st16"), case_id: LONG[0], stance: "supports", note: "departure" },
  { event_id: eventId(SHORT, "st16"), case_id: SHORT, stance: "contradicts", note: "short wait" }
];

export const pred = (comparison: string, tol: number, metric = "post_signoff_wait_min", cases: readonly string[] = LONG) => ({ metric, comparison, tolerance_min: tol, scope: { cases: [...cases] } });

export function hyp(s: Session, o: Record<string, unknown> = {}): string {
  const r = s.recordHypothesis({ statement: "s", mechanism: "m", subject_refs: ["st06"], competing: { none_identified_reason: "first reading" }, evidence: evidence(), if_true: pred("intervention_lt_control", 30), if_false: pred("no_difference", 10), refuted_if: "r", revises: null, ...o });
  if (r.ok !== true) throw new Error(JSON.stringify(r));
  return String(r.hypothesis_id);
}
