import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryEmrPort, currentGateHash, readKeptContext, replayTranscriber, startEmrServe } from "@hey-pisgah/agent";
import { Timeline, feedTalk, loadTalk, runSignature, sameRun, scoreAmbient, talkChunks, type AmbientRun } from "@hey-pisgah/evaluator";
import { ModelClient } from "@hey-pisgah/model";
import { loadProfile } from "./profile.js";
import { SandboxBlock } from "./sandbox.js";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const need = (k: string) => { const v = arg(k); if (!v) throw new Error(`--${k} is required`); return v; };
const write = (f: string, v: unknown) => writeFileSync(f, `${JSON.stringify(v, null, 1)}\n`);

// Plays the labelled talk into a running serve in real time (--live), or replays a kept run in process from its recordings (--replay), and scores it.
async function main(): Promise<void> {
  const talk = loadTalk();
  const wav = new Uint8Array(readFileSync(need("wav")));
  const timeline = Timeline.parse(JSON.parse(readFileSync(need("timeline"), "utf8")));
  const out = need("out");
  mkdirSync(out, { recursive: true });
  const admission = need("admission");
  const chunks = talkChunks(wav, timeline);
  const log = (s: string) => process.stderr.write(`${s}\n`);
  log(`${chunks.length} chunks, ${chunks.filter((c) => c.cut === "cap").length} at the cap`);
  if (process.argv.includes("--live")) {
    const profile = loadProfile();
    const owner = arg("owner") ?? (profile.sandbox ? SandboxBlock.parse(profile.sandbox).owner : "");
    const run = await feedTalk({ serveUrl: need("serve"), owner, admissionId: admission, sessionId: `talk-${Date.now().toString(36)}`, chunks, pace: "real", mode: "live", talkId: talk.talk_id, gateHash: currentGateHash(), settleMs: 90_000, log });
    write(join(out, "run.live.json"), run);
    write(join(out, "ambient.live.json"), scoreAmbient(talk, run));
    log(`live run kept; ${run.lines.length} lines, ${run.actions.length} actions, ${run.calls} calls, $${run.cost_usd.toFixed(4)}`);
    return;
  }
  const rec = need("recordings");
  const live = JSON.parse(readFileSync(need("live-run"), "utf8")) as AmbientRun;
  const store = join(out, `replay-store-${Date.now().toString(36)}`);
  let serve: Awaited<ReturnType<typeof startEmrServe>> | null = null;
  const client = new ModelClient({ storeRoot: store, mode: "replay", recordingsDir: join(rec, "model"), taskStateOf: (id) => serve?.runtime.stateOf(id) ?? null });
  serve = await startEmrServe({
    storeRoot: store, port: new MemoryEmrPort(readKeptContext(join(rec, "context.json")), admission), client, listenPort: 0,
    transcribe: replayTranscriber(join(rec, "transcripts.json")), ears: "spark", runtime: { holdMs: 0, proofRetryMs: 1 }
  });
  const replay = await feedTalk({ serveUrl: serve.url, owner: "replay-owner", admissionId: admission, sessionId: "replay-1", chunks, pace: "fast", mode: "replay", talkId: talk.talk_id, gateHash: currentGateHash(), settleMs: 30_000 });
  await serve.close();
  client.close();
  const same = sameRun(live, replay);
  write(join(out, "run.replay.json"), replay);
  if (!same) write(join(out, "replay-diff.json"), { live: JSON.parse(runSignature(live)), replay: JSON.parse(runSignature(replay)) });
  const score = scoreAmbient(talk, live, { replay_same: same });
  write(join(out, "ambient.json"), score);
  const results = arg("results");
  if (results) write(results, score);
  log(`replay same: ${same}; precision ${score.precision}, recall ${score.recall}, false from talk ${score.false_actions_from_talk}, untied questions ${score.questions_untied}`);
}

main().catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
