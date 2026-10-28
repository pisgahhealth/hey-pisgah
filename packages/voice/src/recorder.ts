import { TARGET_RATE, concat, encodeWav, resample } from "./wav.js";

export type Recording = { wav: Uint8Array<ArrayBuffer>; durationMs: number; sampleRate: number };
export type Recorder = { stop(): Promise<Recording>; cancel(): void };
export type RecorderOptions = { maxMs?: number; onLimit?: () => void };

// The worklet copies each input block to the main thread, where the WAV is built.
const TAP = `class Tap extends AudioWorkletProcessor { process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; } } registerProcessor("hey-pisgah-tap", Tap);`;

// Opens the microphone and records until stop, then returns 16 kHz mono 16-bit WAV.
export async function startRecorder(opts: RecorderOptions = {}): Promise<Recorder> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot record audio on this page.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ctx = new AudioContext();
  const chunks: Float32Array[] = [];
  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true;
    clearTimeout(limit);
    for (const t of stream.getTracks()) t.stop();
    void ctx.close();
  };
  let limit: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = URL.createObjectURL(new Blob([TAP], { type: "text/javascript" }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const src = ctx.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(ctx, "hey-pisgah-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => { if (!closed) chunks.push(e.data); };
    src.connect(tap).connect(mute).connect(ctx.destination);
    if (ctx.state === "suspended") await ctx.resume();
  } catch (e) {
    release();
    throw e;
  }
  limit = setTimeout(() => opts.onLimit?.(), opts.maxMs ?? 30_000);
  return {
    async stop() {
      const rate = ctx.sampleRate;
      release();
      const pcm = resample(concat(chunks), rate, TARGET_RATE);
      return { wav: encodeWav(pcm, TARGET_RATE), durationMs: Math.round((pcm.length / TARGET_RATE) * 1000), sampleRate: TARGET_RATE };
    },
    cancel() { release(); chunks.length = 0; }
  };
}
