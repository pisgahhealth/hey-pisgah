import { describe, expect, it } from "vitest";
import { readStream } from "@hey-pisgah/store";
import { startServe } from "../src/serve.js";
import { GOAL, OWNER, tempRoot } from "./helpers.js";

const j = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> });
const post = (url: string, b: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

describe("hey-pisgah serve", () => {
  it("owns the streams, opens a task over HTTP, reports status without a model call, and finishes it", async () => {
    const root = tempRoot();
    const s = await startServe({ storeRoot: root, port: 0, mode: "mock", pollMs: 3 });
    await expect(startServe({ storeRoot: root, port: 0, mode: "mock", pollMs: 3 })).rejects.toThrow(/locked|store_locked/);
    expect((await j(await fetch(`${s.url}/health`))).body["mode"]).toBe("mock");
    expect((await j(await post(`${s.url}/tasks`, { case_id: "c-zzzz9999", goal: GOAL, owner: OWNER }))).status).toBe(404);
    expect((await j(await post(`${s.url}/tasks`, { case_id: "c-agent001", goal: "", owner: OWNER }))).status).toBe(400);
    const created = await j(await post(`${s.url}/tasks`, { case_id: "c-agent001", goal: GOAL, owner: OWNER }));
    expect(created.status).toBe(201);
    const id = String(created.body["task_id"]);
    let state = "";
    for (let i = 0; i < 2000 && state !== "done"; i++) {
      state = String((await j(await fetch(`${s.url}/tasks/${id}`))).body["state"]);
      if (state !== "done") await new Promise((r) => setTimeout(r, 10));
    }
    expect(state).toBe("done");
    const runId = s.runtime.projection(id).run_id;
    const calls = readStream(root, `ledger/${runId}`).length;
    for (let i = 0; i < 3; i++) await fetch(`${s.url}/tasks/${id}`);
    expect(readStream(root, `ledger/${runId}`).length).toBe(calls);
    expect((await j(await post(`${s.url}/cases/c-agent001/clock`, { to: 900 }))).status).toBe(409);
    expect((await j(await post(`${s.url}/tasks/${id}/input`, { text: "go on", by: "nurse" }))).status).toBe(409);
    const l = await j(await post(`${s.url}/learning`, { record_type: "hypothesis.recorded", payload: { note: "test" } }));
    expect(l.status).toBe(201);
    expect((await j(await post(`${s.url}/learning`, { record_type: "writer.takeover", payload: {} }))).status).toBe(400);
    expect((await j(await fetch(`${s.url}/nope`))).status).toBe(404);
    await s.close();
    expect(readStream(root, "learning/main").at(-1)!.record_type).toBe("hypothesis.recorded");
  });

  it("in manual clock mode a person moves the clock and a waiting task resumes", async () => {
    const root = tempRoot();
    const s = await startServe({ storeRoot: root, port: 0, mode: "mock", pollMs: 3, clock: "manual" });
    const id = String((await j(await post(`${s.url}/tasks`, { case_id: "c-agent001", goal: GOAL, owner: OWNER }))).body["task_id"]);
    await s.runtime.settled(20_000, { orWaiting: true });
    expect(s.runtime.projection(id).state).toBe("waiting");
    expect((await j(await post(`${s.url}/cases/c-agent001/clock`, { to: 400 }))).status).toBe(409);
    expect((await j(await post(`${s.url}/cases/c-agent001/clock`, { to: 600 }))).body["now"]).toBe(600);
    for (let i = 0; i < 500 && s.runtime.projection(id).actions.size === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(s.runtime.projection(id).actions.size).toBeGreaterThan(0);
    await s.close();
  });
});
