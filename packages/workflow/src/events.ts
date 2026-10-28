// The closed list of simulation event kinds the engine emits; trigger predicates may only name these.
export const SIM_EVENT_KINDS = [
  "step.started", "step.held", "step.completed", "job.queued", "record.versioned", "document.stale", "document.revised",
  "check.verified", "check.repeated", "world.due", "world.busy_started", "world.busy_ended", "world.backlog_arrived",
  "world.record_updated", "action.refused"
] as const;
export type SimEventKind = (typeof SIM_EVENT_KINDS)[number];
export const SIM_EVENT_KIND_SET: ReadonlySet<string> = new Set(SIM_EVENT_KINDS);
