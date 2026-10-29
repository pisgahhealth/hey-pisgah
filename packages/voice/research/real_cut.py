"""Cuts the converted recordings into one 16 kHz mono WAV per clip from a plan of id, source and seconds."""
import json
import sys
import wave


def main():
    plan, src, out = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]
    for c in plan:
        with wave.open(f"{src}/{c['source']}.wav", "rb") as w:
            rate, n = w.getframerate(), w.getnframes()
            a = int((c["start_s"] or 0) * rate)
            b = min(n, int(c["end_s"] * rate)) if c["end_s"] is not None else n
            w.setpos(a)
            frames = w.readframes(b - a)
        with wave.open(f"{out}/{c['id']}.wav", "wb") as o:
            o.setnchannels(1); o.setsampwidth(2); o.setframerate(rate); o.writeframes(frames)


if __name__ == "__main__":
    main()
