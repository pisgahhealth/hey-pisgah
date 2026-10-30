import { describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import { VoiceError, encodeWav } from "@hey-pisgah/voice";
import { EmrRuntime } from "../src/emr/runtime.js";
import { ListenSessions, type Transcriber } from "../src/emr/listen.js";
import { startEmrServe } from "../src/emr/serve.js";
import { afterWake } from "../src/emr/entry.js";
import { ADM, FakeEmr, OWNER, emrRoot, gater, until } from "./emr-helpers.js";
import { chunkWav, earOf, obs } from "./mic-helpers.js";

type St = { seq: number; status: string; error?: string; line_id?: string };
function boot(ear: Transcriber, o: { heldEndWaitMs?: number } = {}) {
  const root = emrRoot();
  const port = new FakeEmr();
  let rt: EmrRuntime | null = null;
  const seen: string[] = [];
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater((said) => (said.includes("pulse") ? obs(said, { pulse: 96 }) : [{ class: "aside" }]), seen), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1 });
  rt.start();
  const statuses: St[] = [];
  const listen = new ListenSessions(rt, { transcribe: ear, strongJoinWaitMs: 5000, numberJoinWaitMs: 5000, ...(o.heldEndWaitMs ? { heldEndWaitMs: o.heldEndWaitMs } : {}), onStatus: (_owner, _session, seq, st) => { statuses.push({ seq, ...st }); } });
  return { rt, port, listen, seen, statuses };
}
const chunk = (l: ListenSessions, seq: number, wav: Uint8Array) => l.chunk({ owner: OWNER, target: { admission_id: ADM }, session_id: "s1", seq, wav }, true);
const last = (xs: St[], seq: number) => [...xs].reverse().find((x) => x.seq === seq);

describe("every utterance finishes", () => {
  it("finishes a sentence held at the 6 s cap when the strip says the utterance ended", async () => {
    const { rt, listen, seen } = boot(earOf({ 6000: "Chart his pulse as ninety six, he is settling now" }));
    const held = await chunk(listen, 0, chunkWav(6000, 0));
    expect(held.outcome).toMatchObject({ final: false, why: "held_for_join" });
    const end = await listen.end({ owner: OWNER, target: { admission_id: ADM }, session_id: "s1", seq: 1 }, true);
    expect(end.outcome).toMatchObject({ final: true, why: "end_marker", utterance: { seqs: [0] } });
    await rt.settled();
    expect(seen).toEqual(["Chart his pulse as 96, he is settling now"]);
    listen.close();
    await rt.stop();
  });

  it("finishes held audio on a timer when no next chunk and no marker ever come", async () => {
    const { rt, listen, seen } = boot(earOf({ 6000: "He is settling now and comfortable" }), { heldEndWaitMs: 60 });
    await chunk(listen, 0, chunkWav(6000, 0));
    await until(() => seen.length === 1, 3000);
    expect(seen).toEqual(["He is settling now and comfortable"]);
    expect(rt.views(OWNER)[0]!.transcript[0]!.ambient).toMatchObject({ seqs: [0], finished_by: "held_timeout" });
    listen.close();
    await rt.stop();
  });

  it("shows each utterance's status and a failed transcription as failed, never as listening", async () => {
    let fail = true;
    const ear: Transcriber = async (wav, _k, sessionId) => {
      if (fail) throw new VoiceError("upstream", "Voice Transcribe answered 502", 502);
      return { final: true, text: "She is comfortable", audio_ms: 1700, session_id: sessionId, cost_usd: 0 };
    };
    const { rt, listen, statuses } = boot(ear);
    const bad = await chunk(listen, 0, chunkWav(1000, 700));
    expect(bad.outcome).toMatchObject({ why: "failed" });
    expect(statuses.filter((x) => x.seq === 0).map((x) => x.status)).toEqual(["accepted", "processing", "failed"]);
    expect(last(statuses, 0)!.error).toContain("502");
    fail = false;
    await chunk(listen, 1, chunkWav(1000, 700));
    expect(statuses.filter((x) => x.seq === 1).map((x) => x.status)).toEqual(["accepted", "processing", "completed"]);
    expect(last(statuses, 1)!.line_id).toMatch(/^u-/);
    listen.close();
    await rt.stop();
  });
});

describe("the words after the wake phrase", () => {
  it("drops the carried wake phrase from the line, and keeps the emergency phrase whole", () => {
    expect(afterWake("Hey Pisgah, she has had chest pain since this morning.")).toBe("she has had chest pain since this morning.");
    expect(afterWake("Okay Pisgah chart his pulse 96")).toBe("chart his pulse 96");
    expect(afterWake("hey Pisgah, emergency")).toBe("hey Pisgah, emergency");
    expect(afterWake("the pulse is 96")).toBe("the pulse is 96");
    expect(afterWake("Pisgah, chart his pulse 96")).toBe("chart his pulse 96");
  });

  it("delivers the opening words carried across the wake without the phrase", async () => {
    const { rt, listen, seen } = boot(earOf({ 1700: "Hey Pisgah, she has had chest pain since this morning." }));
    await chunk(listen, 0, chunkWav(1000, 700));
    await rt.settled();
    expect(seen).toEqual(["she has had chest pain since this morning."]);
    listen.close();
    await rt.stop();
  });
});

describe("speech status through serve", () => {
  const silentish = () => encodeWav(new Float32Array(16000).map((_, i) => Math.sin(i / 3) * 0.3), 16000);
  it("surfaces a failed transcription with no patient open, and reads the status back", async () => {
    const root = emrRoot();
    const port = new FakeEmr();
    const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater(() => [{ class: "aside" }]) });
    const s = await startEmrServe({ storeRoot: root, port, client, listenPort: 0, runtime: { holdMs: 0, proofRetryMs: 1 }, ears: "off", transcribe: async () => { throw new VoiceError("upstream", "Voice Transcribe answered 502", 502); } });
    const f = new FormData();
    f.append("audio", new Blob([silentish()], { type: "audio/wav" }), "c.wav");
    f.append("owner", OWNER); f.append("session_id", "s-9"); f.append("seq", "0");
    const r = (await (await fetch(`${s.url}/tasks/listen`, { method: "POST", body: f })).json()) as any;
    expect(r.errors?.[0]).toContain("502");
    const st = (await (await fetch(`${s.url}/tasks/listen?owner=${OWNER}&session_id=s-9`)).json()) as any;
    expect(st.utterances).toEqual([expect.objectContaining({ seq: 0, status: "failed", error: expect.stringContaining("502") })]);
    // The end marker is accepted with no audio and finishes nothing when nothing is held.
    const e = new FormData();
    e.append("owner", OWNER); e.append("session_id", "s-9"); e.append("seq", "1"); e.append("end", "1");
    expect((await fetch(`${s.url}/tasks/listen`, { method: "POST", body: e })).status).toBe(202);
    await s.close();
  });

  it("finishes a capped line on the strip's end marker, and opens no arrival when 'emergency' is only heard in passing", async () => {
    const root = emrRoot();
    const port = new FakeEmr();
    const heard = ["She has been vomiting since the morning and cannot keep fluids down", "this is not an emergency, she can wait"];
    const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater(() => [{ class: "aside" }]) });
    const s = await startEmrServe({ storeRoot: root, port, client, listenPort: 0, runtime: { holdMs: 0, proofRetryMs: 1 }, ears: "off", transcribe: async (_w, _k, id) => ({ final: true, text: heard.shift() ?? "", audio_ms: 6000, session_id: id, cost_usd: 0 }) });
    const form = (seq: number, o: { wav?: Uint8Array; end?: boolean; hint?: string }) => {
      const f = new FormData();
      if (o.wav) f.append("audio", new Blob([new Uint8Array(o.wav)], { type: "audio/wav" }), "c.wav");
      f.append("owner", OWNER); f.append("session_id", "s-10"); f.append("seq", String(seq)); f.append("admissionId", ADM);
      if (o.end) f.append("end", "1");
      if (o.hint) f.append("hint", o.hint);
      return f;
    };
    const held = (await (await fetch(`${s.url}/tasks/listen?wait=1`, { method: "POST", body: form(0, { wav: chunkWav(6000, 0) }) })).json()) as any;
    expect(held.outcome).toMatchObject({ why: "held_for_join" });
    const end = (await (await fetch(`${s.url}/tasks/listen?wait=1`, { method: "POST", body: form(1, { end: true }) })).json()) as any;
    expect(end.outcome).toMatchObject({ why: "end_marker", utterance: { seqs: [0] } });
    const st = (await (await fetch(`${s.url}/tasks/listen?owner=${OWNER}&session_id=s-10`)).json()) as any;
    expect(st.utterances.find((u: any) => u.seq === 0)).toMatchObject({ status: "completed", line_id: end.outcome.utterance.line_id });
    // The device heard "emergency" with no wake before it: the transcript decides, and words in passing open nothing.
    const passing = (await (await fetch(`${s.url}/tasks/listen`, { method: "POST", body: form(2, { wav: chunkWav(1000, 700), hint: "emergency" }) })).json()) as any;
    expect(passing.entry).toBeUndefined();
    await s.runtime.settled();
    expect(s.runtime.taskIds().filter((id) => s.runtime.view(id)!.unidentified)).toHaveLength(0);
    await s.close();
  });
});
