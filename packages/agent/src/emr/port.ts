import { z } from "zod";

// The one write kind an EMR agent holds in M1, and the shape of its arguments.
export const OBSERVATION_KIND = "record_observation" as const;
export const EMR_WRITE_KINDS = [OBSERVATION_KIND] as const;
// Any kind of work an EMR agent can hold; see work.ts for the full list and each kind's arguments.
export type EmrWriteKind = string;

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
// admission_id is empty while the patient is not yet admitted; visit_id names the arrival then.
export type EmrContext = { admission_id: string; patient_id: string | null; visit_id?: string | null; label: string; facts: Record<string, string | null>; keywords: string[] };
// Who the write is for and which spoken line asked for it.
export type Provenance = { owner: string; evidence: string; spoken_at: string };
// A read-only kind returns what it found as report; a draft is held for the owner to review before anything is written.
export type EmrCommit =
  | { ok: true; record_id: string; record_version: number; event_ids: string[]; replayed: boolean; report?: string; draft?: string }
  | { ok: false; reason: string; status: number | null; retryable: boolean; counted: boolean };
export type EmrProof = { record_id: string; record_version: number; event_ids: string[]; record_hash: string; verified_at: string; read: string };

export class EmrPortError extends Error {
  constructor(readonly code: string, message: string, readonly status: number | null = null) {
    super(message);
    this.name = "EmrPortError";
  }
}

export type WorkArgs = Record<string, unknown>;
// One read of what an agent watches for its owner, flattened to labelled facts; no model reads it.
export type WatchRead = { facts: Record<string, string | null>; labels: Record<string, string> };
// A question the agent puts to its owner when a watched fact reaches a value, such as a stage the owner's work waits on.
export type WatchOffer = { fact: string; equals: string; kind: string; ask: string };
export type InboxPage = { page_id: string; subject: string; at: string; patient_id: string | null };
// Names the owner may say for page targets and clinics, so the gate and its guards know them.
export type SayableNames = { page_targets: Record<string, readonly string[]>; clinics: Record<string, readonly string[]>; wards?: Record<string, readonly string[]> };

// The hospital port for a live EMR: reads for context, journaled writes, and a fresh read that proves each write.
export interface EmrPort {
  readonly writeKinds: readonly EmrWriteKind[];
  // The kinds one owner holds; without it every owner holds writeKinds.
  kindsFor?(owner: string): readonly EmrWriteKind[];
  resolve(target: EmrTarget, prov: Provenance): Promise<EmrContext>;
  commit(kind: EmrWriteKind, args: WorkArgs, intentKey: string, prov: Provenance): Promise<EmrCommit>;
  prove(kind: EmrWriteKind, args: WorkArgs, written: { record_id: string; record_version: number; event_ids: string[] }, prov: Provenance): Promise<EmrProof | null>;
  refusedCount(): number;
  watch?(owner: string, subject: EmrTarget & { visit_id?: string | null }, prov: Provenance): Promise<WatchRead | null>;
  offers?(owner: string): readonly WatchOffer[];
  inbox?(owner: string, prov: Provenance): Promise<InboxPage[]>;
  // Why a kind's write cannot be checked by any read the EMR offers, or null when it can.
  unverifiable?(kind: EmrWriteKind): string | null;
  names?(): SayableNames;
  // The watched facts whose change means a result came back, for work held until then.
  resultFacts?(owner: string): readonly string[];
}
