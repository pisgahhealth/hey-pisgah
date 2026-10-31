import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { startEmrServe, type EmrTaskView } from "@hey-pisgah/agent";
import { ModelClient } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { PisgahPort } from "../src/port.js";
import { loadProfile } from "../src/profile.js";
import { mintAgentBearer, sandboxQuery } from "../src/sandbox.js";
import { speak, VOICES } from "./e3.sandbox.test.js";
import { freshArrival, paceAudio, sandboxEmbedder } from "./sandbox-helpers.js";

// Runs only with SANDBOX=1 and REC=1: orders on the real door whose answers say saved but name no record, then the same order said twice; the gate is live, everything else is by rule.
const RUN = process.env["SANDBOX"] === "1" && process.env["REC"] === "1";
const SERVE_PORT = Number(process.env["HEY_PISGAH_EMR_PORT"] ?? 4185);
const COMMITTED_ANSWER_LOST = { ok: true, committed: true, answer: "lost", message: "The write was saved, but its answer could not be built; read the record." };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Post = { path: string; visit: string | null; status: number; replaced: boolean; at: string };

// A fetch that lets each order reach the door and, for the visits named, swaps the door's answer for the one it keeps when a committed write cannot answer.
function committedLost(posts: Post[], lose: Set<string>): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    const path = String(input).replace(/\?.*$/, "");
    if (init?.method !== "POST" || !/consult\/(prescribe|order-send)$/.test(path)) return res;
    const text = await res.text();
    const visit = /"visitId":"([0-9a-f-]{36})"/.exec(String(init.body ?? ""))?.[1] ?? null;
    const replaced = res.ok && !!visit && lose.delete(visit);
    posts.push({ path: path.replace(/^.*\/v1\//, ""), visit, status: res.status, replaced, at: new Date().toISOString() });
    if (replaced) return new Response(JSON.stringify(COMMITTED_ANSWER_LOST), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(text, { status: res.status, headers: res.headers });
  };
}

describe.skipIf(!RUN)("REC on the sandbox EMR", () => {
  it("keeps a saved order with no record id uncertain until the record names it, and holds the same order said twice for the owner's yes", async () => {
    const profile = loadProfile();
    const embed = sandboxEmbedder();
    expect(embed).not.toBeNull();
    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
    // Names share no word with a hand-off title, since the hospital refuses a task title that names the patient.
    const A = await freshArrival(profile, `REC Ama ${stamp}`);
    const B = await freshArrival(profile, `REC Bisi ${stamp}`);
    const C = await freshArrival(profile, `REC Chidi ${stamp}`);
    const sb = A.sb;
    const mine = mintAgentBearer(sb);
    const posts: Post[] = [];
    const lose = new Set([A.visit, B.visit]);
    const port = new PisgahPort(profile, { bearers: { [mine.owner]: mine.bearer }, fetch: committedLost(posts, lose) });
    const out: Record<string, unknown> = { stamp, owner: mine.owner, synthetic: true, patients: { A: A.patient, B: B.patient, C: C.patient }, visits: { A: A.visit, B: B.visit, C: C.visit } };
    const save = () => { const f = process.env["HEY_PISGAH_REC_OUT"]; if (f) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `${JSON.stringify(out, null, 1)}\n`); } };
    for (const v of [A, B, C]) expect(await port.commit("open_consult", { visit_id: v.visit, patient_id: v.patient }, `rec-${stamp}-open-${v.visit}`, { owner: mine.owner, evidence: `transcript:rec-${stamp}-open`, spoken_at: new Date().toISOString() })).toMatchObject({ ok: true });
    const root = mkdtempSync(join(tmpdir(), "hp-rec-sb-"));
    const client = new ModelClient({ storeRoot: root, mode: "live", recordingsDir: join(root, "recordings"), taskStateOf: (id) => s.runtime.stateOf(id) });
    const s = await startEmrServe({ storeRoot: root, port, client, embed: embed!, listenPort: SERVE_PORT, ears: "off", runtime: { holdMs: 500, proofRetryMs: 1500, reconcileMs: [2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000] } });
    const lookup = profile.work["order_test"] && "method" in profile.work["order_test"] ? profile.work["order_test"].lookup : undefined;
    expect(lookup).toBeDefined();
    let n = 0;
    // Every line is its own recording, since the door gives one recording a token for one line only.
    const say = async (v: { patient: string }, text: string) => {
      n += 1;
      const print = (await embed!(speak(VOICES.owner, `${text} Run ${stamp} line ${n}.`, join(root, `l${n}.wav`))))!;
      await paceAudio(print);
      const r = await s.runtime.say({ owner: mine.owner, target: { patient_id: v.patient }, text, source: "audio", voiceprint: print });
      await s.runtime.settled(120_000);
      return r;
    };
    const view = async (id: string) => (await (await fetch(`${s.url}/tasks/${id}`)).json()) as EmrTaskView;
    const states = (v: { visit: string }) => sandboxQuery(sb, "order_states_for_visit", { visit: v.visit });
    const until = async (id: string, ok: (v: EmrTaskView) => boolean, ms: number) => { const end = Date.now() + ms; for (;;) { const v = await view(id); if (ok(v)) return v; if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v.actions.map((a) => [a.kind, a.state]))}`); await wait(500); } };
    try {
      // 1a. A prescription saved with no record id is read for and completes with the prescription's own id.
      const rx = await say(A, "Give paracetamol tablets five hundred milligrams by mouth three times a day, quantity six.");
      const rxDone = await until(rx.task_id, (v) => v.actions.some((a) => a.kind === "prescribe" && ["completed", "refused", "failed"].includes(a.state)), 90_000);
      const rxAct = rxDone.actions.find((a) => a.kind === "prescribe")!;
      const rxRows = states(A);
      out["a_prescription"] = { state: rxAct.state, proof: rxAct.proof?.record_id ?? null, visit: A.visit, db: rxRows.map((x) => ({ id: x["id"], prescription_id: x["prescription_id"] })), events: readStream(root, `emr/${rx.task_id}`).map((e) => e.record_type).filter((t) => t.startsWith("action.")) };
      save();
      expect(rxAct.state).toBe("completed");
      expect(rxAct.proof?.record_id).not.toBe(A.visit);
      expect(rxRows).toHaveLength(1);
      expect(rxAct.proof?.record_id).toBe(rxRows[0]!["prescription_id"]);

      // 1b. A test saved with no record id and no lookup stays uncertain, the strip's view says so, and nothing is sent again; once the lookup is back the next read names it.
      const work = profile.work["order_test"] as { lookup?: unknown };
      delete work.lookup;
      const lab = await say(B, "Send a full blood count.");
      const held = await until(lab.task_id, (v) => v.actions.some((a) => a.kind === "order_test" && a.state === "uncertain"), 60_000);
      await wait(6000);
      const still = await view(lab.task_id);
      const labAct = still.actions.find((a) => a.kind === "order_test")!;
      out["b_uncertain"] = { state: labAct.state, uncertain: labAct.uncertain ?? null, task: still.state, strip_label: labAct.state === "uncertain" ? "Checking the save" : null, db_rows: states(B).length, posts: posts.filter((p) => p.visit === B.visit).length, notes: still.notes.map((x) => x.text).slice(-2) };
      save();
      expect(held.state).toBe("running");
      expect(labAct.state).toBe("uncertain");
      expect(states(B)).toHaveLength(1);
      expect(posts.filter((p) => p.visit === B.visit)).toHaveLength(1);
      work.lookup = lookup;
      const labDone = await until(lab.task_id, (v) => v.actions.some((a) => a.kind === "order_test" && a.state === "completed"), 60_000);
      const labRows = states(B);
      out["b_found"] = { proof: labDone.actions.find((a) => a.kind === "order_test")!.proof?.record_id ?? null, db: labRows.map((x) => x["id"]), posts: posts.filter((p) => p.visit === B.visit).length };
      save();
      expect(labDone.actions.find((a) => a.kind === "order_test")!.proof?.record_id).toBe(labRows[0]!["id"]);
      expect(posts.filter((p) => p.visit === B.visit)).toHaveLength(1);

      // 2. D35: the same test said twice is held with its time, the owner's yes releases exactly one, a different test and the other patient are not held.
      const first = await say(C, "Send a full blood count.");
      await until(first.task_id, (v) => v.actions.some((a) => a.kind === "order_test" && a.state === "completed"), 60_000);
      const again = await say(C, "Send a full blood count.");
      const asked = await view(again.task_id);
      const question = asked.questions.at(-1)?.text ?? "";
      const heldRows = states(C).length;
      const yes = await say(C, "Yes.");
      await until(yes.task_id, (v) => v.actions.filter((a) => a.kind === "order_test" && a.state === "completed").length === 2, 60_000);
      const afterYes = states(C).length;
      await say(C, "Send a urinalysis.");
      await until(first.task_id, (v) => v.actions.filter((a) => a.kind === "order_test" && a.state === "completed").length === 3, 60_000);
      const other = await say(A, "Send a full blood count.");
      const otherView = await until(other.task_id, (v) => v.actions.some((a) => a.kind === "order_test" && ["completed", "proposed"].includes(a.state)), 60_000);
      const final = await view(first.task_id);
      out["d35"] = {
        question, rows_while_held: heldRows, rows_after_yes: afterYes, rows_after_urinalysis: states(C).length,
        other_patient: { state: otherView.actions.find((a) => a.kind === "order_test")?.state, held: otherView.questions.some((q) => /Already ordered/.test(q.text)), rows: states(A).filter((x) => x["diagnostic_order_id"]).length },
        actions: final.actions.filter((a) => a.kind === "order_test").map((a) => [a.state, a.awaiting ?? null]), calls: final.calls + otherView.calls, usd: Number((final.usd + otherView.usd).toFixed(4))
      };
      save();
      expect(question).toMatch(/Already ordered at \d{2}:\d{2}\. Order again\?/);
      expect(heldRows).toBe(1);
      expect(afterYes).toBe(2);
      expect(states(C)).toHaveLength(3);
      expect(otherView.questions.some((q) => /Already ordered/.test(q.text))).toBe(false);
      expect(otherView.actions.find((a) => a.kind === "order_test")?.state).toBe("completed");
    } finally {
      out["posts"] = posts;
      save();
      await s.close();
      client.close();
    }
  }, 15 * 60_000);
});
