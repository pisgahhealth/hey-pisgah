import { join } from "node:path";
import { languageBiasFrom, nodeSocket, recordingSocket, replaySocket } from "@hey-pisgah/voice";
import { KEPT_LEVERS, asrSwitch, earSwitch, keepingContext, leversFrom, localDirs, recordingTranscriber, sherpaEmbedder, startEmrServe, voiceTranscriber } from "@hey-pisgah/agent";
import { loadProfile, staffHintsOf } from "./profile.js";
import { PisgahPort } from "./port.js";
import { adoptedForEmr } from "./versions.js";
import { SandboxBlock, mintAgentBearer, sandboxQuery } from "./sandbox.js";

// Starts the EMR-facing serve over the agent door on HEY_PISGAH_EMR_PORT (default 4100); the bearer comes from the environment or a sandbox mint.
async function main(): Promise<void> {
  const profile = loadProfile();
  const sandbox = profile.sandbox ? SandboxBlock.parse(profile.sandbox) : null;
  let owner = process.env["HEY_PISGAH_AGENT_OWNER"] ?? sandbox?.owner ?? "";
  let bearer = process.env["HEY_PISGAH_AGENT_BEARER"] ?? "";
  if (!bearer) {
    if (!sandbox) throw new Error("set HEY_PISGAH_AGENT_BEARER, or add a sandbox block to the profile");
    const m = mintAgentBearer(sandbox);
    bearer = m.bearer;
    owner = m.owner;
  }
  if (!owner) throw new Error("set HEY_PISGAH_AGENT_OWNER");
  // One agent bearer per owner: the sandbox block's other logins are minted the same way, each for its own owner.
  const bearers: Record<string, string> = { [owner]: bearer };
  for (const who of sandbox?.owners ?? []) {
    const m = mintAgentBearer(sandbox!, who);
    bearers[m.owner] = m.bearer;
  }
  const store = process.env["HEY_PISGAH_EMR_STORE"] ?? join(process.cwd(), ".hey-pisgah", "emr-store");
  const port = new PisgahPort(profile, {
    bearers,
    ...(sandbox ? { episodeFor: async (admission: string) => String(sandboxQuery(sandbox, "episode_for_admission", { admission })[0]?.["id"] ?? "") || null } : {}),
    onRequest: (l) => process.stderr.write(`door ${l.method} ${l.status ?? l.outcome} ${l.ms}ms${l.replayed ? " replayed" : ""}${l.reason ? ` ${l.reason}` : ""}\n`)
  });
  // With HEY_PISGAH_RECORDINGS set, model replies, transcripts and the patient context are kept there so the run can be replayed.
  const rec = process.env["HEY_PISGAH_RECORDINGS"];
  // The local speaker model, loaded in this process when HEY_PISGAH_SPEAKER_MODEL names its file; without it attribution stays off.
  const modelPath = process.env["HEY_PISGAH_SPEAKER_MODEL"];
  const embed = modelPath ? sherpaEmbedder({ modelPath, sherpaDir: process.env["HEY_PISGAH_SHERPA_DIR"] }) : null;
  if (modelPath && !embed) process.stderr.write("speaker model did not load; attribution is off\n");
  const asr = asrSwitch(process.env["HEY_PISGAH_ASR"]);
  // With HEY_PISGAH_VERSION_LOG naming a person's version log and a profile versions block, the adopted version's offers run on every encounter it applies to.
  const versionLog = process.env["HEY_PISGAH_VERSION_LOG"];
  if (versionLog && !profile.versions) throw new Error("HEY_PISGAH_VERSION_LOG is set but the profile has no versions block");
  const adopted = versionLog ? adoptedForEmr(store, versionLog, () => loadProfile().versions!) : null;
  // The realtime ear's events are kept beside the transcripts when recording, and a kept run's events answer in place of the network when HEY_PISGAH_REALTIME_REPLAY names them.
  const replayFile = process.env["HEY_PISGAH_REALTIME_REPLAY"];
  const realtimeSocket = replayFile ? replaySocket(replayFile) : rec && asr === "meta-stream" ? recordingSocket(nodeSocket, join(rec, "realtime.jsonl")) : undefined;
  const s = await startEmrServe({
    storeRoot: store, port: rec ? keepingContext(port, join(rec, "context.json")) : port, recordingsDir: rec ? join(rec, "model") : join(store, "..", "emr-recordings"), hosts: ["127.0.0.1", "::1"],
    ...(rec ? { transcribe: recordingTranscriber(voiceTranscriber, join(rec, "transcripts.json")) } : {}),
    // Without a recordings folder no model request is kept, since gate requests carry heard words; the second ear is on unless turned off.
    recordModel: !!rec || process.env["HEY_PISGAH_RECORD_MODEL"] === "1", ears: process.env["HEY_PISGAH_SECOND_EAR"] === "off" ? "off" : earSwitch(process.env["HEY_PISGAH_EAR"]),
    // Every ear switch is off unless set: HEY_PISGAH_EAR=parakeet, HEY_PISGAH_ASR=stream or meta-stream (models under HEY_PISGAH_ASR_DIR), HEY_PISGAH_LANGUAGE_BIAS=1.
    asr, ...(realtimeSocket ? { realtimeSocket } : {}), languageBias: languageBiasFrom(process.env["HEY_PISGAH_LANGUAGE_BIAS"]), vtReadings: Number(process.env["HEY_PISGAH_VT_READINGS"] ?? 1),
    // D17 (Samuel, 30 Oct): whole-number vitals in range are written at once, on unless HEY_PISGAH_RELEASE_WHOLE=0.
    releaseWhole: process.env["HEY_PISGAH_RELEASE_WHOLE"] !== "0",
    // Staff names go in the hints: with names in them Voice Transcribe heard 26 of 26 names said, against 4 of 26 with the vitals words alone (G9).
    staffHints: staffHintsOf(profile), local: { ...localDirs(process.env["HEY_PISGAH_ASR_DIR"] ?? join(process.cwd(), ".hey-pisgah", "asr")), sherpaDir: process.env["HEY_PISGAH_SHERPA_DIR"] },
    ...(embed ? { embed } : {}),
    // The replay defence is on for the live serve; presence becomes required once the strip sends its liveness marker.
    listen: { replay: process.env["HEY_PISGAH_REPLAY_GUARD"] === "off" ? "off" : "refuse", presence: process.env["HEY_PISGAH_PRESENCE"] === "required" ? "required" : "observed" },
    listenPort: Number(process.env["HEY_PISGAH_EMR_PORT"] ?? 4100),
    // The wake-phrase spotter's files for the strip, and the A&E clinic an emergency opened by voice lands on.
    ...(process.env["HEY_PISGAH_KWS_DIR"] ? { kwsDir: process.env["HEY_PISGAH_KWS_DIR"] } : {}),
    ...(process.env["HEY_PISGAH_EMERGENCY_CLINIC"] ? { emergencyClinicId: process.env["HEY_PISGAH_EMERGENCY_CLINIC"] } : {}), runtime: { holdMs: Number(process.env["HEY_PISGAH_HOLD_MS"] ?? 4000), speed: leversFrom(process.env["HEY_PISGAH_SPEED"] ?? KEPT_LEVERS), keepHeard: process.env["HEY_PISGAH_KEEP_HEARD"] === "1", ...(profile.owners.length ? { watchMs: Number(process.env["HEY_PISGAH_WATCH_MS"] ?? 5000) } : {}), ...(adopted ? { versions: adopted.wiring } : {}) },
    log: (l) => process.stderr.write(`${l}\n`)
  });
  process.stdout.write(`emr serve on ${s.urls.join(" ")} (mode ${s.client.mode}, ${Object.keys(bearers).length} owner${Object.keys(bearers).length > 1 ? "s" : ""}, speaker model ${embed ? "on" : "off"}, ears ${earSwitch(process.env["HEY_PISGAH_EAR"])}/${asr}${adopted ? `, workflow version ${adopted.def.version} adopted` : ""})\n`);
  const stop = () => { void s.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
