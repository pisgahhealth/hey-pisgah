import { hashJson } from "@hey-pisgah/contracts";
import { gateCommitmentBody } from "@hey-pisgah/agent";
import { commit, committedHash, journeyCommitmentBody, loadJourney } from "@hey-pisgah/evaluator";
import { loadProfile } from "./profile.js";
import { PisgahPort } from "./port.js";

// The journey body for this profile: each owner's gate is hashed by role, so the commitment names no owner id.
export function journeyBody(): Record<string, unknown> {
  const profile = loadProfile();
  const port = new PisgahPort(profile, { bearers: {} });
  const roles = ["doctor", "nurse", "accounts"];
  const gates = Object.fromEntries(profile.owners.map((o, i) => [roles[i] ?? `owner${i + 1}`, hashJson(gateCommitmentBody(port.kindsFor(o.id), port.names()))]));
  return journeyCommitmentBody(loadJourney(), gates);
}

if (process.argv[1]?.endsWith("journey.commit.ts")) {
  const body = journeyBody();
  const reason = process.argv[process.argv.indexOf("--reason") + 1];
  if (!process.argv.includes("--write") || !reason || reason.startsWith("--")) console.log(committedHash("journey") === hashJson(body) ? "journey commitment holds" : "journey commitment is stale");
  else console.log(JSON.stringify(commit("journey", body, reason)));
}
