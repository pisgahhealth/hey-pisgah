import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GATE_FACTS } from "./gate.js";
import { OBSERVATION_KIND, type EmrCommit, type EmrContext, type EmrPort, type EmrProof, type EmrTarget, type EmrWriteKind, type ObservationArgs, type Provenance } from "./port.js";

// The part of a patient context the gate reads, kept so a replay builds the same prompts.
export type KeptContext = { label: string; facts: Record<string, string | null>; keywords: string[] };

// An in-memory hospital for replays and tests: one fixed context, writes kept in order, and a read that shows the latest write.
export class MemoryEmrPort implements EmrPort {
  readonly writeKinds = [OBSERVATION_KIND] as const;
  readonly writes: { id: string; args: ObservationArgs; key: string; prov: Provenance }[] = [];
  constructor(private readonly kept: KeptContext, private readonly admissionId: string) {}
  refusedCount(): number { return 0; }
  async resolve(_target: EmrTarget, _prov: Provenance): Promise<EmrContext> {
    return { admission_id: this.admissionId, patient_id: null, label: this.kept.label, facts: { ...this.kept.facts }, keywords: [...this.kept.keywords] };
  }
  async commit(_k: EmrWriteKind, args: ObservationArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    const hit = this.writes.find((w) => w.key === key);
    if (!hit) this.writes.push({ id: `mem-${this.writes.length + 1}`, args, key, prov });
    const w = this.writes.find((x) => x.key === key)!;
    return { ok: true, record_id: w.id, record_version: 1, event_ids: [`observation:${w.id}`], replayed: !!hit };
  }
  async prove(_k: EmrWriteKind, _args: ObservationArgs, written: { record_id: string; record_version: number; event_ids: string[] }): Promise<EmrProof | null> {
    return this.writes.at(-1)?.id === written.record_id ? { ...written, record_hash: "0".repeat(64), verified_at: new Date().toISOString(), read: "memory" } : null;
  }
}

// Wraps a live port so the first context it resolves is kept on disk, label and gate facts only.
export function keepingContext(inner: EmrPort, file: string): EmrPort {
  return {
    writeKinds: inner.writeKinds,
    refusedCount: () => inner.refusedCount(),
    commit: (k, a, key, p) => inner.commit(k, a, key, p),
    prove: (k, a, w, p) => inner.prove(k, a, w, p),
    resolve: async (t, p) => {
      const ctx = await inner.resolve(t, p);
      if (!existsSync(file)) {
        const kept: KeptContext = { label: ctx.label, facts: Object.fromEntries(GATE_FACTS.map((k) => [k, ctx.facts[k] ?? null])), keywords: [] };
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(kept, null, 1)}\n`);
      }
      return ctx;
    }
  };
}
export const readKeptContext = (file: string): KeptContext => JSON.parse(readFileSync(file, "utf8")) as KeptContext;
