import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startEmrServe, type EmrRuntime, type EmrTaskView } from "@hey-pisgah/agent";
import type { LedgerRow } from "@hey-pisgah/contracts";
import { ModelClient } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { loadProfile } from "../src/profile.js";
import { PisgahPort, type DoorLog } from "../src/port.js";
import { SandboxBlock, mintAgentBearer, sandboxQuery } from "../src/sandbox.js";

// Runs only with SANDBOX=1 against the loopback sandbox named in the private door profile; assertions use read-only SQL.
const RUN = process.env["SANDBOX"] === "1";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)("M1 on the sandbox EMR", () => {
  it("records one observation under the agent session with provenance, then a correction and an interrupt", async () => {
    const profile = loadProfile();
    const sb = SandboxBlock.parse(profile.sandbox);
    const minted = process.env["HEY_PISGAH_AGENT_BEARER"] ? null : mintAgentBearer(sb);
    const owner = minted?.owner ?? process.env["HEY_PISGAH_AGENT_OWNER"] ?? sb.owner;
    const bearer = minted?.bearer ?? process.env["HEY_PISGAH_AGENT_BEARER"]!;
    const requests: DoorLog[] = [];
    const port = new PisgahPort(profile, {
      bearers: { [owner]: bearer }, onRequest: (l) => requests.push(l),
      episodeFor: async (admission) => String(sandboxQuery(sb, "episode_for_admission", { admission })[0]?.["id"] ?? "") || null
    });
    const startedAt = new Date(Date.now() - 2000).toISOString();
    const pick = await port.census({ owner, evidence: "transcript:m1-census", spoken_at: new Date().toISOString() });
    const target = pick.find((p) => sandboxQuery(sb, "episode_for_admission", { admission: p.admission_id }).length > 0);
    expect(target, "a current inpatient with an open care episode").toBeDefined();
    const admission = target!.admission_id;

    const root = mkdtempSync(join(tmpdir(), "hp-m1-"));
    let rt: EmrRuntime | null = null;
    const client = new ModelClient({ storeRoot: root, mode: "live", recordingsDir: join(root, "recordings"), taskStateOf: (id) => rt?.stateOf(id) ?? null });
    const serveLog: string[] = [];
    const s = await startEmrServe({ storeRoot: root, port, client, listenPort: 0, runtime: { holdMs: 4000, proofRetryMs: 1500 }, log: (l) => serveLog.push(l) });
    rt = s.runtime;
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const view = async (id: string): Promise<EmrTaskView> => ((await (await fetch(`${s.url}/tasks?owner=${owner}`)).json()) as EmrTaskView[]).find((t) => t.task_id === id)!;
    const until = async (id: string, ok: (v: EmrTaskView) => boolean, ms: number, step = 250) => {
      const end = Date.now() + ms;
      for (;;) { const v = await view(id); if (ok(v)) return v; if (Date.now() > end) throw new Error(`timed out in state ${v.state}: ${JSON.stringify(v.actions)}`); await wait(step); }
    };
    const settledAction = (n: number) => (v: EmrTaskView) => v.actions.length >= n && !["proposed", "sent", "acknowledged"].includes(v.actions[n - 1]!.state);

    const trace: Record<string, unknown> = {};
    try {
      // One spoken instruction by text opens the owner's task and writes one observation.
      const first = await post("/tasks/say", { owner, admissionId: admission, text: "Chart temperature 37.8, pulse 92 and respiratory rate 20." });
      expect(first.status).toBe(202);
      const taskId = String(first.body["task_id"]);
      const line1 = String(first.body["line_id"]);
      const v1 = await until(taskId, settledAction(1), 9 * 60_000);
      expect(v1.actions[0]).toMatchObject({ state: "completed", kind: "record_observation" });
      const rec1 = v1.actions[0]!.proof!.record_id;
      const row1 = sandboxQuery(sb, "observation", { id: rec1 })[0]!;
      expect(row1).toMatchObject({ temp_c: "37.8", pulse: 92, resp_rate: 20, entry_method: "voice" });
      const prov1 = sandboxQuery(sb, "provenance", { evidence: `transcript:${line1}` });
      expect(prov1.length).toBeGreaterThanOrEqual(1);
      for (const p of prov1) expect(p).toMatchObject({ on_behalf_of: owner, origin: "voice", agent: row1["recorded_by"], actor: row1["recorded_by"] });
      expect(sandboxQuery(sb, "agent_kind", { id: String(row1["recorded_by"]) })[0]).toMatchObject({ kind: "agent", owner });

      // A spoken correction adds a correcting entry that cites the first; the first stays as written.
      const corr = await post(`/tasks/${taskId}/say`, { text: "Correction: the pulse was 88, not 92." });
      expect(corr.status).toBe(202);
      const v2 = await until(taskId, settledAction(2), 5 * 60_000);
      expect(v2.actions[1]).toMatchObject({ state: "completed", corrects_action_id: v2.actions[0]!.action_id });
      const rec2 = v2.actions[1]!.proof!.record_id;
      const row2 = sandboxQuery(sb, "observation", { id: rec2 })[0]!;
      expect(row2).toMatchObject({ pulse: 88, entry_method: "voice" });
      expect(String(row2["notes"])).toContain(rec1);
      expect(sandboxQuery(sb, "observation", { id: rec1 })[0]).toMatchObject({ pulse: 92 });
      const prov2 = sandboxQuery(sb, "provenance", { evidence: `transcript:${String(corr.body["line_id"])}` });
      expect(prov2.length).toBeGreaterThanOrEqual(1);
      for (const p of prov2) expect(p).toMatchObject({ on_behalf_of: owner, origin: "voice" });
      expect(v2.state).toBe("done");

      // An interrupt during the hold stops the pending action before its write.
      const more = await post(`/tasks/${taskId}/say`, { text: "Also chart blood pressure 128 over 82." });
      expect(more.status).toBe(202);
      const pending = await until(taskId, (v) => v.actions.length >= 3 || v.state !== "running", 3 * 60_000, 100);
      expect(pending.actions[2]?.state).toBe("proposed");
      const stop = await post(`/tasks/${taskId}/interrupt`, {});
      expect(stop.body).toMatchObject({ state: "paused", cancelled: [pending.actions[2]!.action_id], in_flight: [] });
      await wait(6000);
      const v3 = await view(taskId);
      expect(v3).toMatchObject({ state: "paused", reason: "interrupted" });
      expect(v3.actions[2]).toMatchObject({ state: "cancelled", reason: "interrupted" });
      const since = sandboxQuery(sb, "observations_since", { admission, since: startedAt });
      expect(since.map((r) => r["id"])).toEqual([rec1, rec2]);

      // A spoken aside by push-to-talk audio resumes the paused task and writes nothing.
      let audio: Record<string, unknown> | null = null;
      try {
        const wav = join(root, "aside.wav");
        execFileSync("say", ["-o", wav, "--file-format=WAVE", "--data-format=LEI16@16000", "Could you pass me the gloves, please?"], { stdio: "ignore", timeout: 30_000 });
        const form = new FormData();
        form.append("audio", new Blob([readFileSync(wav)], { type: "audio/wav" }), "aside.wav");
        form.append("owner", owner);
        form.append("admissionId", admission);
        const r = await fetch(`${s.url}/tasks/say-audio`, { method: "POST", body: form });
        audio = { status: r.status, ...((await r.json()) as Record<string, unknown>) };
      } catch (e) {
        audio = { skipped: e instanceof Error ? e.message.slice(0, 120) : "error" };
      }
      if (audio && audio["status"] !== undefined) {
        expect(audio["status"], JSON.stringify({ audio, serveLog })).toBe(202);
        expect(audio["task_id"]).toBe(taskId);
        const v4 = await until(taskId, (v) => v.state !== "running", 3 * 60_000);
        expect(v4.actions).toHaveLength(3);
        expect(sandboxQuery(sb, "observations_since", { admission, since: startedAt })).toHaveLength(2);
      }

      // Every model call ran while the task was running, at effort low; no prohibited call left the port.
      const task = rt.task(taskId)!;
      const rows = readStream(root, `ledger/${task.run_id}`).filter((e) => e.record_type === "model.call").map((e) => e.payload as LedgerRow);
      expect(rows.length).toBeGreaterThanOrEqual(3);
      for (const r of rows) expect(r).toMatchObject({ effort: "low", task_state: "running", mode: "live" });
      expect(port.refusedCount()).toBe(0);
      const before = requests.length;
      for (const d of profile.deny) expect((await port.request("POST", d, { owner, evidence: "transcript:m1-deny", spoken_at: new Date().toISOString() }, { body: {} })).kind).toBe("refused");
      expect(port.refusedCount()).toBe(profile.deny.length);
      expect(requests.slice(before).every((l) => l.outcome === "refused")).toBe(true);

      trace["rows"] = { row1, row2, prov1, prov2, since: sandboxQuery(sb, "observations_since", { admission, since: startedAt }) };
      trace["audio"] = audio;
    } finally {
      const tracePath = process.env["HEY_PISGAH_M1_TRACE"];
      if (tracePath) {
        const streams = rt.taskIds().map((id) => ({ id, records: readStream(root, `emr/${id}`).map((e) => ({ seq: e.seq, wall_at: e.wall_at, type: e.record_type, payload: e.payload })) }));
        const ledger = rt.taskIds().flatMap((id) => readStream(root, `ledger/${rt!.task(id)!.run_id}`).filter((e) => e.record_type === "model.call").map((e) => e.payload));
        writeFileSync(tracePath, JSON.stringify({ ...trace, admission, target_label: target!.label, owner, views: s.runtime.views(owner), serveLog, ledger, requests, streams, refusals: port.refusals }, null, 2));
      }
      await s.close();
    }
  }, 25 * 60_000);
});
