import { z } from "zod";
import { canonical, sha256 } from "./canonical.js";
import { CaseId, EventId, IsoDateTime, Sha256, StreamId } from "./ids.js";

// Frozen: simulated minutes from 00:00 Africa/Lagos on the expected discharge day, horizon 2880; for simulation events only.
export const SimMinutes = z.number().int().min(0).max(2880);

// Frozen: the store envelope. Clocks are non-negative integers in the stream's own domain (simulation minutes, or 0 for streams with no case clock); wall_at is real time, inside the chain hash, outside determinism hashes.
export const Envelope = z.strictObject({
  seq: z.number().int().min(1),
  stream_id: StreamId,
  recorded_at: z.number().int().min(0),
  occurred_at: z.number().int().min(0),
  wall_at: IsoDateTime,
  record_type: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/),
  schema_version: z.number().int().min(0),
  payload: z.unknown(),
  prev_hash: z.union([Sha256, z.literal("")]),
  hash: Sha256
});
export type Envelope = z.infer<typeof Envelope>;
export type UnsealedEnvelope = Omit<Envelope, "hash">;

// Frozen: a reference to one stored record.
export const StoreRef = z.strictObject({ stream_id: StreamId, seq: z.number().int().min(1) });
export type StoreRef = z.infer<typeof StoreRef>;

export function envelopeHash(e: UnsealedEnvelope): string {
  return sha256(canonical(e));
}

export function sealEnvelope(e: UnsealedEnvelope): Envelope {
  return { ...e, hash: envelopeHash(e) };
}

// The view hashed by determinism tests: everything except real time and the chain fields.
export function determinismView(e: Envelope): Omit<Envelope, "wall_at" | "hash" | "prev_hash"> {
  const { wall_at: _w, hash: _h, prev_hash: _p, ...rest } = e;
  return rest;
}

export type ChainCheck = { ok: true } | { ok: false; at: number; reason: "seq_gap" | "prev_hash_mismatch" | "hash_mismatch" };

export function verifyChain(stream: readonly Envelope[]): ChainCheck {
  let prev = "";
  for (let i = 0; i < stream.length; i++) {
    const e = stream[i]!;
    if (e.seq !== i + 1) return { ok: false, at: i, reason: "seq_gap" };
    if (e.prev_hash !== prev) return { ok: false, at: i, reason: "prev_hash_mismatch" };
    const { hash, ...rest } = e;
    if (envelopeHash(rest) !== hash) return { ok: false, at: i, reason: "hash_mismatch" };
    prev = hash;
  }
  return { ok: true };
}

// Frozen: one simulation event; no wall time and no hash, so identical runs produce identical events.
export const SimEvent = z.strictObject({
  event_id: EventId,
  case_id: CaseId,
  kind: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
  clock: z.enum(["server", "two_clock"]),
  occurred_at: SimMinutes,
  recorded_at: SimMinutes,
  late_entry_reason: z.string().max(200).nullable(),
  actor_id: z.string().nullable(),
  actor_role: z.string().nullable(),
  subject: z.string().nullable(),
  payload: z.unknown()
});
export type SimEvent = z.infer<typeof SimEvent>;

// Frozen: the two-clock rule mirrored from ward charting (15 min grace, 24 h back limit, 5 min future skew); server-clock events carry equal clocks.
export const TWO_CLOCK = { graceMin: 15, backLimitMin: 1440, futureSkewMin: 5 } as const;

export type TwoClockCheck =
  | { ok: true }
  | { ok: false; reason: "server_clocks_differ" | "future_skew" | "too_far_back" | "late_without_reason" };

export function checkTwoClock(e: { clock: "server" | "two_clock"; occurred_at: number; recorded_at: number; late_entry_reason?: string | null | undefined }): TwoClockCheck {
  const gap = e.recorded_at - e.occurred_at;
  if (e.clock === "server") return gap === 0 ? { ok: true } : { ok: false, reason: "server_clocks_differ" };
  if (gap < -TWO_CLOCK.futureSkewMin) return { ok: false, reason: "future_skew" };
  if (gap > TWO_CLOCK.backLimitMin) return { ok: false, reason: "too_far_back" };
  if (gap > TWO_CLOCK.graceMin && !e.late_entry_reason) return { ok: false, reason: "late_without_reason" };
  return { ok: true };
}
