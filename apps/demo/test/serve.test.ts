import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadFixture, loadTaskPage, DEMO_TASK } from "../src/lib/task-source.js";
import { root } from "./render";

type Hit = { method: string; url: string; body: string };
const hits: Hit[] = [];
let server: Server;
let url = "";
let store = "";
const f = loadFixture(root);
const TASK = f.meta.task_id;

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

beforeAll(async () => {
  store = mkdtempSync(join(tmpdir(), "demo-store-"));
  mkdirSync(join(store, "tasks"));
  mkdirSync(join(store, "ledger"));
  writeFileSync(join(store, "tasks", `${TASK}.jsonl`), f.records.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(store, "ledger", `${f.meta.recorded_run}.jsonl`), f.ledger.map((p, i) => JSON.stringify({ seq: i + 1, record_type: "model.call", occurred_at: 0, recorded_at: 0, payload: p })).join("\n") + "\n");
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => {
      hits.push({ method: req.method ?? "", url: req.url ?? "", body });
      const send = (s: number, v: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.url === "/health") return send(200, { ok: true, mode: "replay", tasks: 1 });
      if (req.url === "/tasks" && req.method === "GET") return send(200, [{ task_id: TASK, case_id: "c-agent001", state: "needs_input", reason: "work_left_undone" }]);
      if (req.url === "/tasks" && req.method === "POST") return send(201, { task_id: "t-new" });
      if (req.url === `/tasks/${TASK}`) return send(200, { state: "needs_input", reason: "work_left_undone", unmet: ["refund_voucher.final"], conditions: [{ condition_id: "refund_voucher.final", met: false }] });
      return send(404, { error: "no such route" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  url = typeof a === "object" && a ? `http://127.0.0.1:${a.port}` : "";
  process.env["HEY_PISGAH_STORE"] = store;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env["HEY_PISGAH_STORE"];
  rmSync(store, { recursive: true, force: true });
});

describe("serve and the store", () => {
  it("reads the task from serve and the store without writing the store", async () => {
    const before = snapshot(store);
    const page = await loadTaskPage(root, { serveUrl: url });
    expect(snapshot(store)).toEqual(before);
    expect(page.source.kind).toBe("serve");
    expect(page.view!.task_id).toBe(TASK);
    expect(page.view!.state).toBe("needs_input");
    expect(page.view!.conditions.find((c) => c.condition_id === "refund_voucher.final")!.met).toBe(false);
    expect(page.footer.mode).toBe("replay");
    expect(page.footer.calls).toBe(38);
    expect(hits.every((h) => h.method === "GET")).toBe(true);
  });

  it("falls back to the committed replay when serve is not up", async () => {
    const page = await loadTaskPage(root, { serveUrl: "http://127.0.0.1:9" });
    expect(page.source.kind).toBe("fixture");
    expect(page.serve_error).not.toBeNull();
    expect(page.view!.state).toBe("done");
  });

  it("the start route posts only the demo task to serve", async () => {
    vi.stubEnv("HEY_PISGAH_SERVE_URL", url);
    vi.resetModules();
    const route = await import("../app/api/serve/tasks/route");
    const r = await route.POST();
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ task_id: "t-new" });
    const post = hits.filter((h) => h.method === "POST");
    expect(post).toHaveLength(1);
    expect(JSON.parse(post[0]!.body)).toEqual(DEMO_TASK);
    vi.unstubAllEnvs();
  });

  it("the start route carries a typed or spoken goal and nothing else", async () => {
    vi.stubEnv("HEY_PISGAH_SERVE_URL", url);
    vi.resetModules();
    const route = await import("../app/api/serve/tasks/route");
    const send = (body: string) => route.POST(new Request("http://demo/api/serve/tasks", { method: "POST", body }));
    const before = hits.filter((h) => h.method === "POST").length;
    expect((await send(JSON.stringify({ goal: "  Prepare the  discharge summary for bed A-23. " }))).status).toBe(201);
    const post = hits.filter((h) => h.method === "POST");
    expect(JSON.parse(post[post.length - 1]!.body)).toEqual({ ...DEMO_TASK, goal: "Prepare the discharge summary for bed A-23." });
    for (const bad of [JSON.stringify({ goal: "x", case_id: "c-other" }), JSON.stringify({ goal: "" }), JSON.stringify({ goal: "x".repeat(501) }), JSON.stringify({ goal: 3 }), "not json"]) {
      expect((await send(bad)).status).toBe(400);
    }
    expect(hits.filter((h) => h.method === "POST")).toHaveLength(before + 1);
    vi.unstubAllEnvs();
  });

  it("transcribe answers 501 outside live mode and 405 on GET", async () => {
    vi.stubEnv("HEY_PISGAH_MODE", "replay");
    vi.resetModules();
    const route = await import("../app/api/transcribe/route");
    expect((await route.POST(new Request("http://demo/api/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array(10) }))).status).toBe(501);
    expect(route.GET().status).toBe(405);
    vi.unstubAllEnvs();
  });
});
