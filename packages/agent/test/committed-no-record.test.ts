import { describe, expect, it } from "vitest";
import { readStream } from "@hey-pisgah/store";
import { ORDER_REFERENCE_KINDS } from "../src/emr/gate.js";
import type { EmrCommit, Orderables, Provenance, WorkArgs } from "../src/emr/port.js";
import type { SpeakerVerdict, Voiceprint } from "../src/emr/speaker.js";
import { ClerkFake, PAT, VISIT, DOC, clerkBoot, ins } from "./clerking-helpers.js";

const RX_ID = "eeeeeeee-1111-4222-8333-444444444444";
const OWNER: Voiceprint = { vector: [5], ms: 20, model: "nemo_en_titanet_small" };

// An in-memory hospital whose order answers say the write was saved but name no record, or name the visit in its place.
class CommittedFake extends ClerkFake {
  answer: "lost" | "visit_id" = "lost";
  findable = true;
  commits = 0;
  finds = 0;
  private n = 0;
  override kindsFor(): readonly string[] { return [...ORDER_REFERENCE_KINDS]; }
  orderables(): Orderables { return { tests: { fbc: ["full blood count"] }, drugs: { paracetamol_oral: { words: ["paracetamol"], controlled: false } } }; }
  readonly speaker = async (_o: string, _v: readonly number[], _p: Provenance): Promise<SpeakerVerdict> => { this.n += 1; return { speaker: "owner", token: `v2.${String(1_761_700_000_000 + this.n)}.${"B".repeat(22)}.${"A".repeat(43)}` }; };
  override async commit(kind: string, args: WorkArgs, key: string, prov: Provenance): Promise<EmrCommit> {
    if (kind !== "prescribe") return super.commit(kind, args, key, prov);
    this.commits += 1;
    if (!this.writes.some((w) => w.key === key)) this.writes.push({ kind, args, key, prov, id: RX_ID });
    if (this.answer === "visit_id") return { ok: true, record_id: String(args["visit_id"]), record_version: 1, event_ids: [`prescription:${String(args["visit_id"])}`], replayed: false };
    return { ok: false, reason: "committed_without_record", status: 200, retryable: true, counted: false, committed: true };
  }
  async findWrite(kind: string): Promise<{ found: { record_id: string; record_version: number; event_ids: string[] } | null; why?: string }> {
    this.finds += 1;
    const w = this.writes.find((x) => x.kind === kind);
    return this.findable && w ? { found: { record_id: w.id, record_version: 1, event_ids: [`prescription:${w.id}`] } } : { found: null, why: "absent" };
  }
}

function boot(o: { answer?: CommittedFake["answer"]; findable?: boolean; root?: string } = {}) {
  const port = new CommittedFake();
  if (o.answer) port.answer = o.answer;
  if (o.findable === false) port.findable = false;
  return { ...clerkBoot((s) => (s.includes("paracetamol") ? [ins("prescribe", { drug: "paracetamol_oral" })] : []), { port, ...(o.root ? { root: o.root } : {}) }), port };
}
const say = (rt: ReturnType<typeof boot>["rt"]) => rt.say({ owner: DOC, target: { patient_id: PAT }, text: "Give paracetamol, two tablets.", source: "audio", voiceprint: OWNER });
const until = async (f: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); } };
const rx = (rt: ReturnType<typeof boot>["rt"], id: string) => rt.view(id)?.actions.find((a) => a.kind === "prescribe");
const events = (root: string, id: string) => readStream(root, `emr/${id}`);

describe("a hospital success that names no record, on the in-memory hospital", () => {
  it("holds the prescription uncertain under its key, finds it by the record read, and completes it with the prescription's own id, never resending", async () => {
    const { rt, port, root } = boot();
    const r = await say(rt);
    await until(() => rx(rt, r.task_id)?.state === "completed");
    expect(rx(rt, r.task_id)?.proof?.record_id).toBe(RX_ID);
    const ev = events(root, r.task_id).map((e) => e.record_type);
    expect(ev.indexOf("action.uncertain")).toBeLessThan(ev.indexOf("action.reconciled"));
    expect(port.commits).toBe(1);
    await rt.stop();
  });

  it("with no record found it stays uncertain, never sent again, never failed, refused or acknowledged, and the task runs on", async () => {
    const { rt, port, root } = boot({ findable: false });
    const r = await say(rt);
    await until(() => port.finds >= 2);
    expect(port.commits).toBe(1);
    const a = rx(rt, r.task_id)!;
    expect(a.state).toBe("uncertain");
    expect(a.uncertain?.reason).toMatch(/saved/i);
    expect(rt.view(r.task_id)!.state).toBe("running");
    const ev = events(root, r.task_id).map((e) => e.record_type);
    for (const t of ["action.written", "action.refused", "action.failed", "action.retry"]) expect(ev).not.toContain(t);
    expect(port.commits).toBe(1);
    await rt.stop();
  });

  it("never takes the visit id a port names for a new prescription: it is held uncertain and the real id is read", async () => {
    const { rt, port, root } = boot({ answer: "visit_id" });
    const r = await say(rt);
    await until(() => ["completed", "failed", "refused"].includes(rx(rt, r.task_id)?.state ?? ""));
    const written = events(root, r.task_id).filter((e) => e.record_type === "action.written").map((e) => (e.payload as { written: { record_id: string } }).written.record_id);
    expect(written).not.toContain(VISIT);
    expect(rx(rt, r.task_id)).toMatchObject({ state: "completed", proof: { record_id: RX_ID } });
    expect(port.commits).toBe(1);
    await rt.stop();
  });

  it("after a restart a committed write is only read for, never sent again", async () => {
    const first = boot({ findable: false });
    const r = await say(first.rt);
    await until(() => rx(first.rt, r.task_id)?.state === "uncertain");
    await first.rt.stop();
    first.client.close();
    const again = boot({ root: first.root, findable: false });
    again.port.writes.push(...first.port.writes);
    await until(() => again.port.finds >= 2);
    expect(again.port.commits).toBe(0);
    again.port.findable = true;
    await until(() => again.rt.view(r.task_id)?.actions.find((a) => a.kind === "prescribe")?.state === "completed");
    expect(again.port.commits).toBe(0);
    await again.rt.stop();
  });
});
