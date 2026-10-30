import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMERGENCY_KIND, startEmrServe, type EmrTaskView } from "@hey-pisgah/agent";
import { ModelClient } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { DoorProfile, loadProfile } from "../src/profile.js";
import { PisgahPort } from "../src/port.js";
import { SandboxBlock, mintAgentBearer, sandboxQuery } from "../src/sandbox.js";

// Runs only with SANDBOX=1 and F4=1: an arrival on the real door whose answers are lost on the way back, then a restart, counting the rows the hospital holds.
const RUN = process.env["SANDBOX"] === "1" && process.env["F4"] === "1";
const SERVE_PORT = Number(process.env["HEY_PISGAH_EMR_PORT"] ?? 4141);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Post = { status: number; replayed: boolean; lost: boolean; at: string };

// A fetch that reaches the door and then loses the answer to the arrival write while lose is above zero.
function losing(posts: Post[], replayedHeader: string, state: { lose: number }): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    if (init?.method !== "POST" || !String(input).endsWith("aande/unnamed-encounter")) return res;
    const text = await res.text();
    const lost = state.lose > 0;
    posts.push({ status: res.status, replayed: (res.headers.get(replayedHeader) ?? "") === "true", lost, at: new Date().toISOString() });
    if (lost) { state.lose -= 1; throw new DOMException("the answer was lost", "TimeoutError"); }
    return new Response(text, { status: res.status, headers: res.headers });
  };
}

describe.skipIf(!RUN)("F4 on the sandbox EMR: an arrival whose answers are lost", () => {
  it("stays uncertain through two lost answers, is reconciled under its own key after a restart, and the hospital holds one arrival; a record read settles another without a second send", async () => {
    const full = loadProfile();
    const sb = SandboxBlock.parse(full.sandbox);
    const clinic = process.env["HEY_PISGAH_EMERGENCY_CLINIC"]!;
    expect(clinic).toMatch(/^[0-9a-f-]{36}$/);
    const minted = mintAgentBearer(sb);
    const noLookup = DoorProfile.parse({ ...full, work: { ...full.work, [EMERGENCY_KIND]: { ...full.work[EMERGENCY_KIND], lookup: undefined } } });
    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
    const out: Record<string, unknown> = { owner: minted.owner, stamp };
    const save = () => { if (process.env["HEY_PISGAH_F4_OUT"]) writeFileSync(process.env["HEY_PISGAH_F4_OUT"], `${JSON.stringify(out, null, 1)}\n`); };
    const boot = async (profile: DoorProfile, root: string, posts: Post[], state: { lose: number }) => {
      const port = new PisgahPort(profile, { bearers: { [minted.owner]: minted.bearer }, fetch: losing(posts, profile.headers.replayed, state) });
      const client = new ModelClient({ storeRoot: root, mode: "mock", mock: () => { throw new Error("no model call is expected"); }, taskStateOf: () => null });
      const s = await startEmrServe({ storeRoot: root, port, client, listenPort: SERVE_PORT, emergencyClinicId: clinic, ears: "off", runtime: { holdMs: 0, proofRetryMs: 1500, reconcileMs: [1500, 1500] } });
      return { s, close: async () => { await s.close(); client.close(); } };
    };
    const until = async (get: () => EmrTaskView | null, ok: (v: EmrTaskView) => boolean, ms: number) => {
      const end = Date.now() + ms;
      for (;;) { const v = get(); if (v && ok(v)) return v; if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v?.actions)}`); await wait(250); }
    };
    const open = async (url: string, reason: string) => {
      const r = await fetch(`${url}/tasks/emergency`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: minted.owner, spokenAt: new Date().toISOString(), text: `hey Pisgah, emergency, ${reason}` }) });
      expect(r.status).toBe(202);
      return String(((await r.json()) as Record<string, unknown>)["task_id"]);
    };
    const rows = (reason: string) => sandboxQuery(sb, "f4_arrivals", { reason: `Emergency arrival: ${reason}` });

    // A: no record read, so only the door's key store can settle it; the first answer and three replays are lost, then the process stops.
    const reasonA = `ZZ-TEST F4 lost answer ${stamp}`;
    const rootA = mkdtempSync(join(tmpdir(), "hp-f4-a-"));
    const postsA1: Post[] = [];
    const first = await boot(noLookup, rootA, postsA1, { lose: 4 });
    const taskA = await open(first.s.url, reasonA);
    const held = await until(() => first.s.runtime.view(taskA), (v) => (v.actions[0]?.uncertain?.attempts ?? 0) >= 4, 120_000);
    expect(held.actions[0]).toMatchObject({ kind: EMERGENCY_KIND, state: "uncertain" });
    expect(held.state).toBe("running");
    expect(rows(reasonA)).toHaveLength(1);
    await first.close();
    out["a_first_process"] = { posts: postsA1, state: held.actions[0]!.state, uncertain: held.actions[0]!.uncertain, rows: rows(reasonA).length };
    save();
    const postsA2: Post[] = [];
    const second = await boot(noLookup, rootA, postsA2, { lose: 0 });
    const doneA = await until(() => second.s.runtime.view(taskA), (v) => v.actions[0]?.state === "completed" || v.actions[0]?.state === "refused", 120_000);
    await second.s.runtime.settled();
    expect(doneA.actions[0]!.state).toBe("completed");
    const rA = rows(reasonA);
    expect(rA).toHaveLength(1);
    expect(doneA.patient_id).toBe(rA[0]!["patient"]);
    expect(postsA2[0]).toMatchObject({ status: 200, replayed: true });
    const evA = readStream(rootA, `emr/${taskA}`).map((e) => e.record_type);
    expect(evA).not.toContain("action.failed");
    out["a_restart"] = { posts: postsA2, state: doneA.actions[0]!.state, patient: doneA.patient_id, rows: rA.length, events: evA };
    save();
    await second.close();

    // B: with the record read, one lost answer is settled by reading the board, with no second send.
    const reasonB = `ZZ-TEST F4 found by record ${stamp}`;
    const rootB = mkdtempSync(join(tmpdir(), "hp-f4-b-"));
    const postsB: Post[] = [];
    const third = await boot(full, rootB, postsB, { lose: 1 });
    const taskB = await open(third.s.url, reasonB);
    const doneB = await until(() => third.s.runtime.view(taskB), (v) => v.actions[0]?.state === "completed" || v.actions[0]?.state === "refused", 120_000);
    await third.s.runtime.settled();
    const evB = readStream(rootB, `emr/${taskB}`).map((e) => e.record_type);
    const rB = rows(reasonB);
    out["b_record_read"] = { posts: postsB, state: doneB.actions[0]!.state, patient: doneB.patient_id, rows: rB.length, events: evB };
    await third.close();
    save();
    expect(doneB.actions[0]!.state).toBe("completed");
    expect(rB).toHaveLength(1);
    expect(doneB.patient_id).toBe(rB[0]!["patient"]);
    // A same-minute arrival by another lane makes the read ambiguous, and then the same key is sent again and replayed.
    if (evB.includes("action.reconciled")) expect(postsB).toHaveLength(1);
    else expect(postsB[1]).toMatchObject({ status: 200, replayed: true });
  }, 600_000);
});
