import { join } from "node:path";
import { startEmrServe } from "@hey-pisgah/agent";
import { loadProfile } from "./profile.js";
import { PisgahPort } from "./port.js";
import { SandboxBlock, mintAgentBearer, sandboxQuery } from "./sandbox.js";

// Starts the EMR-facing serve on port 4100 over the agent door; the bearer comes from the environment or a sandbox mint.
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
  const store = process.env["HEY_PISGAH_EMR_STORE"] ?? join(process.cwd(), ".hey-pisgah", "emr-store");
  const port = new PisgahPort(profile, {
    bearers: { [owner]: bearer },
    ...(sandbox ? { episodeFor: async (admission: string) => String(sandboxQuery(sandbox, "episode_for_admission", { admission })[0]?.["id"] ?? "") || null } : {}),
    onRequest: (l) => process.stderr.write(`door ${l.method} ${l.status ?? l.outcome} ${l.ms}ms${l.replayed ? " replayed" : ""}${l.reason ? ` ${l.reason}` : ""}\n`)
  });
  const s = await startEmrServe({
    storeRoot: store, port, recordingsDir: join(store, "..", "emr-recordings"), hosts: ["127.0.0.1", "::1"],
    listenPort: Number(process.env["HEY_PISGAH_EMR_PORT"] ?? 4100), runtime: { holdMs: Number(process.env["HEY_PISGAH_HOLD_MS"] ?? 4000) },
    log: (l) => process.stderr.write(`${l}\n`)
  });
  process.stdout.write(`emr serve on ${s.urls.join(" ")} (mode ${s.client.mode})\n`);
  const stop = () => { void s.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
