import { sha256 } from "@hey-pisgah/contracts";

// Deterministic ids: the first 8 hex characters of sha256 over the joined parts.
export const shortHash = (...parts: readonly (string | number)[]): string => sha256(parts.join("|")).slice(0, 8);
export const recordIdFor = (caseId: string, ...key: readonly (string | number)[]): string => `rec-${shortHash(caseId, "record", ...key)}`;
export const eventIdFor = (runId: string, ...key: readonly (string | number)[]): string => `ev-${shortHash(runId, ...key)}`;
