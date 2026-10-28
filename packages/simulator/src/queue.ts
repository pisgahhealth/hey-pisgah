import { canonical, sha256 } from "@hey-pisgah/contracts";

// Phase order inside one minute: the outside world, then finished work, then staff picking up work, then executor decisions.
export const Phase = { external: 0, resource_completion: 1, staff_reaction: 2, executor_decision: 3 } as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export function stableKey(caseId: string, jobId: string, attempt: number): string {
  return sha256(canonical([caseId, jobId, attempt]));
}

export type QueueEntry = { time: number; phase: Phase; key: string; order: number; run: () => void };

function before(a: QueueEntry, b: QueueEntry): boolean {
  if (a.time !== b.time) return a.time < b.time;
  if (a.phase !== b.phase) return a.phase < b.phase;
  if (a.key !== b.key) return a.key < b.key;
  return a.order < b.order;
}

// Binary heap ordered by (time, phase, stable_key), with insertion order as the last tie-break.
export class PriorityQueue {
  private readonly heap: QueueEntry[] = [];
  private order = 0;

  get size(): number { return this.heap.length; }

  push(e: Omit<QueueEntry, "order">): void {
    const h = this.heap;
    h.push({ ...e, order: this.order++ });
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }

  peek(): QueueEntry | undefined { return this.heap[0]; }

  pop(): QueueEntry | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0 && last) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && before(h[l]!, h[m]!)) m = l;
        if (r < h.length && before(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}
