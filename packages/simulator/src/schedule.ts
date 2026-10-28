import { ActorRole, CaseId, RecordKind, StepId, hashJson } from "@hey-pisgah/contracts";
import { z } from "zod";
import { ParamOverrides } from "./rules.js";

const Minute = z.number().int().min(0).max(2880);
const Fact = z.union([z.string(), z.array(z.string())]);
const Interval = z.strictObject({ from: Minute, to: Minute }).refine((i) => i.to > i.from, { message: "an interval must end after it starts" });

// When the outside world performs an external step: at an absolute minute, a delay after another step completes, or never.
export const ExternalDue = z.union([
  z.strictObject({ at: Minute }),
  z.strictObject({ after: StepId, delay_min: z.number().int().min(0) }),
  z.literal("never")
]);
export type ExternalDue = z.infer<typeof ExternalDue>;

export const StepDraw = z.strictObject({
  due: ExternalDue.optional(),
  not_before: Minute.optional(),
  blocked: z.boolean().optional(),
  payload: z.json().optional(),
  sets_facts: z.record(z.string(), Fact).optional()
});
export type StepDraw = z.infer<typeof StepDraw>;

export const ResourceSpec = z.strictObject({
  kind: z.enum(["single", "fifo"]),
  busy_blocks: z.array(Interval),
  backlog: z.array(z.strictObject({ job_id: z.string().regex(/^[a-z0-9_-]+$/), arrive_at: Minute, service_min: z.number().int().min(1) }))
});
export type ResourceSpec = z.infer<typeof ResourceSpec>;

export const RecordUpdate = z.strictObject({
  update_id: z.string().regex(/^[a-z0-9_-]+$/),
  at: Minute,
  record_kind: RecordKind,
  actor_role: ActorRole,
  payload: z.json()
});

// Frozen per case and hashed; every draw a run uses comes from here, keyed by job identity, so matched runs share one world.
export const ExternalSchedule = z.strictObject({
  schedule_version: z.literal(1),
  case_id: CaseId,
  facts: z.record(z.string(), Fact),
  actors: z.record(z.string(), z.string()),
  steps: z.record(StepId, StepDraw),
  alternatives: z.record(z.string(), StepId),
  resources: z.record(z.string(), ResourceSpec),
  record_updates: z.array(RecordUpdate),
  service_min: z.record(z.string(), z.number().int().min(0)),
  service_default_min: z.record(z.string(), z.number().int().min(0)),
  entry_lag: z.record(z.string(), z.strictObject({ lag_min: z.number().int(), reason: z.string().max(200).nullable() })),
  draws: z.record(z.string(), z.number().min(0).max(1)),
  params: ParamOverrides.optional()
});
export type ExternalSchedule = z.infer<typeof ExternalSchedule>;

export function scheduleHash(s: ExternalSchedule): string {
  return hashJson(s);
}

// Key for a service-time draw: job kind, document, stage and attempt.
export function serviceKey(jobKind: string, documentId: string | null, stage: string | null, attempt: number): string {
  return `${jobKind}|${documentId ?? "-"}|${stage ?? "-"}|${attempt}`;
}

// Key for an entry-lag draw: event kind, subject, actor and the ordinal of that triple.
export function entryLagKey(eventKind: string, subject: string, actorId: string, ordinal: number): string {
  return `${eventKind}|${subject}|${actorId}|${ordinal}`;
}

export class ScheduleMissingDraw extends Error {
  readonly code = "schedule_missing_draw";
}
