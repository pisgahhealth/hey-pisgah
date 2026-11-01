import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

// One local model in its own thread, built from the same config the main thread would have used, so its words and voiceprints are the same.
const { kind, from, config, sig, port, flushSamples } = workerData;
let model = null;
let dim = 0;
try {
  const sherpa = createRequire(from)("sherpa-onnx-node");
  model = kind === "online" ? new sherpa.OnlineRecognizer(config) : kind === "offline" ? new sherpa.OfflineRecognizer(config) : new sherpa.SpeakerEmbeddingExtractor(config);
  dim = kind === "speaker" ? model.dim : 0;
  port.postMessage({ ok: true, dim });
  Atomics.store(sig, 0, 1);
} catch (e) {
  port.postMessage({ ok: false, error: e instanceof Error ? e.message.slice(0, 300) : String(e) });
  Atomics.store(sig, 0, 2);
}
Atomics.notify(sig, 0);
port.close();

// Streams of the online model by the main thread's id; each keeps the first error it met so the next answer carries it.
const streams = new Map();
const run = (st) => { while (model.isReady(st)) model.decode(st); };
const answer = (id, fn) => {
  try { parentPort.postMessage({ id, value: fn() }); } catch (e) { parentPort.postMessage({ id, error: e instanceof Error ? e.message.slice(0, 300) : String(e) }); }
};
const live = (s) => {
  const x = streams.get(s);
  if (!x) throw new Error("the decoder is closed");
  if (x.error) throw new Error(x.error);
  return x;
};

if (model) parentPort.on("message", (m) => {
  if (m.op === "open") { streams.set(m.s, { st: model.createStream(), error: null }); return; }
  if (m.op === "accept") {
    const x = streams.get(m.s);
    if (!x || x.error) return;
    try { x.st.acceptWaveform({ sampleRate: 16_000, samples: m.x }); run(x.st); } catch (e) { x.error = e instanceof Error ? e.message.slice(0, 300) : String(e); }
    return;
  }
  if (m.op === "close") { streams.delete(m.s); return; }
  if (m.op === "text") return answer(m.id, () => model.getResult(live(m.s).st).text.trim());
  if (m.op === "finish") return answer(m.id, () => {
    const x = live(m.s);
    streams.delete(m.s);
    x.st.acceptWaveform({ sampleRate: 16_000, samples: new Float32Array(flushSamples) });
    run(x.st);
    return model.getResult(x.st).text.trim();
  });
  if (m.op === "decode") return answer(m.id, () => {
    const st = model.createStream();
    st.acceptWaveform({ sampleRate: 16_000, samples: m.x });
    model.decode(st);
    return model.getResult(st).text;
  });
  if (m.op === "embed") return answer(m.id, () => {
    const t0 = performance.now();
    const st = model.createStream();
    st.acceptWaveform({ sampleRate: 16_000, samples: m.x });
    st.inputFinished();
    if (!model.isReady(st)) return null;
    const e = model.compute(st);
    return { e: Float32Array.from(e), ms: performance.now() - t0 };
  });
  parentPort.postMessage({ id: m.id, error: `unknown op ${m.op}` });
});
