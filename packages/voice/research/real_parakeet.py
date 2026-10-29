"""Second, offline transcriber (NeMo Parakeet TDT 0.6B v2 through sherpa-onnx) for every clip, used only to check what was said."""
import json
import os
import sys
import time
import wave

import numpy as np
import sherpa_onnx


def main():
    model, folder, out = sys.argv[1], sys.argv[2], sys.argv[3]
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=f"{model}/encoder.int8.onnx", decoder=f"{model}/decoder.int8.onnx", joiner=f"{model}/joiner.int8.onnx",
        tokens=f"{model}/tokens.txt", model_type="nemo_transducer", num_threads=4)
    rows = {}
    for f in sorted(os.listdir(folder)):
        if not f.endswith(".wav"):
            continue
        with wave.open(f"{folder}/{f}", "rb") as w:
            r = w.getframerate()
            x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
        t0 = time.perf_counter()
        s = rec.create_stream(); s.accept_waveform(r, x); rec.decode_stream(s)
        rows[f[:-4]] = {"text": s.result.text.strip(), "ms": round((time.perf_counter() - t0) * 1000)}
    json.dump(rows, open(out, "w"), indent=1)


if __name__ == "__main__":
    main()
