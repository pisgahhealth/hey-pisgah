import { spendDay, type DaySpend } from "@hey-pisgah/model";
import { USD_PER_AUDIO_HOUR } from "@hey-pisgah/voice";
import { shortHash } from "../ids.js";
import type { Transcriber } from "./listen.js";

// The run an owner's arrival listening is charged to, new each hospital day so no permanent run fills its cap.
export function arrivalRunId(owner: string, now: Date = new Date(), tz = process.env["HEY_PISGAH_TZ"] ?? "Africa/Lagos"): string {
  return `run-${shortHash("arrival", owner, spendDay(now, tz))}`;
}

// What the clinician is told when a decision's model call failed; the spend cap says so, since saying it again would not help.
export const SPEND_CAP_NOTE = "The hospital's model spending limit for today is reached, so I stopped deciding new lines and nothing was written from this one. Do it on the record yourself, or ask for the limit to be raised.";

export function modelFailNote(code: string): string {
  return code === "budget_exhausted"
    ? SPEND_CAP_NOTE
    : "I could not decide what that line asked for, so nothing was written from it. Say it again.";
}

// Audio length of a WAV clip from its header, or 16 kHz mono 16-bit when the header is short.
export function wavMs(wav: Uint8Array): number {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ok = wav.byteLength >= 44 && v.getUint32(0, false) === 0x52494646;
  const rate = ok ? v.getUint32(24, true) : 16000;
  const bytesPerMs = ok ? (rate * v.getUint16(22, true) * (v.getUint16(34, true) / 8)) / 1000 : 32;
  return bytesPerMs > 0 ? Math.round(Math.max(0, wav.byteLength - 44) / bytesPerMs) : 0;
}

// A transcriber that holds its clip's cost against the day cap before the call and charges the seconds it was billed after; ledgered leaves the charge to the reading row its caller writes.
export function spendingTranscriber(t: Transcriber, spend: DaySpend | null, o: { ledgered?: boolean } = {}): Transcriber {
  if (!spend) return t;
  return async (wav, keywords, sessionId) => {
    const hold = spend.reserve("speech", (wavMs(wav) / 3_600_000) * USD_PER_AUDIO_HOUR, { purpose: "transcribe" });
    try {
      const r = await t(wav, keywords, sessionId);
      if (o.ledgered) hold.release();
      else hold.settle(r.cost_usd, { speech_ms: r.audio_ms });
      return r;
    } catch (e) {
      hold.release();
      throw e;
    }
  };
}
