// One server with exogenous busy blocks and a FIFO queue; other-patient backlog jobs share the queue.
export type QueuedJob = { job_id: string; key: string; enqueued_at: number; duration: number; own: boolean };

export class Server {
  busyUntil = -1;
  readonly queue: QueuedJob[] = [];
  minutesWorked = 0;

  constructor(readonly role: string, readonly blocks: readonly { from: number; to: number }[]) {}

  enqueue(j: QueuedJob): void {
    this.queue.push(j);
    this.queue.sort((a, b) => a.enqueued_at - b.enqueued_at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  // Earliest start at or after t where the job fits entirely outside every busy block.
  earliestStart(t: number, duration: number): number {
    let s = t;
    for (let moved = true; moved;) {
      moved = false;
      for (const b of this.blocks) {
        if (s < b.to && s + duration > b.from) { s = b.to; moved = true; }
      }
    }
    return s;
  }

  idle(t: number): boolean { return this.busyUntil <= t; }
}
