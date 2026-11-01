import { describe, expect, it } from "vitest";
import { startEmrServe } from "../src/emr/serve.js";
import { EmrRuntime } from "../src/emr/runtime.js";
import { ADM, FakeEmr, OWNER, emrRoot, mockClient, until } from "./emr-helpers.js";

// Lane F2 (b): a typed line is cleaned and read for vitals words the way the ear's words are.
const STRIP = "http://localhost:3311";
const post = (url: string, b: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: STRIP }, body: JSON.stringify(b) });
const pulse = (said: string) => Number(/pulse (\d+)/.exec(said)?.[1] ?? 0);

async function boot() {
  const root = emrRoot();
  const port = new FakeEmr();
  let rt: EmrRuntime | null = null;
  const client = mockClient(root, (said) => (pulse(said) ? { decision: "record", pulse: pulse(said), summary: "Record" } : { decision: "aside", summary: "x" }), () => rt?.stateOf ?? null);
  const s = await startEmrServe({ strip: { mode: "open" }, storeRoot: root, port, client, listenPort: 0, runtime: { holdMs: 0, proofRetryMs: 1 } });
  rt = s.runtime;
  return { s, port };
}
const texts = (s: Awaited<ReturnType<typeof boot>>["s"], id: string) => s.runtime.task(id)!.lines.map((x) => x.text);

describe("F2 (b): typed lines go through the ear's cleaning", () => {
  it("reads 'pulse eighty eight' typed on /tasks/say as 88, and on /tasks/{id}/say too", async () => {
    const { s, port } = await boot();
    try {
      const r = await post(`${s.url}/tasks/say`, { owner: OWNER, admissionId: ADM, text: "Chart pulse eighty eight." });
      expect(r.status).toBe(202);
      const id = ((await r.json()) as { task_id: string }).task_id;
      await until(() => port.writes.length === 1);
      await s.runtime.settled();
      expect(port.writes[0]!.args.pulse).toBe(88);
      expect(texts(s, id)).toEqual(["Chart pulse 88."]);
      expect((await post(`${s.url}/tasks/${id}/say`, { text: "Em, chart pulse ninety two." })).status).toBe(202);
      await until(() => port.writes.length === 2);
      await s.runtime.settled();
      expect(port.writes[1]!.args.pulse).toBe(92);
      expect(texts(s, id)[1]).toBe("chart pulse 92.");
    } finally { await s.close(); }
  });

  it("rewrites the vitals abbreviations but never a sound-alike guess, which only the second ear may confirm", async () => {
    const { s, port } = await boot();
    try {
      const r = await post(`${s.url}/tasks/say`, { owner: OWNER, admissionId: ADM, text: "Chart polls eighty eight, BP one twenty over eighty." });
      const id = ((await r.json()) as { task_id: string }).task_id;
      await until(() => texts(s, id).length === 1);
      await s.runtime.settled();
      expect(texts(s, id)).toEqual(["Chart polls 88, blood pressure 120 over 80."]);
      expect(port.writes).toHaveLength(0);
    } finally { await s.close(); }
  });

  it("refuses a typed line that is only a pause word", async () => {
    const { s } = await boot();
    try {
      const r = await post(`${s.url}/tasks/say`, { owner: OWNER, admissionId: ADM, text: "Em." });
      expect(r.status).toBe(400);
    } finally { await s.close(); }
  });
});
