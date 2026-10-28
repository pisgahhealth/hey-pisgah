import type { EventPredicate } from "@hey-pisgah/contracts";
import type { WakeRec } from "./task.js";
import type { ViewEvent } from "./world.js";

const str = (p: unknown, k: string): string | null => {
  const v = (p as Record<string, unknown> | null)?.[k];
  return typeof v === "string" ? v : null;
};

function leafHolds(p: EventPredicate, events: readonly ViewEvent[]): boolean {
  if ("on" in p) return events.some((e) => e.kind === p.on && Object.entries(p.where ?? {}).every(([k, v]) => str(e.payload, k) === v));
  if ("after" in p) return events.some((e) => e.kind === "step.completed" && str(e.payload, "step_id") === p.after.step);
  return "all_of" in p ? p.all_of.every((x) => leafHolds(x, events)) : p.any_of.some((x) => leafHolds(x, events));
}

// Events recorded after the wake was registered: a later minute, or a later agent write in the same minute.
export function eventsAfter(events: readonly ViewEvent[], after: WakeRec["after"]): ViewEvent[] {
  return events.filter((e) => e.recorded_at > after.minute || (e.source === "port" && e.recorded_at === after.minute && e.seq > after.port_writes));
}

export type Firing = { wake_id: string; trigger: string; at: number; order: number };

// Where a wake fires: the first event at which its predicate holds over what was recorded since registration, else its deadline or the horizon.
export function fireOf(w: WakeRec, events: readonly ViewEvent[], now: number, horizon: number): Firing | null {
  const fresh = eventsAfter(events, w.after);
  for (let i = 0; i < fresh.length; i++) {
    if (leafHolds(w.predicate, fresh.slice(0, i + 1))) return { wake_id: w.wake_id, trigger: fresh[i]!.event_id, at: fresh[i]!.recorded_at, order: events.indexOf(fresh[i]!) };
  }
  const deadline = w.deadline_simulated_min;
  if (deadline !== null && now >= deadline) return { wake_id: w.wake_id, trigger: "timeout", at: deadline, order: Number.MAX_SAFE_INTEGER };
  if (now >= horizon) return { wake_id: w.wake_id, trigger: "timeout", at: horizon, order: Number.MAX_SAFE_INTEGER };
  return null;
}

// The earliest firing among a task's open wakes; an event wins over a deadline at the same minute.
export function firstFiring(wakes: readonly WakeRec[], events: readonly ViewEvent[], now: number, horizon: number): Firing | null {
  const f = wakes.map((w) => fireOf(w, events, now, horizon)).filter((x): x is Firing => x !== null);
  f.sort((a, b) => a.at - b.at || a.order - b.order || (a.wake_id < b.wake_id ? -1 : 1));
  return f[0] ?? null;
}
