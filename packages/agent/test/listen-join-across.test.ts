import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import { EmrRuntime } from "../src/emr/runtime.js";
import { ListenSessions, type Transcriber } from "../src/emr/listen.js";
import { ADM, FakeEmr, OWNER, emrRoot, gater, type C } from "./emr-helpers.js";
import { chunkWav, earOf, obs } from "./mic-helpers.js";

// Acceptance defect 15 and gap 4: "thirty eight point nine" split across the mid-write kill reached two listening sessions and the temperature was never written.
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

describe("a number cut across two listening sessions or a restart", () => {
  it("joins 'thirty eight point' on the chunk session with 'nine' on the frames session for the same patient", async () => {
    const root = emrRoot();
    const port = new FakeEmr();
    const seen: string[] = [];
    const { rt, listen } = start(root, port, earOf(EAR), seen);
    expect((await send(listen, "chunks-1", 0, chunkWav(1300, 700))).outcome).toMatchObject({ why: "held_for_number" });
    await send(listen, "frames-1.f2.0", 0, chunkWav(500, 700));
    await listen.flush("frames-1.f2.0");
    await rt.settled();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, temp_c: "38.9" }]);
    expect(seen).toEqual(["Temperature 38.9."]);
    await rt.stop();
  });

  it("joins a decimal split by a kill of the serve inside the join window, keeps no audio and no line once it is joined", async () => {
    const root = emrRoot();
    const port = new FakeEmr();
    const seen: string[] = [];
    const first = start(root, port, earOf(EAR), seen);
    await send(first.listen, "chunks-1", 0, chunkWav(1300, 700));
    const file = join(root, "serve", "join-pending.json");
    // Only the words wait on disk, never the audio.
    expect(readFileSync(file, "utf8")).toContain("thirty eight point");
    expect(readFileSync(file, "utf8")).not.toContain("samples");
    // A kill runs no shutdown: the listener is simply gone, with the words already on disk.
    await first.rt.stop();
    const second = start(root, port, earOf(EAR), seen);
    await send(second.listen, "frames-2.f1.0", 0, chunkWav(500, 700));
    await second.listen.flush("frames-2.f1.0");
    await second.rt.settled();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, temp_c: "38.9" }]);
    expect(existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as unknown[]).length : 0).toBe(0);
    await second.rt.stop();
  });

  it("delivers the waiting words alone when nothing carries them on after the restart, so they are never lost", async () => {
    const root = emrRoot();
    const port = new FakeEmr();
    const seen: string[] = [];
    const first = start(root, port, earOf(EAR), seen, { strongMs: 150 });
    await send(first.listen, "chunks-1", 0, chunkWav(1300, 700));
    first.listen.close(); await first.rt.stop();
    const second = start(root, port, earOf(EAR), seen, { strongMs: 150 });
    for (let i = 0; i < 50 && !seen.length; i++) await wait(20);
    await second.rt.settled();
    expect(seen).toEqual(["Temperature 38 point"]);
    expect(port.writes).toHaveLength(0);
    await second.rt.stop();
  });
});
