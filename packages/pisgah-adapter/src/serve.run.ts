import { join } from "node:path";
import { keepingContext, recordingTranscriber, startEmrServe, voiceTranscriber } from "@hey-pisgah/agent";
import { loadProfile } from "./profile.js";
import { PisgahPort } from "./port.js";
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
  const s = await startEmrServe({
    storeRoot: store, port: rec ? keepingContext(port, join(rec, "context.json")) : port, recordingsDir: rec ? join(rec, "model") : join(store, "..", "emr-recordings"), hosts: ["127.0.0.1", "::1"],
    ...(rec ? { transcribe: recordingTranscriber(voiceTranscriber, join(rec, "transcripts.json")) } : {}),
    // Without a recordings folder no model request is kept, since gate requests carry heard words; the second ear is on unless turned off.
    recordModel: !!rec || process.env["HEY_PISGAH_RECORD_MODEL"] === "1", ears: process.env["HEY_PISGAH_SECOND_EAR"] === "off" ? "off" : "spark",
    listenPort: Number(process.env["HEY_PISGAH_EMR_PORT"] ?? 4100), runtime: { holdMs: Number(process.env["HEY_PISGAH_HOLD_MS"] ?? 4000), keepHeard: process.env["HEY_PISGAH_KEEP_HEARD"] === "1", ...(profile.owners.length ? { watchMs: Number(process.env["HEY_PISGAH_WATCH_MS"] ?? 5000) } : {}) },
    log: (l) => process.stderr.write(`${l}\n`)
  });
  process.stdout.write(`emr serve on ${s.urls.join(" ")} (mode ${s.client.mode}, ${Object.keys(bearers).length} owner${Object.keys(bearers).length > 1 ? "s" : ""})\n`);
  const stop = () => { void s.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
