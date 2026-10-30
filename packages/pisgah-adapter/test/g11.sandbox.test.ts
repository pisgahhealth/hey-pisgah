import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { pcm16kOf, percentile, sherpaEmbedder, withDoorAudio, type Embedder, type Provenance, type SpeakerVerdict } from "@hey-pisgah/agent";
import { PisgahPort } from "../src/port.js";
import { loadProfile } from "../src/profile.js";
import { mintAgentBearer, SandboxBlock, sandboxQuery } from "../src/sandbox.js";
import { speak, VOICES } from "./e3.sandbox.test.js";
import { freshArrival, paceAudio, voiceOf } from "./sandbox-helpers.js";

// Runs only with SANDBOX=1 and G11=1: HEY_PISGAH_DOOR_PROFILE names a door with the voiceprint computed at the hospital, HEY_PISGAH_G11_OFF_PROFILE the same hospital with the switch off; synthetic voices, no model call.
const RUN = process.env["SANDBOX"] === "1" && process.env["G11"] === "1";
const run = Date.now().toString(36);
const now = () => new Date().toISOString();
const results: Record<string, unknown> = { run, synthetic: true };
const tmp = join(process.env["HEY_PISGAH_G11_TMP"] ?? "/tmp", `g11-${run}`);
// Every recording sent to the hospital, so the private proof can look for its bytes afterwards.
const sent: string[] = [];

describe.skipIf(!RUN)("G11 the hospital computes the voiceprint from the line's audio", () => {
  const on = RUN ? loadProfile() : null!;
  const off = RUN ? loadProfile(process.env["HEY_PISGAH_G11_OFF_PROFILE"]) : null!;
  let sb: SandboxBlock, door: PisgahPort, plain: PisgahPort, owner: string, embed: Embedder;
  const prov = (line: string, voice?: Provenance["voice"]): Provenance => ({ owner, evidence: `transcript:${line}`, spoken_at: now(), ...(voice ? { voice } : {}) });
  const clip = (name: string, text: string, voice: string = VOICES.owner) => { const file = join(tmp, `${name}.wav`); sent.push(file); return speak(voice, `${text} Run ${run}.`, file); };
  const rows = (prefix: string) => sandboxQuery(sb, "match_rows", { prefix: `transcript:${prefix}` });
  // New owner audio waits until it could have been spoken live; a resend of audio already sent does not.
  const live = async (pcm16k: Uint8Array[]) => { await paceAudio({ vector: [], ms: 0, model: "nemo_en_titanet_small", segments: pcm16k.map((audio) => ({ vector: [], ms: 0, audio })) }); return { pcm16k }; };

  beforeAll(() => {
    sb = SandboxBlock.parse(on.sandbox);
    const m = mintAgentBearer(sb);
    owner = m.owner;
    door = new PisgahPort(on, { bearers: { [m.owner]: m.bearer } });
    plain = new PisgahPort(off, { bearers: { [m.owner]: m.bearer } });
    embed = sherpaEmbedder({ modelPath: process.env["HEY_PISGAH_SPEAKER_MODEL"] ?? "", sherpaDir: process.env["HEY_PISGAH_SHERPA_DIR"] })!;
    expect(embed).not.toBeNull();
  }, 120_000);

  it("refuses an agent's voiceprint, and a perturbed copy of a captured one, while the same line's audio is matched", async () => {
    const wav = clip("vector", "Send a full blood count.");
    const print = (await embed(wav))!.vector;
    const perturbed = print.map((x, i) => x + (i % 2 ? 0.003 : -0.003));
    const asVector = await door.speaker!(owner, print, prov(`g11-${run}-vector`));
    const asPerturbed = await door.speaker!(owner, perturbed, prov(`g11-${run}-perturbed`));
    const asAudio = await door.speaker!(owner, await live([pcm16kOf(wav)!]), prov(`g11-${run}-audio`));
    results["vector"] = { asVector, asPerturbed, asAudio: asAudio.speaker };
    expect(asVector).toEqual({ speaker: "unverified", reason: "door_403" });
    expect(asPerturbed).toEqual({ speaker: "unverified", reason: "door_403" });
    // Negative control: the switch-off door still takes the same vector, so the refusal is the switch.
    expect((await plain.speaker!(owner, print, prov(`g11-${run}-vector-off`))).speaker).toBe("owner");
    expect(asAudio.speaker).toBe("owner");
    // A refused voiceprint is never matched, so it leaves no match row; the audio's match leaves one.
    expect(rows(`g11-${run}-vector`)).toEqual([]);
    expect(rows(`g11-${run}-perturbed`)).toEqual([]);
    expect(rows(`g11-${run}-audio`).map((r) => r["verdict"])).toEqual(["owner"]);
  }, 120_000);

  it("gives one recording one label, and refuses a lightly changed copy of it, while another utterance gets its own", async () => {
    const pcm = pcm16kOf(clip("same", "Send an abdominal ultrasound."))!;
    const first = await door.speaker!(owner, await live([pcm]), prov(`g11-${run}-same-1`));
    const again = await door.speaker!(owner, { pcm16k: [pcm.slice()] }, prov(`g11-${run}-same-2`));
    // One least-significant bit on every 50th sample: a new digest, nearly the same voiceprint.
    const dithered = pcm.slice();
    for (let i = 0; i < dithered.length; i += 100) dithered[i] = dithered[i]! ^ 1;
    const changed = await door.speaker!(owner, { pcm16k: [dithered] }, prov(`g11-${run}-same-3`));
    const other = await door.speaker!(owner, await live([pcm16kOf(clip("other", "Send a urinalysis."))!]), prov(`g11-${run}-same-4`));
    const kept = rows(`g11-${run}-same-`);
    results["same_recording"] = { first: first.speaker, again: again.speaker, changed: changed.speaker, other: other.speaker, rows: kept.map((r) => [r["evidence"], r["verdict"]]) };
    expect(first.speaker).toBe("owner");
    expect(again.speaker).toBe("unverified");
    expect(changed.speaker).toBe("unverified");
    expect(other.speaker).toBe("owner");
    expect(kept.map((r) => r["verdict"])).toEqual(["owner", "same_recording", "same_recording", "owner"]);
    expect(kept[0]!["audio_digest"]).toBe(kept[1]!["audio_digest"]);
    expect(kept[2]!["audio_digest"]).not.toBe(kept[0]!["audio_digest"]);
  }, 120_000);

  it("spends no token the switch-off door minted from a vector, and spends the one minted from audio", async () => {
    const a = await freshArrival(on, "G11 Child");
    const args = { visit_id: a.visit, patient_id: a.patient, test: "fbc" };
    const vLine = `g11-${run}-minted-off`, aLine = `g11-${run}-minted-on`;
    const wav = clip("minted-off", "Send a full blood count now.");
    const fromVector = await plain.speaker!(owner, (await embed(wav))!.vector, prov(vLine));
    expect(fromVector.speaker).toBe("owner");
    const refused = await door.commit("order_test", args, `${vLine}-k`, prov(vLine, { authorisation: `transcript:${vLine}~${(fromVector as { token: string }).token}` }));
    const fromAudio = await door.speaker!(owner, await live([pcm16kOf(clip("minted-on", "Send a full blood count today."))!]), prov(aLine));
    expect(fromAudio.speaker).toBe("owner");
    const sentOk = await door.commit("order_test", args, `${aLine}-k`, prov(aLine, { authorisation: `transcript:${aLine}~${(fromAudio as { token: string }).token}` }));
    const states = sandboxQuery(sb, "order_states_for_visit", { visit: a.visit });
    results["spend"] = { refused, sent: sentOk, states: states.map((s) => s["authorised_evidence"]) };
    expect(refused).toMatchObject({ ok: false, status: 403 });
    expect(sentOk, JSON.stringify(sentOk)).toMatchObject({ ok: true });
    expect(states.map((s) => s["authorised_evidence"])).toEqual([`transcript:${aLine}`]);
  }, 180_000);

  it("answers a retry of the same match after a lost answer with the token it first issued, and nothing to the same audio relabelled or from another session", async () => {
    const pcm = pcm16kOf(clip("retry", "Send a malaria parasite test please."))!;
    const line = `g11-${run}-retry`;
    const first = await door.speaker!(owner, await live([pcm]), prov(line));
    const retry = await door.speaker!(owner, { pcm16k: [pcm.slice()] }, prov(line));
    const relabelled = await door.speaker!(owner, { pcm16k: [pcm.slice()] }, prov(`${line}-other`));
    const m = mintAgentBearer(sb);
    const otherSession = await new PisgahPort(on, { bearers: { [m.owner]: m.bearer } }).speaker!(owner, { pcm16k: [pcm.slice()] }, prov(line));
    results["retry"] = { first: first.speaker, retry: retry.speaker, same_token: (first as { token?: string }).token === (retry as { token?: string }).token, relabelled: relabelled.speaker, other_session: otherSession.speaker };
    expect(first.speaker).toBe("owner");
    expect(retry).toEqual(first);
    expect(relabelled.speaker).toBe("unverified");
    expect(otherSession.speaker).toBe("unverified");
    // The relabelled copy and the other session's copy are both kept as the same recording.
    expect(rows(line).map((r) => r["verdict"])).toEqual(["owner", "retried", "same_recording", "same_recording"]);
  }, 120_000);

  it("matches a line in windows: the owner only when every window is, another voice's window holds it, and a 20 s line is sent whole", async () => {
    const windowed = withDoorAudio(embed);
    const both = async (name: string, a: string, b: string) => live([pcm16kOf(clip(`${name}-a`, a))!, pcm16kOf(clip(`${name}-b`, b, name === "mixed" ? VOICES.drb : VOICES.owner))!]);
    const own = await door.speaker!(owner, await both("own", "Okay let's get a full", "blood count and a urinalysis."), prov(`g11-${run}-win-own`));
    // Worded apart from the owner's line, so only the other voice's window can refuse it.
    const mixed = await door.speaker!(owner, await both("mixed", "Right, let's get her a full", "blood count and a urinalysis."), prov(`g11-${run}-win-mixed`));
    const long = (await windowed(clip("long", "Chart her pulse as ninety two, the blood pressure as one thirty over eighty five, the temperature as thirty seven point eight, the respiratory rate as eighteen, and her oxygen saturation as ninety six percent on room air, then send a full blood count.")))!;
    const longWindows = voiceOf(long) as { pcm16k: Uint8Array[] };
    const longBytes = longWindows.pcm16k.reduce((n, w) => n + w.byteLength, 0);
    const asLong = await door.speaker!(owner, await live(longWindows.pcm16k), prov(`g11-${run}-win-long`));
    const mixedRows = rows(`g11-${run}-win-mixed`);
    results["windows"] = { own: own.speaker, mixed: mixed.speaker, mixed_rows: mixedRows.map((r) => [r["segment"], r["segment_verdict"], r["verdict"]]), long: asLong.speaker, long_windows: longWindows.pcm16k.length, long_s: longBytes / 32_000 };
    expect(own.speaker).toBe("owner");
    expect(mixed.speaker).toBe("unverified");
    expect(mixedRows.map((r) => r["segment_verdict"])).toEqual(["owner", "other_clinician"]);
    expect(longBytes / 32_000).toBeGreaterThan(15);
    expect(longWindows.pcm16k.length).toBeGreaterThan(1);
    expect(asLong.speaker).toBe("owner");
  }, 180_000);

  it("keeps only the verdict, the audio's digest and the template revisions", async () => {
    const cols = sandboxQuery(sb, "match_columns", {}).map((r) => r["column_name"]);
    results["columns"] = cols;
    expect(cols).toEqual(["id", "organization_id", "agent_facility_user_id", "owner_facility_user_id", "evidence", "audio_digest", "verdict", "owner_template_id", "matched_template_id", "model", "rule", "nonce", "at", "segment", "segments", "segment_verdict", "audio_ms", "agent_session_id", "token_issued_ms"]);
    const r = rows(`g11-${run}-audio`)[0]!;
    expect(r["audio_digest"]).toMatch(/^[0-9a-f]{64}$/);
    expect(r["owner_template_id"]).toBe(r["matched_template_id"]);
  });

  it("times each match, from audio at the hospital and from the agent's vector", async () => {
    const n = Number(process.env["HEY_PISGAH_G11_N"] ?? 20);
    const times: { audio_ms: number; vector_ms: number; local_embed_ms: number; pcm_ms: number; clip_ms: number; audio: SpeakerVerdict["speaker"]; vector: SpeakerVerdict["speaker"] }[] = [];
    // Paced so the owner never speaks faster than one person can, which the hospital refuses.
    const t00 = Date.now();
    let spoken = 0;
    for (let i = 0; i < n; i++) {
      const wav = clip(`t-${i}`, `Chart her pulse as ${60 + i} and the temperature as thirty seven point ${i % 10}.`);
      spoken += ((wav.length - 44) / 2 / 24_000) * 1000;
      const wait = spoken - (Date.now() - t00);
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
      const t0 = performance.now();
      const pcm = pcm16kOf(wav)!;
      const pcmMs = performance.now() - t0;
      const t1 = performance.now();
      const a = await door.speaker!(owner, { pcm16k: [pcm] }, prov(`g11-${run}-t-${i}`));
      const audioMs = performance.now() - t1;
      const p = (await embed(wav))!;
      const t2 = performance.now();
      const v = await plain.speaker!(owner, p.vector, prov(`g11-${run}-tv-${i}`));
      times.push({ audio_ms: Math.round(audioMs), vector_ms: Math.round(performance.now() - t2), local_embed_ms: p.ms, pcm_ms: Math.round(pcmMs * 10) / 10, clip_ms: Math.round((pcm.byteLength / 32_000) * 1000), audio: a.speaker, vector: v.speaker });
    }
    const pc = (k: "audio_ms" | "vector_ms" | "local_embed_ms" | "pcm_ms") => ({ p50: percentile(times.map((t) => t[k]), 50), p90: percentile(times.map((t) => t[k]), 90) });
    results["latency"] = { n, audio: pc("audio_ms"), vector: pc("vector_ms"), local_embed: pc("local_embed_ms"), pcm: pc("pcm_ms"), rows: times };
    expect(times.every((t) => t.audio === "owner" && t.vector === "owner")).toBe(true);
  }, 900_000);

  it("refuses owner audio sent faster than one person speaks, across every request", async () => {
    // The minute before is let pass, so the paced timing run above does not count against this burst.
    await new Promise((res) => setTimeout(res, 61_000));
    const pcms = Array.from({ length: 14 }, (_, i) => pcm16kOf(clip(`burst-${i}`, `Record the respiratory rate as ${12 + i} breaths a minute, and the pulse as ${70 + i}.`))!);
    const got: string[] = [];
    for (const [i, p] of pcms.entries()) got.push((await door.speaker!(owner, { pcm16k: [p] }, prov(`g11-${run}-burst-${i}`))).speaker);
    const kept = rows(`g11-${run}-burst-`).map((r) => r["verdict"]);
    results["burst"] = { seconds: pcms.reduce((n, p) => n + p.byteLength, 0) / 32_000, got, kept };
    // The first line could have been spoken by now; the rest arrive far faster than anyone talks.
    expect(got[0]).toBe("owner");
    expect(kept).toContain("faster_than_live");
    expect(got.filter((g) => g === "owner").length).toBeLessThan(4);
  }, 300_000);

  it("writes what it saw", () => {
    const out = process.env["HEY_PISGAH_G11_OUT"];
    if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify({ ...results, sent }, null, 1)}\n`); }
  });
});
