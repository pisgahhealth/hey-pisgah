"use client";

import { startRecorder, type Recorder } from "@hey-pisgah/voice/recorder";
import { useEffect, useRef, useState } from "react";

type Phase = "idle" | "opening" | "listening" | "transcribing";
type Reply = { final?: unknown; text?: unknown; error?: string; detail?: string };

// One press starts recording and the next sends it; only a finished transcript is handed to onFinal.
export function MicButton({ onFinal, disabled = false }: { onFinal: (text: string) => void; disabled?: boolean }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState<string | null>(null);
  const rec = useRef<Recorder | null>(null);
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => () => rec.current?.cancel(), []);

  const stop = async () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    setPhase("transcribing");
    try {
      const { wav, durationMs } = await r.stop();
      if (durationMs < 300) throw new Error("That was too short. Press the mic, speak, then press it again.");
      const res = await fetch("/api/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
      const b = (await res.json()) as Reply;
      if (!res.ok) throw new Error(b.detail ?? `transcription answered ${res.status}`);
      if (b.final !== true || typeof b.text !== "string") throw new Error("No finished transcript came back.");
      if (!b.text) throw new Error("Nothing was heard. Try again or type the goal.");
      onFinal(b.text);
      setNote("Transcript placed in the goal. Check it, then start the task.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Transcription failed. Type the goal instead.");
    } finally {
      setPhase("idle");
    }
  };
  stopRef.current = () => { void stop(); };

  const start = async () => {
    setNote(null);
    setPhase("opening");
    try {
      rec.current = await startRecorder({ maxMs: 30_000, onLimit: () => stopRef.current() });
      setPhase("listening");
    } catch (e) {
      rec.current = null;
      setPhase("idle");
      setNote(e instanceof Error && e.name === "NotAllowedError" ? "The microphone is blocked. Type the goal instead." : "The microphone could not start. Type the goal instead.");
    }
  };

  const listening = phase === "listening";
  const label = listening ? "Stop and transcribe" : phase === "transcribing" ? "Transcribing" : phase === "opening" ? "Opening the microphone" : "Speak the goal";
  return (
    <span className="mic">
      <button
        type="button" className={`mic-btn${listening ? " on" : ""}`} aria-pressed={listening} aria-label={label} title={label}
        disabled={disabled || phase === "opening" || phase === "transcribing"}
        onClick={() => { if (listening) void stop(); else if (phase === "idle") void start(); }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-2.1a7 7 0 0 0 6-6.9h-2Z" fill="currentColor" /></svg>
        <span>{listening ? "Stop" : phase === "transcribing" ? "Sending" : "Speak"}</span>
      </button>
      <span className="mic-note" role="status" aria-live="polite">{listening ? "Listening. Press Stop when you finish." : note}</span>
    </span>
  );
}
