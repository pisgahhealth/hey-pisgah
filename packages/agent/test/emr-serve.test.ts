import { describe, expect, it } from "vitest";
import { VoiceError, encodeWav } from "@hey-pisgah/voice";
import { startEmrServe } from "../src/emr/serve.js";
import { EmrRuntime } from "../src/emr/runtime.js";
import { ADM, FakeEmr, OWNER, emrRoot, mockClient, until } from "./emr-helpers.js";

const STRIP = "http://localhost:3311";
const j = async (r: Response) => ({ status: r.status, headers: r.headers, body: (await r.json()) as any });
const post = (url: string, b: unknown, origin = STRIP) => fetch(url, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(b) });
const pulse = (said: string) => Number(/pulse (\d+)/.exec(said)?.[1] ?? 0);

const refuseHints = { on: false };
async function boot(holdMs = 0) {
  const root = emrRoot();
  const port = new FakeEmr();
  let rt: EmrRuntime | null = null;
  const heard: { keywords: readonly string[]; bytes: number }[] = [];
  const client = mockClient(root, (said) => (/^stop/i.test(said) ? { decision: "aside", summary: "x" } : { decision: "record", pulse: pulse(said), summary: "Record" }), () => rt?.stateOf ?? null);
  const s = await startEmrServe({
    storeRoot: root, port, client, listenPort: 0, runtime: { holdMs, proofRetryMs: 1 },
    transcribe: async (wav, keywords, sessionId) => {
      heard.push({ keywords, bytes: wav.length });
      if (keywords.includes("Ward A") && refuseHints.on) throw new VoiceError("upstream", "Voice Transcribe answered 400 (invalid_request_error)", 400);
      return { final: true, text: "Chart pulse 84", audio_ms: 1000, session_id: sessionId, cost_usd: 0.00005 }; }
  });
  rt = s.runtime;
  return { s, port, heard };
}

describe("EMR serve", () => {
  it("serves the strip contract: say, list by owner, follow-up, interrupt, with CORS for the EMR origin only", async () => {
    const { s, port } = await boot(150);
    const pre = await fetch(`${s.url}/tasks/say`, { method: "OPTIONS", headers: { origin: STRIP, "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(STRIP);
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
    const said = await j(await post(`${s.url}/tasks/say`, { owner: OWNER, admissionId: ADM, text: "Chart pulse 92" }));
    expect(said.status).toBe(202);
    expect(said.headers.get("access-control-allow-origin")).toBe(STRIP);
    const id = said.body.task_id as string;
    await until(() => s.runtime.view(id)!.actions.length === 1);
    const stop = await j(await post(`${s.url}/tasks/${id}/interrupt`, {}));
    expect(stop.body).toMatchObject({ task_id: id, state: "paused", cancelled: [expect.stringMatching(/^a-/)] });
    await s.runtime.settled();
    expect(port.writes).toHaveLength(0);
    expect((await j(await post(`${s.url}/tasks/${id}/say`, { task_id: id, text: "Chart pulse 90" }))).status).toBe(202);
    await s.runtime.settled();
    // Another page's request is refused before it runs, and a rebinding host name is refused too.
    const evil = await j(await fetch(`${s.url}/tasks?owner=${OWNER}`, { headers: { origin: "http://evil.example" } }));
    expect(evil.status).toBe(403);
    expect((await fetch(`${s.url}/tasks/say`, { method: "POST", headers: { "content-type": "text/plain", origin: "http://evil.example" }, body: JSON.stringify({ owner: OWNER, admissionId: ADM, text: "Chart pulse 99" }) })).status).toBe(403);
    expect((await fetch(`${s.url}/tasks/say`, { method: "POST", headers: { "content-type": "text/plain", origin: STRIP }, body: JSON.stringify({ owner: OWNER, admissionId: ADM, text: "Chart pulse 99" }) })).status).toBe(415);
    const list = await j(await fetch(`${s.url}/tasks?owner=${OWNER}`, { headers: { origin: STRIP } }));
    expect(list.headers.get("access-control-allow-origin")).toBe(STRIP);
    expect(list.headers.get("access-control-allow-headers")).toBe("Content-Type");
    expect(list.body).toHaveLength(1);
    const t = list.body[0];
    expect(Object.keys(t)).toEqual(expect.arrayContaining(["task_id", "goal", "state", "actions", "questions", "transcript"]));
    expect(t).toMatchObject({ task_id: id, goal: "Chart pulse 92", state: "done", questions: [] });
    expect(t.actions.map((a: any) => a.state)).toEqual(["cancelled", "completed"]);
    expect(t.actions[1].proof).toEqual({ record_id: "obs-1", record_version: 1, event_ids: ["observation:obs-1"] });
    expect(t.transcript.map((x: any) => x.text)).toEqual(["Chart pulse 92", "Chart pulse 90"]);
    expect((await j(await fetch(`${s.url}/tasks?owner=nobody`))).body).toEqual([]);
    await s.close();
  });

  it("refuses bad bodies, unknown tasks, a mismatched task id and another owner", async () => {
    const { s } = await boot();
    expect((await post(`${s.url}/tasks/say`, { owner: OWNER, text: "x" })).status).toBe(400);
    expect((await post(`${s.url}/tasks/say`, { owner: OWNER, admissionId: "not-an-id", text: "x" })).status).toBe(400);
    expect((await post(`${s.url}/tasks/t-00000000/say`, { text: "x" })).status).toBe(404);
    expect((await fetch(`${s.url}/tasks`)).status).toBe(400);
    const id = (await j(await post(`${s.url}/tasks/say`, { owner: OWNER, admissionId: ADM, text: "Chart pulse 70" }))).body.task_id as string;
    await s.runtime.settled();
    expect((await post(`${s.url}/tasks/${id}/say`, { task_id: "t-11111111", text: "x" })).status).toBe(400);
    expect((await post(`${s.url}/tasks/${id}/say`, { owner: "someone-else", text: "x" })).status).toBe(403);
    expect((await post(`${s.url}/tasks/${id}/interrupt`, { owner: "someone-else" })).status).toBe(403);
    expect((await fetch(`${s.url}/nope`)).status).toBe(404);
    await s.close();
  });

  it("takes push-to-talk WAV as multipart, transcribes it with keywords from the patient context, and opens the task", async () => {
    const { s, port, heard } = await boot();
    const form = new FormData();
    form.append("audio", new Blob([encodeWav(new Float32Array(16_000))], { type: "audio/wav" }), "say.wav");
    form.append("owner", OWNER);
    form.append("admissionId", ADM);
    const r = await j(await fetch(`${s.url}/tasks/say-audio`, { method: "POST", body: form, headers: { origin: STRIP } }));
    expect(r.status).toBe(202);
    expect(r.headers.get("access-control-allow-origin")).toBe(STRIP);
    expect(r.headers.get("access-control-allow-headers")).toBe("Content-Type");
    const pre = await fetch(`${s.url}/tasks/say-audio`, { method: "OPTIONS", headers: { origin: STRIP, "access-control-request-method": "POST" } });
    expect([pre.status, pre.headers.get("access-control-allow-origin")]).toEqual([204, STRIP]);
    expect(r.body).toMatchObject({ transcript: "Chart pulse 84", audio_ms: 1000 });
    expect(heard[0]!.keywords).toContain("Ward A");
    expect(heard[0]!.bytes).toBe(44 + 32_000);
    await s.runtime.settled();
    expect(port.writes.map((w) => w.args.pulse)).toEqual([84]);
    const v = s.runtime.view(r.body.task_id)!;
    expect(Date.parse(v.transcript[0]!.at)).toBeLessThan(Date.now() - 900);
    const bad = new FormData();
    bad.append("owner", OWNER);
    bad.append("admissionId", ADM);
    expect((await fetch(`${s.url}/tasks/say-audio`, { method: "POST", body: bad })).status).toBe(400);
    expect((await post(`${s.url}/tasks/say-audio`, { owner: OWNER })).status).toBe(415);
    refuseHints.on = true;
    const again = new FormData();
    again.append("audio", new Blob([encodeWav(new Float32Array(16_000))], { type: "audio/wav" }), "say.wav");
    again.append("owner", OWNER);
    again.append("admissionId", ADM);
    const r2 = await j(await fetch(`${s.url}/tasks/say-audio`, { method: "POST", body: again }));
    refuseHints.on = false;
    expect(r2.body).toMatchObject({ transcript: "Chart pulse 84", keywords_dropped: true });
    expect(heard.at(-1)!.keywords).toEqual([]);
    await s.close();
  });
});
