import { readFileSync } from "node:fs";
import { z } from "zod";
import { ActorRole, EventKind, StepId } from "@hey-pisgah/contracts";

const readJson = (rel: string): unknown => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const Tag = z.enum(["observed", "assumed"]);
const Minute = z.number().int().min(0).max(2880);

// World parameters frozen at day-2; each base value says whether it was observed on a ward or assumed.
export const WorldParameters = z.strictObject({
  frozen_at: z.literal("day-2"),
  draft_verification_by_nurse: z.strictObject({ on: z.boolean(), minutes: z.number().int().min(0), tag: Tag }),
  draft_use_by_staff: z.strictObject({ p: z.number().min(0).max(1), tag: Tag }),
  agent_prepare_min: z.strictObject({ minutes: z.number().int().min(1), tag: Tag }),
  base: z.array(z.strictObject({ name: z.string().regex(/^[a-z_]+$/), min: z.number(), max: z.number(), unit: z.enum(["minute_of_day", "minutes", "minutes_after_signoff", "count", "share"]), tag: Tag, note: z.string().max(200) })),
  flow_order: z.strictObject({ text: z.string().max(300), tag: Tag })
});
export type WorldParameters = z.infer<typeof WorldParameters>;

// How each step meets the world: which schedule field times it, which resource serves it and which event it emits.
const SchedulePath = z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/);
export const StepTiming = z.union([
  z.strictObject({ at: SchedulePath, offset: z.number().int() }),
  z.strictObject({ resource: z.enum(["nurse", "pharmacy", "accounts", "claims"]), minutes: SchedulePath.optional(), service: z.string().regex(/^[a-z_:]+$/).optional(), extra: SchedulePath.optional(), not_before: SchedulePath.optional() }),
  z.strictObject({ delay: SchedulePath }),
  z.strictObject({ instant: z.literal(true) })
]);
export type StepTiming = z.infer<typeof StepTiming>;
export const StepBinding = z.strictObject({ event: EventKind, actor: ActorRole, timing: StepTiming, selected_when: SchedulePath.nullable() });
export type StepBinding = z.infer<typeof StepBinding>;
export const WorldBindings = z.strictObject({
  anchors: z.strictObject({ signoff: StepId, departure: StepId, bed_release: StepId }),
  resources: z.record(z.string(), z.strictObject({ kind: z.enum(["staff_server", "fifo"]), backlog_path: SchedulePath.nullable() })),
  steps: z.record(StepId, StepBinding),
  event_kinds: z.array(EventKind).min(1)
});
export type WorldBindings = z.infer<typeof WorldBindings>;

// Local mirror of the simulator's frozen external schedule (PLAN 4.2); replace with the simulator's type at the engine swap.
const Span = z.strictObject({ start: Minute, end: Minute });
export const Schedule = z.strictObject({
  case_id: z.string().regex(/^c-[a-z0-9]{8}$/),
  ward_id: z.string().regex(/^[A-Z][A-Za-z0-9_]*$/),
  payer_type: z.enum(["self_pay", "hmo", "corporate"]),
  staff: z.partialRecord(ActorRole, z.string().regex(/^[a-z][a-z0-9_]*$/)),
  doctor: z.strictObject({
    round_at: Minute, expected_discharge_at: Minute, expected_disposition: z.enum(["home", "transfer_out", "other"]),
    signoff_at: Minute.nullable(), signoff_disposition: z.enum(["home", "transfer_out", "other"]), follow_up: z.string().max(200),
    take_home_orders: z.array(z.strictObject({ item: z.string().max(80), qty: z.number().int().min(1) })),
    amendments: z.array(z.strictObject({ at: Minute, item: z.string().max(80), change: z.enum(["add", "remove", "dose"]) }))
  }),
  pharmacy: z.strictObject({ backlog: z.array(z.number().int().min(0)), review_min: z.number().int().min(0), dispense_min: z.number().int().min(0), screen_block: z.strictObject({ resolve_min: z.number().int().min(0) }).nullable(), substitution: z.strictObject({ item: z.string().max(80) }).nullable() }),
  accounts: z.strictObject({ backlog: z.array(z.number().int().min(0)), sponsor_arrival_at: Minute, payment_min: z.number().int().min(0), waiver: z.strictObject({ delay_min: z.number().int().min(0) }).nullable(), on_account: z.strictObject({ delay_min: z.number().int().min(0) }).nullable() }),
  insurer: z.strictObject({ response_delay: z.number().int().min(0), decision: z.enum(["approved", "partial", "declined"]) }).nullable(),
  nurses: z.array(z.strictObject({ nurse_id: z.string().regex(/^[a-z][a-z0-9_]*$/), shift: Span, busy_blocks: z.array(Span) })).min(1),
  service_min: z.record(z.string(), z.number().int().min(0)),
  entry_lag: z.record(z.string(), z.strictObject({ lag_min: z.number().int().min(0).max(1440), reason: z.string().max(200).nullable() }))
});
export type Schedule = z.infer<typeof Schedule>;

export const loadWorldParameters = (): WorldParameters => WorldParameters.parse(readJson("./data/parameters.json"));
export const loadWorldBindings = (): WorldBindings => WorldBindings.parse(readJson("./data/world-bindings.json"));

// Reads a dotted path from the schedule; a missing or null link returns null.
export function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[key] ?? null;
  }
  return cur;
}
