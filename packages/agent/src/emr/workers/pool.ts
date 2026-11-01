import { availableParallelism } from "node:os";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";

// Which local model a worker holds: the streaming first ear, Parakeet, or the speaker model.
export type ModelKind = "online" | "offline" | "speaker";
// How long the main thread waits for a model to load when the pool starts, as long as loading it in this thread could take.
const LOAD_WAIT_MS = 180_000;
const WORKER_FILE = new URL("./ears.worker.mjs", import.meta.url);

// Workers per model from HEY_PISGAH_EAR_WORKERS: 0 keeps every local model in this thread, a number sizes the streaming pool, unset takes the defaults.
export function earWorkers(kind: ModelKind, given?: number, env = process.env["HEY_PISGAH_EAR_WORKERS"]): number {
  if (given !== undefined) return Math.max(0, Math.floor(given));
  const n = env?.trim() ? Number(env) : NaN;
  if (n === 0) return 0;
  if (kind === "online") return Number.isFinite(n) && n > 0 ? Math.min(32, Math.floor(n)) : Math.max(1, Math.min(4, Math.floor(availableParallelism() / 4)));
  return kind === "speaker" ? 2 : 1;
}

type Reply = { id: number; value?: unknown; error?: string };
type Slot = { w: Worker; pending: Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>; streams: number; dead: Error | null };

// A few threads that each hold the same model; a stream stays on the thread that opened it, and a one-off job goes to the least busy thread.
export class ModelPool {
  private readonly slots: Slot[] = [];
  private next = 1;
  readonly dim: number;
  constructor(private readonly kind: ModelKind, private readonly init: { from: string; config: unknown; flushSamples?: number }, size: number) {
    let dim = 0;
    for (let i = 0; i < Math.max(1, size); i++) {
      const r = this.spawn(true);
      if (!r.ok) { this.close(); throw new Error(r.error); }
      dim = r.dim;
    }
    this.dim = dim;
  }

  // Starts one worker; at start-up the main thread waits for its model, and a replacement loads while the others carry on.
  private spawn(wait: boolean): { ok: true; dim: number } | { ok: false; error: string } {
    const sig = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    const w = new Worker(WORKER_FILE, { workerData: { kind: this.kind, from: this.init.from, config: this.init.config, flushSamples: this.init.flushSamples ?? 0, sig, port: port2 }, transferList: [port2] });
    const slot: Slot = { w, pending: new Map(), streams: 0, dead: null };
    w.on("message", (m: Reply) => {
      const p = slot.pending.get(m.id);
      if (!p) return;
      slot.pending.delete(m.id);
      if (!slot.pending.size) w.unref();
      if (m.error !== undefined) p.no(new Error(m.error)); else p.ok(m.value);
    });
    const down = (e: Error) => {
      if (slot.dead) return;
      slot.dead = e;
      for (const p of slot.pending.values()) p.no(e);
      slot.pending.clear();
      const i = this.slots.indexOf(slot);
      if (i >= 0) this.slots.splice(i, 1);
    };
    w.on("error", (e) => down(e instanceof Error ? e : new Error(String(e))));
    w.on("exit", (code) => down(new Error(`the ${this.kind} ear worker stopped (${code})`)));
    w.unref();
    this.slots.push(slot);
    if (!wait) { port1.close(); return { ok: true, dim: 0 }; }
    Atomics.wait(sig, 0, 0, LOAD_WAIT_MS);
    const msg = receiveMessageOnPort(port1)?.message as { ok: boolean; dim?: number; error?: string } | undefined;
    port1.close();
    if (!msg) return { ok: false, error: `the ${this.kind} model did not load in time` };
    return msg.ok ? { ok: true, dim: msg.dim ?? 0 } : { ok: false, error: msg.error ?? "the model did not load" };
  }

  // A live worker for new work: the least busy, and a new one started when a worker has stopped.
  pick(): Slot {
    if (!this.slots.length) this.spawn(false);
    return this.slots.reduce((a, b) => (b.pending.size + b.streams < a.pending.size + a.streams ? b : a));
  }

  send(slot: Slot, msg: Record<string, unknown>): void {
    if (!slot.dead) slot.w.postMessage(msg);
  }

  ask<T>(slot: Slot, msg: Record<string, unknown>, transfer: ArrayBuffer[] = []): Promise<T> {
    if (slot.dead) return Promise.reject(slot.dead);
    const id = this.next++;
    return new Promise<T>((ok, no) => {
      slot.pending.set(id, { ok: ok as (v: unknown) => void, no });
      slot.w.ref();
      slot.w.postMessage({ ...msg, id }, transfer);
    });
  }

  // A one-off job on the least busy worker.
  job<T>(msg: Record<string, unknown>, transfer: ArrayBuffer[] = []): Promise<T> { return this.ask<T>(this.pick(), msg, transfer); }

  // An id for a stream that lives on one worker.
  stream(): { slot: Slot; s: number } { const slot = this.pick(); slot.streams += 1; return { slot, s: this.next++ }; }
  release(slot: Slot): void { slot.streams = Math.max(0, slot.streams - 1); }

  size(): number { return this.slots.length; }

  // Each worker ends once it has answered what it was already asked, never stopped from outside in the middle of a native call.
  close(): void { for (const s of this.slots.splice(0)) { s.w.postMessage({ op: "exit" }); s.w.unref(); } }
}
