import { z } from "zod";

// The one write kind an EMR agent holds in M1, and the shape of its arguments.
export const OBSERVATION_KIND = "record_observation" as const;
export const EMR_WRITE_KINDS = [OBSERVATION_KIND] as const;
export type EmrWriteKind = (typeof EMR_WRITE_KINDS)[number];

export const EmrId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const ObservationArgs = z.strictObject({
  admission_id: EmrId,
  temp_c: z.string().regex(/^\d{2}(\.\d)?$/).refine((v) => Number(v) >= 30 && Number(v) <= 45, "temperature must be 30 to 45 C").optional(),
  pulse: z.number().int().min(20).max(250).optional(),
  resp_rate: z.number().int().min(4).max(80).optional(),
  bp: z.string().regex(/^\d{2,3}\/\d{2,3}$/).optional(),
  remark: z.string().min(1).max(300).optional(),
  corrects_record_id: z.string().min(1).max(80).optional()
}).refine((a) => a.temp_c !== undefined || a.pulse !== undefined || a.resp_rate !== undefined || a.bp !== undefined, "an observation needs at least one measurement");
export type ObservationArgs = z.infer<typeof ObservationArgs>;

export type EmrTarget = { admission_id?: string; patient_id?: string };
// What the agent may know about the patient in context; every string came from the record, so prompts wrap it as untrusted text.
export type EmrContext = { admission_id: string; patient_id: string | null; label: string; facts: Record<string, string | null>; keywords: string[] };
// Who the write is for and which spoken line asked for it.
export type Provenance = { owner: string; evidence: string; spoken_at: string };
export type EmrCommit =
  | { ok: true; record_id: string; record_version: number; event_ids: string[]; replayed: boolean }
  | { ok: false; reason: string; status: number | null; retryable: boolean; counted: boolean };
export type EmrProof = { record_id: string; record_version: number; event_ids: string[]; record_hash: string; verified_at: string; read: string };

export class EmrPortError extends Error {
  constructor(readonly code: string, message: string, readonly status: number | null = null) {
    super(message);
    this.name = "EmrPortError";
  }
}

// The hospital port for a live EMR: reads for context, one journaled write kind, and a fresh read that proves each write.
export interface EmrPort {
  readonly writeKinds: readonly EmrWriteKind[];
  resolve(target: EmrTarget, prov: Provenance): Promise<EmrContext>;
  commit(kind: EmrWriteKind, args: ObservationArgs, intentKey: string, prov: Provenance): Promise<EmrCommit>;
  prove(kind: EmrWriteKind, args: ObservationArgs, written: { record_id: string; record_version: number; event_ids: string[] }, prov: Provenance): Promise<EmrProof | null>;
  refusedCount(): number;
}
