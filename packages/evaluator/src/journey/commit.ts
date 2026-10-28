import { hashJson } from "@hey-pisgah/contracts";
import { JOURNEY_RULES } from "./score.js";
import type { JourneyScript } from "./script.js";

// The body committed before a journey run: the script's hash, each decision point's acceptable classes, the scoring rules and each owner's gate hash.
export const journeyCommitmentBody = (s: JourneyScript, gates: Record<string, string>): Record<string, unknown> => ({
  artifact: "journey", journey_id: s.journey_id, script_sha256: hashJson(s),
  decision_points: s.decision_points.map((d) => ({ dp_id: d.dp_id, line: d.line, measure: d.measure, acceptable: d.acceptable })),
  rules: [...JOURNEY_RULES], gates
});
