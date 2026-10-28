import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelClient } from "@hey-pisgah/model";
import { cleanTranscript, encodeWav } from "@hey-pisgah/voice";
import { MOCK_GATE_FILE, claimStatus, feedTalk, joinedAudio, loadTalk, parseClaimPredicate, sameRun, scoreAmbient, talkChunks, type Timeline } from "@hey-pisgah/evaluator";
import { MemoryEmrPort } from "../src/emr/memory-port.js";
import { replayTranscriber } from "../src/emr/listen.js";
import { startEmrServe } from "../src/emr/serve.js";
import { currentGateHash } from "../src/emr/gate.commit.js";
import { gater } from "./emr-helpers.js";

const ADM = "11111111-2222-4333-8444-555555555555";
const OWNER = "owner-1";
const talk = loadTalk();
const mockGate = JSON.parse(readFileSync(MOCK_GATE_FILE, "utf8")).by_utterance as Record<string, Record<string, unknown>[]>;
const byText = new Map(talk.utterances.map((u) => [cleanTranscript(u.say), u.id]));
const C17 = (JSON.parse(readFileSync(new URL("../../../evaluation/claims.json", import.meta.url), "utf8")).claims as { claim_id: string; acceptance: { predicate: string } }[]).find((c) => c.claim_id === "C-17")!;

// A stand-in recording: a tone as long as each utterance takes to say, the talk's pauses between, and a timeline.
function syntheticTalk(): { wav: Uint8Array; timeline: Timeline } {
  const rate = 16_000;
  let at = talk.lead_ms;
  const placed: Timeline["utterances"] = [];
  const total = talk.utterances.reduce((s, u) => s + u.say.split(" ").length * 330 + talk.gap_ms, talk.lead_ms);
  const a = new Float32Array((total * rate) / 1000);
  talk.utterances.forEach((u, i) => {
    const ms = u.say.split(" ").length * 330;
    for (let j = 0; j < (ms * rate) / 1000; j++) a[(at * rate) / 1000 + j] = 0.3 * Math.sin((2 * Math.PI * (180 + i * 10) * j) / rate);
    placed.push({ id: u.id, start_ms: at, end_ms: at + ms });
    at += ms + talk.gap_ms;
  });
  return { wav: encodeWav(a, rate), timeline: { talk_id: talk.talk_id, wav_sha256: "synthetic", duration_ms: total, utterances: placed } };
}

// One run of the talk through serve with a mock ear and a mock gate; returns the run as the feed reads it back.
async function runOnce(gateFor: (id: string) => Record<string, unknown>[]) {
  const { wav, timeline } = syntheticTalk();
  const chunks = talkChunks(wav, timeline);
  const dir = mkdtempSync(join(tmpdir(), "hp-talk-"));
  const book = Object.fromEntries(joinedAudio(chunks).map((j) => [j.sha256, { text: j.key_ids.map((k) => talk.utterances.find((u) => u.id === k)!.say).join(" "), audio_ms: 1000 }]));
  writeFileSync(join(dir, "transcripts.json"), JSON.stringify(book));
  let s: Awaited<ReturnType<typeof startEmrServe>> | null = null;
  const client = new ModelClient({
    storeRoot: dir, mode: "mock", taskStateOf: (id) => s?.runtime.stateOf(id) ?? null,
    mock: gater((said) => gateFor(byText.get(said) ?? "").map((c) => ({ words: said, ...c })) as never)
  });
  s = await startEmrServe({ storeRoot: dir, port: new MemoryEmrPort({ label: "Test Patient", facts: { ward: "Ward A", bed: "A1" }, keywords: [] }, ADM), client, listenPort: 0, transcribe: replayTranscriber(join(dir, "transcripts.json")), runtime: { holdMs: 0, proofRetryMs: 1 } });
  const run = await feedTalk({ serveUrl: s.url, owner: OWNER, admissionId: ADM, sessionId: "press-1", chunks, pace: "fast", mode: "mock", talkId: talk.talk_id, gateHash: currentGateHash(), settleMs: 10_000 });
  await s.close();
  client.close();
  return { run, chunks };
}

describe("the labelled talk through the listen endpoint", () => {
  it("with a correct gate meets C-17: every instruction acted on, nothing from asides or plans, one question for the one unclear line, and the replay matches", async () => {
    const a = await runOnce((id) => mockGate[id] ?? [{ class: "aside" }]);
    const b = await runOnce((id) => mockGate[id] ?? [{ class: "aside" }]);
    expect(a.chunks.some((c) => c.cut === "cap")).toBe(true);
    const score = scoreAmbient(talk, a.run, { replay_same: sameRun(a.run, b.run) });
    expect(score).toMatchObject({
      precision: 1, recall: 1, actions_expected: 4, actions_matched: 4, false_actions_from_talk: 0, actions_from_asides_or_options: 0,
      questions_untied: 0, ambiguities: 1, ambiguities_asked: 1, refusals_seen: 1, partials_acted: 0, lines: 16, lines_unmapped: 0, class_agreement: 16, replay_same: true
    });
    expect(score.held_chunks).toBeGreaterThan(0);
    expect(claimStatus(parseClaimPredicate(C17.acceptance.predicate), score).status).toBe("green");
  });

  it("turns C-17 red when a conditional plan is acted on, and amber when a clear line draws a question", async () => {
    const acts = await runOnce((id) => (id === "u10" ? [{ class: "instruction", kind: "record_observation", temp_c: "38.5", confidence: 0.9 }] : mockGate[id] ?? []));
    const red = scoreAmbient(talk, acts.run, { replay_same: true });
    expect(red.false_actions_from_talk).toBe(1);
    expect(claimStatus(parseClaimPredicate(C17.acceptance.predicate), red).status).toBe("red");
    const asks = await runOnce((id) => (id === "u05" ? [{ class: "unclear", question: "Should I chart the wound?" }] : mockGate[id] ?? []));
    const amber = scoreAmbient(talk, asks.run, { replay_same: true });
    expect(amber.questions_untied).toBe(1);
    expect(claimStatus(parseClaimPredicate(C17.acceptance.predicate), amber).status).toBe("amber");
  });
});
