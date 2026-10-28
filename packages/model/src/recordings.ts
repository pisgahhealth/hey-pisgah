import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, sha256 } from "@hey-pisgah/contracts";
import { ModelError } from "./errors.js";

export const DEFAULT_RECORDINGS_DIR = fileURLToPath(new URL("../fixtures/recordings", import.meta.url));

// Response headers worth keeping; nothing that could carry a credential.
export const HEADER_WHITELIST = ["content-type", "date", "x-request-id", "openai-processing-ms", "modal-function-call-id"] as const;

export type Recording = {
  hash: string;
  provider: string;
  request: unknown;
  response: unknown;
  headers: Record<string, string>;
  status: number;
  latency_ms: number;
  recorded_at: string;
};

// Strips undefined so the hash is over the JSON the wire would carry.
export function wireJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function requestHash(provider: string, body: unknown): string {
  return sha256(canonical({ provider, body: wireJson(body) }));
}

// One call's reply within one run: the body hash, the run id and the how-many-th identical body this run sent, so two runs never share a reply.
export type RunRecording = {
  hash: string;
  body_hash: string;
  run_id: string;
  occurrence: number;
  provider: string;
  response: unknown;
  headers: Record<string, string>;
  status: number;
  latency_ms: number;
  recorded_at: string;
};

export function runRecordingKey(provider: string, bodyHash: string, runId: string, occurrence: number): string {
  return sha256(canonical({ provider, body_hash: bodyHash, run_id: runId, occurrence }));
}

export function pickHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of HEADER_WHITELIST) {
    const v = h.get(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

// Refuses to write a recording that contains any secret value.
export function writeRecording(dir: string, rec: Recording | RunRecording, secrets: readonly string[]): string {
  const text = `${JSON.stringify(rec, null, 2)}\n`;
  if (secrets.some((s) => s.length > 0 && text.includes(s))) throw new ModelError("secret_in_recording", "a key value appeared in a recording; nothing was written");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${rec.hash}.json`);
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { flag: "wx" });
  renameSync(tmp, file);
  return file;
}

// The run-keyed reply when one was recorded, else null; replay then falls back to the body-keyed recording.
export function readRunRecording(dir: string, key: string, bodyHash: string): RunRecording | null {
  const file = join(dir, `${key}.json`);
  if (!existsSync(file)) return null;
  const rec = JSON.parse(readFileSync(file, "utf8")) as RunRecording;
  if (rec.body_hash !== bodyHash) throw new ModelError("replay_miss", `run recording ${key} answers a different request`, { hash: bodyHash, dir });
  return rec;
}

export function readRecording(dir: string, hash: string): Recording {
  const file = join(dir, `${hash}.json`);
  if (!existsSync(file)) {
    const have = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0;
    throw new ModelError("replay_miss", `no recording for request ${hash}; record it with HEY_PISGAH_MODE=live`, { hash, dir, recordings: have });
  }
  return JSON.parse(readFileSync(file, "utf8")) as Recording;
}
