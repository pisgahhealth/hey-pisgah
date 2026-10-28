import { checkTwoClock, hashJson, sha256, type SimEvent } from "@hey-pisgah/contracts";
import { PriorityQueue, stableKey, type Phase } from "./queue.js";
import { HORIZON_MIN } from "./rules.js";

export class SimInvariantViolation extends Error {
  readonly code = "sim_invariant_violation";
  constructor(readonly violations: string[], readonly at: number) {
    super(`sim_invariant_violation at ${at}: ${violations.join("; ")}`);
  }
}

export type EmitInput = Omit<SimEvent, "event_id" | "seq" | "case_id" | "late_entry_reason" | "clock" | "occurred_at" | "recorded_at"> & {
  clock?: SimEvent["clock"];
  occurred_at?: number;
  recorded_at?: number;
  late_entry_reason?: string | null;
};

// Runs after every processed queue entry with the events that entry emitted; returns violation messages.
export type Invariant = (fresh: readonly SimEvent[], engine: Engine) => string[];

// The generic discrete-event core: integer minutes, a phased priority queue, an append-only event log and invariants.
export class Engine {
  now = 0;
  readonly events: SimEvent[] = [];
  private readonly queue = new PriorityQueue();
  private readonly invariants: Invariant[] = [];

  constructor(readonly caseId: string, readonly runId: string, readonly horizon: number = HORIZON_MIN) {
    this.invariants.push((fresh) => fresh.flatMap((e) => {
      const c = checkTwoClock(e);
      return c.ok ? [] : [`two_clock ${c.reason} on ${e.kind} seq ${e.seq}`];
    }));
  }

  addInvariant(fn: Invariant): void { this.invariants.push(fn); }

  // Schedules work; entries after the horizon are dropped because nothing past it is ever recorded.
  at(time: number, phase: Phase, jobId: string, attempt: number, run: () => void): void {
    if (time > this.horizon) return;
    if (time < this.now) throw new Error(`cannot schedule at ${time} before now ${this.now}`);
    this.queue.push({ time, phase, key: stableKey(this.caseId, jobId, attempt), run });
  }

  emit(e: EmitInput): SimEvent {
    const seq = this.events.length + 1;
    const ev: SimEvent = {
      event_id: `ev-${sha256(`${this.runId}|${seq}`).slice(0, 8)}`,
      seq,
      case_id: this.caseId,
      kind: e.kind,
      clock: e.clock ?? "server",
      occurred_at: e.occurred_at ?? this.now,
      recorded_at: e.recorded_at ?? this.now,
      late_entry_reason: e.late_entry_reason ?? null,
      actor_id: e.actor_id,
      actor_role: e.actor_role,
      subject: e.subject,
      payload: e.payload
    };
    this.events.push(ev);
    return ev;
  }

  // Processes the queue to the horizon; an invariant violation throws and leaves no metrics behind.
  run(): void {
    for (;;) {
      const next = this.queue.pop();
      if (!next) return;
      this.now = next.time;
      const mark = this.events.length;
      next.run();
      const fresh = this.events.slice(mark);
      const bad = this.invariants.flatMap((fn) => fn(fresh, this));
      if (bad.length) throw new SimInvariantViolation(bad, this.now);
    }
  }
}

// The as-recorded view: what anyone could know at minute t.
export function visibleAt(events: readonly SimEvent[], t: number): SimEvent[] {
  return events.filter((e) => e.recorded_at <= t);
}

// The determinism hash: canonical JSON of the full event log.
export function eventLogHash(events: readonly SimEvent[]): string {
  return hashJson(events);
}

// The exogenous sub-log: world events with seq and ids removed, which must be identical across matched runs.
export function externalSubLog(events: readonly SimEvent[]): Omit<SimEvent, "event_id" | "seq">[] {
  return events.filter((e) => e.kind.startsWith("world.")).map(({ event_id: _i, seq: _s, ...rest }) => rest);
}

export function externalSubLogHash(events: readonly SimEvent[]): string {
  return hashJson(externalSubLog(events));
}

export const BEHAVIOUR_UNCHANGED = "behaviour unchanged: the two definitions differ, and every matched run produced an event log identical to its control";

// Compares matched runs of two definitions; a changed definition with identical event logs in every run gets the behaviour-unchanged note.
export function behaviourNote(control: { version_hash: string; events: readonly SimEvent[] }[], intervention: { version_hash: string; events: readonly SimEvent[] }[]): { identical: boolean[]; definition_changed: boolean; note: string | null } {
  const identical = control.map((c, i) => intervention[i] !== undefined && eventLogHash(c.events) === eventLogHash(intervention[i]!.events));
  const definitionChanged = control.some((c, i) => intervention[i] !== undefined && c.version_hash !== intervention[i]!.version_hash);
  return { identical, definition_changed: definitionChanged, note: definitionChanged && identical.length > 0 && identical.every(Boolean) ? BEHAVIOUR_UNCHANGED : null };
}
