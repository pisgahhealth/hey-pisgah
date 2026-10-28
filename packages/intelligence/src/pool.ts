import { loadPool, type CaseFile, type Note } from "@hey-pisgah/cases";
import { readFileSync } from "node:fs";
import { CaseId, SimEvent } from "@hey-pisgah/contracts";
import type { Facts } from "@hey-pisgah/workflow";

// One case the investigation tools may read: a discovery history, a verified outcome appended for a second cycle, or an observed EMR journey.
export type PoolCase = {
  case_id: string;
  ward_id: string;
  payer_type: string;
  requirement_version: string;
  facts: Facts;
  events: readonly SimEvent[];
  notes: readonly Note[];
  file: CaseFile | null;
  source: "history" | "outcome" | "observed";
};

// The shape a second-cycle outcome takes on the learning/outcomes stream.
export type OutcomeCase = { case_id: string; ward_id: string; payer_type: string; requirement_version: string; facts: Facts; events: SimEvent[] };

// Observed cases from a file, each event checked against the frozen event shape so nothing else reaches the tools.
export function loadObserved(file: string): OutcomeCase[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { cases?: OutcomeCase[] } | OutcomeCase[];
  const list = Array.isArray(raw) ? raw : raw.cases ?? [];
  return list.map((c) => ({ case_id: CaseId.parse(c.case_id), ward_id: String(c.ward_id), payer_type: String(c.payer_type), requirement_version: String(c.requirement_version), facts: c.facts, events: c.events.map((e) => SimEvent.parse(e)) }));
}

// The discovery pool and nothing else; every lookup outside it answers null, which tools turn into the uniform unknown_id.
export class DiscoveryPool {
  private readonly byId = new Map<string, PoolCase>();
  private readonly events = new Map<string, { case_id: string; event: SimEvent }>();

  constructor(files: readonly CaseFile[] = loadPool("discovery"), outcomes: readonly OutcomeCase[] = [], observed: readonly OutcomeCase[] = []) {
    for (const f of files) {
      if (!f.history) throw new Error(`discovery case ${f.case_id} has no history`);
      const s = f.initial_state;
      this.add({ case_id: f.case_id, ward_id: s.ward_id, payer_type: s.payer_type, requirement_version: s.requirement_version, facts: f.schedule.facts as Facts, events: f.history.events, notes: s.notes, file: f, source: "history" });
    }
    for (const o of outcomes) if (!this.byId.has(o.case_id)) this.add({ ...o, notes: [], file: null, source: "outcome" });
    for (const o of observed) if (!this.byId.has(o.case_id)) this.add({ case_id: o.case_id, ward_id: o.ward_id, payer_type: o.payer_type, requirement_version: o.requirement_version, facts: o.facts, events: o.events, notes: [], file: null, source: "observed" });
  }

  private add(c: PoolCase): void {
    this.byId.set(c.case_id, c);
    for (const e of c.events) this.events.set(e.event_id, { case_id: c.case_id, event: e });
  }

  ids(): string[] {
    return [...this.byId.keys()].sort();
  }

  get(id: unknown): PoolCase | null {
    return typeof id === "string" ? this.byId.get(id) ?? null : null;
  }

  // Only discovery histories carry a frozen schedule, so only they can run in an experiment.
  experimentable(id: unknown): CaseFile | null {
    return this.get(id)?.file ?? null;
  }

  event(id: unknown): { case_id: string; event: SimEvent } | null {
    return typeof id === "string" ? this.events.get(id) ?? null : null;
  }

  // Facts of the cases an experiment or proposal may draw from, for the single-case condition check.
  caseFacts(): Facts[] {
    return this.ids().flatMap((id) => (this.byId.get(id)!.file ? [this.byId.get(id)!.facts] : []));
  }
}
