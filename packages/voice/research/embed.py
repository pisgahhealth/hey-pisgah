"""Speaker embeddings for every WAV in a folder with an offline sherpa-onnx model, with the time each clip took."""
import json
import sys
import time
import wave

import numpy as np
import sherpa_onnx


def read(path):
    with wave.open(path, "rb") as w:
        rate = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    return x, rate


def windows(x, rate, win_s=1.5, hop_s=0.5):
    """Voiced windows: 20 ms frames above the clip's own noise floor by 8 dB, cut into 1.5 s windows that are at least half voiced."""
    f = int(0.02 * rate)
    n = len(x) // f
    if n == 0:
        return []
    e = np.sqrt(np.mean(x[: n * f].reshape(n, f) ** 2, axis=1) + 1e-12)
    voiced = e > np.percentile(e, 10) * 2.5
    idx = np.nonzero(voiced)[0]
    if len(idx) == 0:
        return []
    first, last = idx[0], idx[-1] + 1
    w, h = int(win_s / 0.02), int(hop_s / 0.02)
    out = []
    start = first
    while True:
        end = min(start + w, last)
        if voiced[start:end].mean() >= 0.5 and end - start >= w // 2:
            out.append((start * f, end * f))
        if end >= last:
            break
        start += h
    return out


def embed(ex, rate, x):
    s = ex.create_stream()
    s.accept_waveform(rate, x)
    s.input_finished()
    e = np.array(ex.compute(s), dtype=np.float32)
    return [round(float(v), 5) for v in e / (np.linalg.norm(e) or 1)]


def main():
    model, folder, out = sys.argv[1], sys.argv[2], sys.argv[3]
    ids = sys.argv[4].split(",")
    cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model, num_threads=1, provider="cpu")
    ex = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
    result = {"model": model.split("/")[-1], "dim": ex.dim, "clips": {}}
    # One warm-up call, so the first clip's latency does not carry the model load.
    x, rate = read(f"{folder}/{ids[0]}.wav")
    s = ex.create_stream(); s.accept_waveform(rate, x); s.input_finished(); ex.compute(s)
    for i in ids:
        x, rate = read(f"{folder}/{i}.wav")
        t0 = time.perf_counter()
        whole = embed(ex, rate, x)
        ms = (time.perf_counter() - t0) * 1000
        t1 = time.perf_counter()
        wins = [embed(ex, rate, x[a:b]) for a, b in windows(x, rate)]
        wms = (time.perf_counter() - t1) * 1000
        result["clips"][i] = {"ms": round(ms, 2), "window_ms": round(wms, 2), "audio_ms": round(len(x) / rate * 1000), "embedding": whole, "windows": wins}
    with open(out, "w") as f:
        json.dump(result, f)


if __name__ == "__main__":
    main()
