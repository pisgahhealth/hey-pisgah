import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { writeRecording } from "@hey-pisgah/model";
import { emrRoot, OWNER } from "./emr-helpers.js";
import { boot, chunkWav, earOf, obs, say, storeText } from "./mic-helpers.js";

describe("asides are dropped after their class is decided", () => {
  it("never stores an aside's words, and stores a line only when an action rests on it", async () => {
    const { rt, listen, root, settle } = boot((said) => (said.startsWith("Chart") ? obs(said, { pulse: 90 }) : [{ class: "aside" }]),
      earOf({ 2700: "My laptop was recording the whole meeting.", 1700: "Chart pulse 90." }));
    await say(listen, 0, chunkWav(2000, 700));
    await say(listen, 1, chunkWav(1000, 700));
    await settle();
    const v = rt.views(OWNER)[0]!;
    expect(storeText(root)).not.toContain("laptop");
    expect(storeText(root)).toContain("Chart pulse 90.");
    expect(v.transcript.map((t) => [t.text, t.class, t.kept])).toEqual([["", "aside", false], ["Chart pulse 90.", "instruction", true]]);
    expect(v.heard).toEqual({ lines: 2, kept: 1, dropped: 1 });
  });

  it("keeps a recording's audio only as its hash", () => {
    const dir = emrRoot();
    const audio = Buffer.from("RIFF-voice").toString("base64");
    const file = writeRecording(dir, {
      hash: "h1", provider: "modal", status: 200, latency_ms: 1, recorded_at: "2026-10-28T00:00:00Z", headers: {}, response: {},
      request: { messages: [{ role: "user", content: [{ type: "audio_url", audio_url: { url: `data:audio/wav;base64,${audio}` } }, { type: "input_audio", input_audio: { data: audio, format: "wav" } }] }] }
    }, []);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(audio);
    expect(text).toContain("sha256:");
  });
});
