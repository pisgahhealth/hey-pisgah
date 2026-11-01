import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import { configureSealing } from "@hey-pisgah/store";
import { EmrRuntime } from "../src/emr/runtime.js";
import { ListenSessions, type Transcriber } from "../src/emr/listen.js";
import { startEmrServe } from "../src/emr/serve.js";
import { ADM, FakeEmr, OWNER, emrRoot, gater, type C } from "./emr-helpers.js";
import { chunkWav, earOf, obs } from "./mic-helpers.js";

const gate = (said: string): C[] => (said.includes("38.9") ? obs(said, { temp_c: "38.9" }) : [{ class: "unclear", question: "Which temperature?" }]);
const EAR = { 2000: "Temperature thirty eight point", 1200: "nine.", 3200: "Temperature thirty eight point nine." };
function start(root: string, port: FakeEmr, ear: Transcriber, seen: string[], o: { numberMs?: number; strongMs?: number } = {}) {
  let rt: EmrRuntime | null = null;
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater(gate, seen), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1 });
  rt.start();
  const listen = new ListenSessions(rt, { transcribe: ear, strongJoinWaitMs: o.strongMs ?? 5000, numberJoinWaitMs: o.numberMs ?? 5000, joinFile: join(root, "serve", "join-pending.json") });
  return { rt, listen };
}
const send = (l: ListenSessions, session: string, seq: number, wav: Uint8Array) => l.chunk({ owner: OWNER, target: { admission_id: ADM }, session_id: session, seq, wav }, true);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the words a line waits on, sealed on disk", () => {
  afterEach(() => configureSealing(undefined));

  it("keeps join-pending sealed under the store key, and a restart still joins the number", async () => {
    configureSealing({ key: "ab".repeat(32) });
    const root = emrRoot();
    const port = new FakeEmr();
    const seen: string[] = [];
    const first = start(root, port, earOf(EAR), seen);
    await send(first.listen, "chunks-1", 0, chunkWav(1300, 700));
    const file = join(root, "serve", "join-pending.json");
    const disk = readFileSync(file, "utf8");
    expect(disk.startsWith("hps1.")).toBe(true);
    expect(disk).not.toContain("thirty eight");
    await first.rt.stop();
    const second = start(root, port, earOf(EAR), seen);
    await send(second.listen, "frames-2.f1.0", 0, chunkWav(500, 700));
    await second.listen.flush("frames-2.f1.0");
    await second.rt.settled();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, temp_c: "38.9" }]);
    expect(existsSync(file)).toBe(true);
    await second.rt.stop();
  });

  // A line left waiting by the last serve, sealed under one key, and the files the serve folder holds afterwards.
  async function leftWaiting(): Promise<{ root: string; file: string; bytes: string }> {
    configureSealing({ key: "ab".repeat(32) });
    const root = emrRoot();
    const first = start(root, new FakeEmr(), earOf(EAR), []);
    await send(first.listen, "chunks-1", 0, chunkWav(1300, 700));
    await first.rt.stop();
    const file = join(root, "serve", "join-pending.json");
    return { root, file, bytes: readFileSync(file, "utf8") };
  }
  const asideOf = (file: string) => readdirSync(join(file, "..")).filter((n) => n.startsWith("join-pending.json.unreadable-"));

  it("keeps a join file sealed with another key aside, untouched, and says so, instead of starting with the words dropped", async () => {
    const { root, file, bytes } = await leftWaiting();
    configureSealing({ key: "cd".repeat(32) });
    const second = start(root, new FakeEmr(), earOf(EAR), []);
    const problem = second.listen.joinProblem();
    expect(problem?.error).toMatch(/another store key/);
    const aside = asideOf(file);
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(root, "serve", aside[0]!), "utf8")).toBe(bytes);
    expect(problem?.kept).toBe(join(root, "serve", aside[0]!));
    // New waiting words never overwrite the kept file.
    await send(second.listen, "chunks-2", 0, chunkWav(1300, 700));
    expect(readFileSync(join(root, "serve", aside[0]!), "utf8")).toBe(bytes);
    await second.rt.stop();
  });

  it("does the same for a damaged join file, and the serve logs it and shows it on /health", async () => {
    const root = emrRoot();
    mkdirSync(join(root, "serve"), { recursive: true });
    const file = join(root, "serve", "join-pending.json");
    writeFileSync(file, "hps1.0000.damaged");
    configureSealing({ key: "ab".repeat(32) });
    const lines: string[] = [];
    const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater(gate, []) });
    const s = await startEmrServe({ storeRoot: root, port: new FakeEmr(), client, listenPort: 0, preferences: false, log: (l) => lines.push(l) });
    try {
      expect(asideOf(file)).toHaveLength(1);
      expect(readFileSync(join(root, "serve", asideOf(file)[0]!), "utf8")).toBe("hps1.0000.damaged");
      expect(lines.some((l) => l.includes("join-pending") && l.includes("unreadable"))).toBe(true);
      const health = (await (await fetch(`${s.url}/health`)).json()) as { join_pending?: { kept?: string; error?: string } };
      expect(health.join_pending?.kept).toContain("join-pending.json.unreadable-");
    } finally { await s.close(); }
  });
});
