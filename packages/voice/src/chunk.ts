// Speech below this frame loudness counts as silence; about -40 dBFS.
export const SILENCE_RMS = 0.01;
const FRAME_MS = 10;

// The loudness of each 10 ms frame.
export function frameRms(samples: Float32Array, rate: number): Float32Array {
  const size = Math.max(1, Math.round((rate * FRAME_MS) / 1000));
  const out = new Float32Array(Math.ceil(samples.length / size));
  for (let f = 0; f < out.length; f++) {
    let sum = 0;
    const end = Math.min(samples.length, (f + 1) * size);
    for (let i = f * size; i < end; i++) sum += samples[i]! * samples[i]!;
    out[f] = Math.sqrt(sum / Math.max(1, end - f * size));
  }
  return out;
}

// How long the audio has been quiet at its end, in milliseconds.
export function trailingSilenceMs(samples: Float32Array, rate: number, threshold = SILENCE_RMS): number {
  const rms = frameRms(samples, rate);
  let n = 0;
  for (let f = rms.length - 1; f >= 0 && rms[f]! < threshold; f--) n += 1;
  return Math.min(n * FRAME_MS, Math.round((samples.length / rate) * 1000));
}

// How long the audio is quiet at its start, in milliseconds.
export function leadingSilenceMs(samples: Float32Array, rate: number, threshold = SILENCE_RMS): number {
  const rms = frameRms(samples, rate);
  let n = 0;
  for (let f = 0; f < rms.length && rms[f]! < threshold; f++) n += 1;
  return Math.min(n * FRAME_MS, Math.round((samples.length / rate) * 1000));
}

export type SilenceRun = { start_ms: number; end_ms: number };
// Every quiet stretch of at least minMs, in order.
export function silenceRuns(samples: Float32Array, rate: number, minMs: number, threshold = SILENCE_RMS): SilenceRun[] {
  const rms = frameRms(samples, rate);
  const out: SilenceRun[] = [];
  let start = -1;
  for (let f = 0; f <= rms.length; f++) {
    const quiet = f < rms.length && rms[f]! < threshold;
    if (quiet && start < 0) start = f;
    if (!quiet && start >= 0) { if ((f - start) * FRAME_MS >= minMs) out.push({ start_ms: start * FRAME_MS, end_ms: f * FRAME_MS }); start = -1; }
  }
  return out;
}

export type AudioChunk = { seq: number; start_ms: number; end_ms: number; cut: "quiet_tail" | "cap" | "end" };
export type ChunkOptions = { tailMs?: number; capMs?: number; threshold?: number };

// Cuts a recording the way the strip does: tailMs after speech stops, or at the capMs limit mid-word; chunks with no speech are never sent, so seq counts sent chunks only.
export function stripChunks(samples: Float32Array, rate: number, o: ChunkOptions = {}): AudioChunk[] {
  const tail = o.tailMs ?? 700, cap = o.capMs ?? 6000, th = o.threshold ?? SILENCE_RMS;
  const rms = frameRms(samples, rate);
  const out: AudioChunk[] = [];
  let start = 0, speech = false, quiet = 0;
  const emit = (endFrame: number, cut: AudioChunk["cut"]) => {
    if (speech) out.push({ seq: out.length, start_ms: start * FRAME_MS, end_ms: endFrame * FRAME_MS, cut });
    start = endFrame; speech = false; quiet = 0;
  };
  for (let f = 0; f < rms.length; f++) {
    const loud = rms[f]! >= th;
    if (loud) { speech = true; quiet = 0; } else quiet += 1;
    const len = (f + 1 - start) * FRAME_MS;
    if (speech && !loud && quiet * FRAME_MS >= tail) emit(f + 1, "quiet_tail");
    else if (len >= cap) emit(f + 1, "cap");
    else if (!speech && quiet * FRAME_MS >= cap) emit(f + 1, "cap");
  }
  emit(rms.length, "end");
  return out.map((c) => ({ ...c, end_ms: Math.min(c.end_ms, Math.round((samples.length / rate) * 1000)) }));
}

// The samples between two times.
export function sliceMs(samples: Float32Array, rate: number, startMs: number, endMs: number): Float32Array {
  return samples.slice(Math.round((startMs * rate) / 1000), Math.round((endMs * rate) / 1000));
}
