import { loadPool, type CaseFile, type Note } from "@hey-pisgah/cases";
import type { SimEvent } from "@hey-pisgah/contracts";
import type { Facts } from "@hey-pisgah/workflow";

// One case the investigation tools may read: a discovery history, or a verified outcome appended for a second cycle.
export type PoolCase = {
  case_id: string;
  ward_id: string;
  payer_type: string;
  requirement_version: string;
  facts: Facts;
  events: readonly SimEvent[];
  notes: readonly Note[];
  file: CaseFile | null;
  source: "history" | "outcome";
};

// The shape a second-cycle outcome takes on the learning/outcomes stream.
export type OutcomeCase = { case_id: string; ward_id: string; payer_type: string; requirement_version: string; facts: Facts; events: SimEvent[] };

// The discovery pool and nothing else; every lookup outside it answers null, which tools turn into the uniform unknown_id.
export class DiscoveryPool {
  private readonly byId = new Map<string, PoolCase>();
  private readonly events = new Map<string, { case_id: string; event: SimEvent }>();

  constructor(files: readonly CaseFile[] = loadPool("discovery"), outcomes: readonly OutcomeCase[] = []) {
    for (const f of files) {
      if (!f.history) throw new Error(`discovery case ${f.case_id} has no history`);
      const s = f.initial_state;
      this.add({ case_id: f.case_id, ward_id: s.ward_id, payer_type: s.payer_type, requirement_version: s.requirement_version, facts: f.schedule.facts as Facts, events: f.history.events, notes: s.notes, file: f, source: "history" });
    }
    for (const o of outcomes) if (!this.byId.has(o.case_id)) this.add({ ...o, notes: [], file: null, source: "outcome" });
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
