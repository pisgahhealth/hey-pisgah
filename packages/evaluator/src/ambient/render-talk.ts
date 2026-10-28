import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { concat, decodeWav, encodeWav } from "@hey-pisgah/voice";
import { loadTalk, type Timeline } from "./talk.js";

// Renders the labelled talk with macOS say at 16 kHz: each utterance in turn with the talk's pause between, and a timeline of where each one sits.
export function renderTalk(outWav: string, outTimeline: string, talkFile?: string): Timeline {
  const talk = loadTalk(talkFile);
  const dir = mkdtempSync(join(tmpdir(), "hp-talk-"));
  const rate = talk.sample_rate;
  const quiet = (ms: number) => new Float32Array(Math.round((ms * rate) / 1000));
  const parts: Float32Array[] = [quiet(talk.lead_ms)];
  let at = talk.lead_ms;
  const placed: Timeline["utterances"] = [];
  try {
    for (const u of talk.utterances) {
      const f = join(dir, `${u.id}.wav`);
      execFileSync("say", ["-v", talk.voice, "-o", f, `--data-format=LEI16@${rate}`, u.say]);
      const { samples } = decodeWav(readFileSync(f));
      const ms = Math.round((samples.length / rate) * 1000);
      placed.push({ id: u.id, start_ms: at, end_ms: at + ms });
      parts.push(samples, quiet(talk.gap_ms));
      at += ms + talk.gap_ms;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const wav = encodeWav(concat(parts), rate);
  writeFileSync(outWav, wav);
  const timeline: Timeline = { talk_id: talk.talk_id, wav_sha256: createHash("sha256").update(wav).digest("hex"), duration_ms: at, utterances: placed };
  writeFileSync(outTimeline, `${JSON.stringify(timeline, null, 1)}\n`);
  return timeline;
}

if (process.argv[1]?.endsWith("render-talk.ts")) {
  const [wav, timeline] = process.argv.slice(2);
  if (!wav || !timeline) { console.log("usage: render-talk.ts <out.wav> <out.timeline.json>"); process.exit(1); }
  const t = renderTalk(wav, timeline);
  console.log(`${t.utterances.length} utterances, ${(t.duration_ms / 1000).toFixed(1)} s, sha ${t.wav_sha256.slice(0, 12)}`);
}
