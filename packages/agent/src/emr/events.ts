import type { EmrEvent, EmrPort } from "./port.js";

export type EventsLoopOptions = {
  port: Pick<EmrPort, "events">;
  // The order record ids this owner's held work waits on, read again before each wait.
  orders: (owner: string) => readonly string[];
  onEvents: (owner: string, events: readonly EmrEvent[]) => void;
  wallNow?: () => Date;
  log?: (line: string) => void;
  // How long to wait after a failed wait before the next one; doubled up to a minute.
  retryMs?: number;
};

// One long wait per owner on the hospital's events route, so new tasks and results arrive without polling the door.
export class EventsLoop {
  private readonly running = new Set<string>();
  private stopped = false;

  constructor(private readonly o: EventsLoopOptions) {}

  // Starts waiting for an owner once; an owner already waited for is left as it is.
  watch(owner: string): void {
    if (this.stopped || this.running.has(owner) || !this.o.port.events) return;
    this.running.add(owner);
    void this.run(owner).finally(() => this.running.delete(owner));
  }

  owners(): string[] { return [...this.running]; }

  stop(): void { this.stopped = true; }

  private async run(owner: string): Promise<void> {
    let cursor: string | null = null;
    let backoff = this.o.retryMs ?? 2_000;
    while (!this.stopped) {
      try {
        const t0 = Date.now();
        const r = await this.o.port.events!(owner, cursor, this.o.orders(owner), { owner, evidence: "watch:events", spoken_at: (this.o.wallNow?.() ?? new Date()).toISOString() });
        if (this.stopped) return;
        const first = cursor === null;
        cursor = r.cursor;
        backoff = this.o.retryMs ?? 2_000;
        if (r.events.length) this.o.onEvents(owner, r.events);
        // A wait that came back at once with nothing is not waited on again at once, so a hospital that does not hold the wait is never asked in a loop.
        else if (!first && Date.now() - t0 < 500) await new Promise((res) => setTimeout(res, 1_000).unref());
      } catch (e) {
        this.o.log?.(`events ${owner}: ${e instanceof Error ? e.message : String(e)}`);
        await new Promise((res) => setTimeout(res, backoff).unref());
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }
}
