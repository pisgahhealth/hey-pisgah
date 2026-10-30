import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hashJson } from "@hey-pisgah/contracts";
import { PRESENCE_RULE } from "@hey-pisgah/agent";

// The attribution thresholds as configuration: each revision names its source and date, and a change is a new revision with a reason.
export const THRESHOLDS_FILE = fileURLToPath(new URL("../../../evaluation/commitments/attribution-thresholds.json", import.meta.url));

export type SpeakerRule = { model: string; template: string; owner_min: number; owner_margin: number; other_min: number; min_audio_ms: number };
export type ThresholdBody = { speaker: SpeakerRule; presence: Record<string, number> | null; authority: string };
export type ThresholdRevision = { revision: number; frozen_at: string; source: string; reason: string; hash: string; body: ThresholdBody };
export type ThresholdFile = { artifact: "attribution-thresholds"; revisions: ThresholdRevision[] };

const TEMPLATE = "mean of three enrolment clips, whole-clip cosine";
const AUTHORITY = "the owner's own instruction, or a yes bound to the read-back of the patient and batch on screen, from a chunk sequence that passed the session checks and was present";
export const SEED: Omit<ThresholdRevision, "hash">[] = [
  {
    revision: 1, frozen_at: "2026-10-29T12:00:00Z", source: "R1 tuning set: 96 synthetic clips from macOS voices, before the held-out run",
    reason: "first rule; the synthetic gap says little about people",
    body: { speaker: { model: "nemo_en_titanet_small", template: TEMPLATE, owner_min: 0.59, owner_margin: 0.25, other_min: 0.43, min_audio_ms: 500 }, presence: null, authority: "the owner's own instruction to the agent" }
  },
  {
    revision: 2, frozen_at: "2026-10-29T20:00:00Z", source: "R1.b tuning lines of the owner's real recordings (one enrolled voice); other_min kept from revision 1 as a placeholder",
    reason: "the synthetic 0.59 refused half the owner's real held-out lines; 0.41 is halfway between the owner's lowest tuning score and the second voice's highest; no colleague was enrolled, so no margin",
    body: { speaker: { model: "nemo_en_titanet_small", template: TEMPLATE, owner_min: 0.41, owner_margin: 0, other_min: 0.43, min_audio_ms: 500 }, presence: null, authority: "the owner's own instruction to the agent" }
  },
  {
    revision: 3, frozen_at: "2026-10-30T08:00:00Z", source: "G4: the speaker rule of revision 2 unchanged; the presence rule added without data, provisional",
    reason: "R-26: replay is defended by session and presence, so their limits are frozen beside the voice rule before the v2 recordings are scored",
    body: { speaker: { model: "nemo_en_titanet_small", template: TEMPLATE, owner_min: 0.41, owner_margin: 0, other_min: 0.43, min_audio_ms: 500 }, presence: { ...PRESENCE_RULE }, authority: AUTHORITY }
  }
];

export const readThresholds = (file = THRESHOLDS_FILE): ThresholdFile => JSON.parse(readFileSync(file, "utf8")) as ThresholdFile;
// The revision in force: the last one in the file.
export const thresholdsInForce = (file = THRESHOLDS_FILE): ThresholdRevision => readThresholds(file).revisions.at(-1)!;
// The revision in force when a set was scored: the last one frozen strictly before that time.
export const thresholdsAt = (at: string, file = THRESHOLDS_FILE): ThresholdRevision | null => readThresholds(file).revisions.filter((r) => r.frozen_at < at).at(-1) ?? null;

// Appends any seed revision not yet in the file; earlier revisions are never rewritten.
export function commitThresholds(file = THRESHOLDS_FILE): ThresholdFile {
  const cur: ThresholdFile = existsSync(file) ? readThresholds(file) : { artifact: "attribution-thresholds", revisions: [] };
  for (const r of SEED.slice(cur.revisions.length)) cur.revisions.push({ ...r, hash: hashJson(r.body) });
  writeFileSync(file, `${JSON.stringify(cur, null, 1)}\n`);
  return cur;
}

if (process.argv[1]?.endsWith("thresholds.ts") && process.argv.includes("--write")) console.log(commitThresholds().revisions.map((r) => `${r.revision} ${r.hash.slice(0, 12)}`).join("\n"));
