import { z } from "zod";
import { canonical, sha256, type Json } from "./canonical.js";
import { Sha256, StreamId } from "./ids.js";

// Frozen: simulated minutes from 00:00 Africa/Lagos on the expected discharge day, horizon 2880.
export const SimMinutes = z.number().int().min(0).max(2880);

// Frozen: the store envelope; wall_at is inside the chain hash but excluded from determinism hashes by callers.
export const Envelope = z.object({
  seq: z.number().int().min(1),
  stream_id: StreamId,
  recorded_at: SimMinutes,
  occurred_at: SimMinutes,
  wall_at: z.string().datetime(),
  record_type: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/),
  schema_version: z.number().int().min(0),
  payload: z.unknown(),
  prev_hash: z.union([Sha256, z.literal("")]),
  hash: Sha256
});
export type Envelope = z.infer<typeof Envelope>;
export type UnsealedEnvelope = Omit<Envelope, "hash">;

export function envelopeHash(e: UnsealedEnvelope): string {
  return sha256(canonical(e as unknown as Json));
}

export function sealEnvelope(e: UnsealedEnvelope): Envelope {
  return { ...e, hash: envelopeHash(e) };
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

// Frozen: the two-clock rule mirrored from ward charting (15 min grace, 24 h back limit, 5 min future skew).
export const TWO_CLOCK = { graceMin: 15, backLimitMin: 1440, futureSkewMin: 5 } as const;

export type TwoClockCheck =
  | { ok: true }
  | { ok: false; reason: "future_skew" | "too_far_back" | "late_without_reason" | "reason_without_lateness" };

export function checkTwoClock(e: { occurred_at: number; recorded_at: number; late_entry_reason?: string | undefined }): TwoClockCheck {
  const gap = e.recorded_at - e.occurred_at;
  if (gap < -TWO_CLOCK.futureSkewMin) return { ok: false, reason: "future_skew" };
  if (gap > TWO_CLOCK.backLimitMin) return { ok: false, reason: "too_far_back" };
  if (gap > TWO_CLOCK.graceMin && !e.late_entry_reason) return { ok: false, reason: "late_without_reason" };
  if (gap <= TWO_CLOCK.graceMin && e.late_entry_reason) return { ok: false, reason: "reason_without_lateness" };
  return { ok: true };
}
