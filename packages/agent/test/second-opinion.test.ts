import { describe, expect, it } from "vitest";
import { ModelClient } from "@hey-pisgah/model";
import type { FinalTranscript } from "@hey-pisgah/voice";
import { ListenSessions, parallelReadings, type Transcriber } from "../src/emr/listen.js";
import { EmrRuntime } from "../src/emr/runtime.js";
import { ADM, FakeEmr, OWNER, emrRoot, gater } from "./emr-helpers.js";
import { chunkWav, obs, say, secondOf } from "./mic-helpers.js";

// Voice Transcribe as several calls that each answer from a list in turn, the way the probe saw one clip read differently call after call.
function sampled(readings: string[], sent: string[] = []): Transcriber {
  let k = 0;
  return async (_wav, _kw, sessionId): Promise<FinalTranscript> => { sent.push(sessionId); const text = readings[k++ % readings.length]!; return { final: true, text, audio_ms: 2000, session_id: sessionId, cost_usd: 0.0001 }; };
}

function boot(first: Transcriber, second: string, o: { secondOpinion: boolean; readings: number }) {
  const root = emrRoot();
  const port = new FakeEmr();
  let rt: EmrRuntime | null = null;
  const seen: string[] = [];
  const pulse = (said: string) => { const m = /pulse (\d+)/.exec(said); return m ? obs(said, { pulse: Number(m[1]) }) : [{ class: "aside" as const }]; };
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater(pulse, seen), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1, secondEar: secondOf({ 2000: second }), secondOpinion: o.secondOpinion });
  rt.start();
  const listen = new ListenSessions(rt, { transcribe: parallelReadings(first, o.readings), numberJoinWaitMs: 50 });
  const settle = async () => { await listen.flush("s1"); await rt!.settled(); };
  return { rt, port, listen, seen, settle };
}

describe("several Voice Transcribe readings at once", () => {
  it("sends the same audio n times at once, keeps the first as the line and the rest as alternates, and sums the cost", async () => {
    const sent: string[] = [];
    const r = await parallelReadings(sampled(["pulse 160", "pulse 116", "pulse 116"], sent), 3)(chunkWav(1500, 500), [], "s1-0");
    expect(sent).toEqual(["s1-0", "s1-0-r1", "s1-0-r2"]);
    expect(r).toMatchObject({ text: "pulse 160", alternates: ["pulse 116", "pulse 116"] });
    expect(r.cost_usd).toBeCloseTo(0.0003, 9);
  });

  it("is a no-op at one reading, so the default ear is unchanged", async () => {
    const t = sampled(["pulse 160"]);
    expect(parallelReadings(t, 1)).toBe(t);
  });
});

describe("the second-opinion rule on readings_differ", () => {
  it("writes the value the other-family ear shares with another Voice Transcribe reading", async () => {
    const { rt, port, listen, settle } = boot(sampled(["Chart the pulse 160", "Chart the pulse 116"]), "pulse 116", { secondOpinion: true, readings: 2 });
    await say(listen, 0, chunkWav(1500, 500));
    await settle();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 116 }]);
    const v = rt.views(OWNER)[0]!;
    expect(v.questions).toEqual([]);
    expect(v.actions.map((a) => [a.state, a.summary])).toEqual([["completed", expect.stringContaining("116")]]);
  });

  it("asks, as before, when the other ear agrees with no Voice Transcribe reading", async () => {
    const { rt, port, listen, settle } = boot(sampled(["Chart the pulse 160", "Chart the pulse 160"]), "pulse 116", { secondOpinion: true, readings: 2 });
    await say(listen, 0, chunkWav(1500, 500));
    await settle();
    expect(port.writes).toEqual([]);
    expect(rt.views(OWNER)[0]!.questions[0]!.text).toBe("Pulse: one reading heard 160, the other 116. Say 160 or 116.");
  });

  it("never lets two Voice Transcribe readings outvote the other ear", async () => {
    // Both Voice Transcribe readings say 160 and the other ear 116: the line still asks, it never writes 160 on Meta's word alone.
    const { port, listen, settle, rt } = boot(sampled(["Chart the pulse 160", "Chart the pulse 160", "Chart the pulse 160"]), "pulse 116", { secondOpinion: true, readings: 3 });
    await say(listen, 0, chunkWav(1500, 500));
    await settle();
    expect(port.writes).toEqual([]);
    expect(rt.views(OWNER)[0]!.actions.map((a) => a.reason)).toEqual(["readings_differ"]);
  });

  it("is off unless switched on: the same readings ask", async () => {
    const { port, listen, settle, rt } = boot(sampled(["Chart the pulse 160", "Chart the pulse 116"]), "pulse 116", { secondOpinion: false, readings: 2 });
    await say(listen, 0, chunkWav(1500, 500));
    await settle();
    expect(port.writes).toEqual([]);
    expect(rt.views(OWNER)[0]!.actions.map((a) => a.reason)).toEqual(["readings_differ"]);
  });

  it("writes as before when the first reading and the other ear agree, whatever the alternates say", async () => {
    const { port, listen, settle } = boot(sampled(["Chart the pulse 116", "Chart the pulse 160"]), "pulse 116", { secondOpinion: true, readings: 2 });
    await say(listen, 0, chunkWav(1500, 500));
    await settle();
    expect(port.writes.map((w) => w.args)).toEqual([{ admission_id: ADM, pulse: 116 }]);
  });
});
