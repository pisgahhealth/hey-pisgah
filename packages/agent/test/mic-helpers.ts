import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ModelClient } from "@hey-pisgah/model";
import { encodeWav, type FinalTranscript } from "@hey-pisgah/voice";
import { EmrRuntime } from "../src/emr/runtime.js";
import { ListenSessions, type Transcriber } from "../src/emr/listen.js";
import { ADM, FakeEmr, OWNER, emrRoot, gater, type C } from "./emr-helpers.js";

// Helpers for the tests built from the first real-mic session: strip-shaped chunks, scripted ears, and a runtime with a listener.

export const RATE = 16_000;
export const chunkWav = (talkMs: number, quietMs: number) => {
  const a = new Float32Array(((talkMs + quietMs) * RATE) / 1000);
  for (let i = 0; i < (talkMs * RATE) / 1000; i++) a[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return encodeWav(a, RATE);
};
export const msOf = (wav: Uint8Array) => Math.round(((wav.length - 44) / 2 / RATE) * 1000);
// Voice Transcribe as a script keyed by the audio length it is sent, and the lengths it was sent.
export const earOf = (byMs: Record<number, string>, sent: number[] = []): Transcriber => async (wav, _k, sessionId): Promise<FinalTranscript> => {
  const ms = msOf(wav);
  sent.push(ms);
  return { final: true, text: byMs[ms] ?? "", audio_ms: ms, session_id: sessionId, cost_usd: 0.0001 };
};
export function boot(script: (said: string) => C[], ear: Transcriber, o: { strongMs?: number; numberMs?: number } = {}) {
  const root = emrRoot();
  const port = new FakeEmr();
  let rt: EmrRuntime | null = null;
  const seen: string[] = [];
  const client = new ModelClient({ storeRoot: root, mode: "mock", mock: gater(script, seen), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  rt = new EmrRuntime({ storeRoot: root, client, port, holdMs: 0, proofRetryMs: 1 });
  rt.start();
  const listen = new ListenSessions(rt, { transcribe: ear, strongJoinWaitMs: o.strongMs ?? 5000, numberJoinWaitMs: o.numberMs ?? 5000 });
  const settle = async () => { await listen.flush("s1"); await rt!.settled(); };
  return { rt, port, listen, seen, root, settle };
}
export const say = (l: ListenSessions, seq: number, wav: Uint8Array) => l.chunk({ owner: OWNER, target: { admission_id: ADM }, session_id: "s1", seq, wav }, true);
export const obs = (said: string, v: Record<string, unknown>): C[] => [{ class: "instruction", kind: "record_observation", confidence: 0.95, words: said, ...v }];
export const storeText = (root: string) => readdirSync(join(root, "emr")).map((f) => readFileSync(join(root, "emr", f), "utf8")).join("\n");

