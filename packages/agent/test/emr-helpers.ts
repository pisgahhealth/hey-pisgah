import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelClient, type ChatCompletion, type MockResponder } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import type { LedgerRow } from "@hey-pisgah/contracts";
import type { GateClause } from "../src/emr/gate.js";
import { OBSERVATION_KIND, type EmrCommit, type EmrContext, type EmrPort, type EmrProof, type EmrTarget, type ObservationArgs, type Provenance } from "../src/emr/port.js";

export const ADM = "11111111-2222-4333-8444-555555555555";
export const PATIENT = "99999999-8888-4777-8666-555555555555";
export const OWNER = "owner-1";
export const emrRoot = () => mkdtempSync(join(tmpdir(), "hp-emr-"));

type Stored = { id: string; args: ObservationArgs; key: string; prov: Provenance };
// An in-memory hospital: the same idempotency key replays the first write, and reads show the latest write.
export class FakeEmr implements EmrPort {
  readonly writeKinds = [OBSERVATION_KIND] as const;
  readonly writes: Stored[] = [];
  readonly calls: { op: string; prov: Provenance; key?: string }[] = [];
  failNext: ("network" | "refuse")[] = [];
  private n = 0;
  refusedCount(): number { return 0; }
  async resolve(target: EmrTarget, prov: Provenance): Promise<EmrContext> {
    this.calls.push({ op: "resolve", prov });
    const admission = target.admission_id ?? (target.patient_id === PATIENT ? ADM : null);
    if (!admission) throw new Error("unknown target");
    const last = this.writes.at(-1)?.args;
    return { admission_id: admission, patient_id: PATIENT, label: "Test Patient", facts: { ward: "Ward A", pulse: last?.pulse !== undefined ? String(last.pulse) : null }, keywords: ["Ward A"] };
  }
  async commit(_k: typeof OBSERVATION_KIND, args: ObservationArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    this.calls.push({ op: "commit", prov, key });
    const fail = this.failNext.shift();
    const hit = this.writes.find((w) => w.key === key);
    if (fail === "refuse") return { ok: false, reason: "door_403", status: 403, retryable: false, counted: false };
    if (!hit) { this.n += 1; this.writes.push({ id: `obs-${this.n}`, args, key, prov }); }
    if (fail === "network") return { ok: false, reason: "timeout", status: null, retryable: true, counted: false };
    const w = this.writes.find((x) => x.key === key)!;
    return { ok: true, record_id: w.id, record_version: 1, event_ids: [`observation:${w.id}`], replayed: !!hit };
  }
  async prove(_k: typeof OBSERVATION_KIND, args: ObservationArgs, written: { record_id: string; record_version: number; event_ids: string[] }, prov: Provenance): Promise<EmrProof | null> {
    this.calls.push({ op: "prove", prov });
    const last = this.writes.at(-1);
    if (!last || last.id !== written.record_id || JSON.stringify(last.args) !== JSON.stringify(args)) return null;
    return { ...written, record_hash: "0".repeat(64), verified_at: new Date().toISOString(), read: "fake" };
  }
}

export type Decision = Record<string, unknown>;
// A mock model that reads the clinician's words from the user message and answers with one decide call.
export function decider(script: (said: string, user: string) => Decision): MockResponder {
  return ({ body, hash }) => {
    const msgs = body["messages"] as { role: string; content: string }[];
    const user = String(msgs.find((m) => m.role === "user")?.content ?? "");
    const said = JSON.parse(/clinician_said: (".*")$/m.exec(user)?.[1] ?? '""') as string;
    const c: ChatCompletion = {
      id: `mock-${hash.slice(0, 12)}`, object: "chat.completion", created: 0, model: String(body["model"]),
      choices: [{ index: 0, finish_reason: "tool_calls", logprobs: null, message: { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "decide", arguments: JSON.stringify(script(said, user)) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    };
    return c;
  };
}

export function mockClient(root: string, script: (said: string, user: string) => Decision, stateOf: () => ((id: string) => ReturnType<NonNullable<ConstructorParameters<typeof ModelClient>[0]["taskStateOf"]>>) | null): ModelClient {
  return new ModelClient({ storeRoot: root, mode: "mock", mock: decider(script), taskStateOf: (id) => stateOf()?.(id) ?? null });
}

export const ledgerRows = (root: string, runId: string): LedgerRow[] => readStream(root, `ledger/${runId}`).filter((e) => e.record_type === "model.call").map((e) => e.payload as LedgerRow);
export const until = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error("condition not reached"); await new Promise((r) => setTimeout(r, 5)); }
};

export type C = Partial<GateClause> & { class: GateClause["class"] };
const clause = (c: C): GateClause => ({ words: "words", ...c }) as GateClause;
// A mock model that answers each gate call from a script keyed by the clinician's words.
export function gater(script: (said: string, user: string) => C[], seen: string[] = []): MockResponder {
  return ({ body, hash }) => {
    const msgs = body["messages"] as { role: string; content: string }[];
    const user = String(msgs.find((m) => m.role === "user")?.content ?? "");
    const said = JSON.parse(/clinician_said: (".*")$/m.exec(user)?.[1] ?? '""') as string;
    seen.push(said);
    const c: ChatCompletion = {
      id: `mock-${hash.slice(0, 12)}`, object: "chat.completion", created: 0, model: String(body["model"]),
      choices: [{ index: 0, finish_reason: "tool_calls", logprobs: null, message: { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "gate", arguments: JSON.stringify({ clauses: script(said, user).map((c) => clause({ words: said, ...c })) }) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    };
    return c;
  };
}
