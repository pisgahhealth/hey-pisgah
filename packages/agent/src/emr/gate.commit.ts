import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hashJson } from "@hey-pisgah/contracts";
import { gateCommitmentBody } from "./gate.js";

export const GATE_COMMITMENT_FILE = fileURLToPath(new URL("../../../../evaluation/commitments/gate.json", import.meta.url));
type Revision = { revision: number; hash: string; reason: string; body: unknown };
type File = { artifact: "gate"; revisions: Revision[] };
const read = (file: string): File | null => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as File) : null);

// The gate hash in force: the last revision of the commitment file.
export const committedGateHash = (file = GATE_COMMITMENT_FILE): string | null => read(file)?.revisions.at(-1)?.hash ?? null;
export const currentGateHash = (): string => hashJson(gateCommitmentBody());

// Appends a revision when the gate changed; earlier revisions are never rewritten.
export function commitGate(reason: string, file = GATE_COMMITMENT_FILE): { hash: string; appended: boolean } {
  const body = gateCommitmentBody();
  const hash = hashJson(body);
  const cur = read(file);
  if (cur?.revisions.at(-1)?.hash === hash) return { hash, appended: false };
  const next: File = { artifact: "gate", revisions: [...(cur?.revisions ?? []), { revision: (cur?.revisions.length ?? 0) + 1, hash, reason, body }] };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 1)}\n`);
  return { hash, appended: true };
}

if (process.argv[1]?.endsWith("gate.commit.ts")) {
  const reason = process.argv[process.argv.indexOf("--reason") + 1];
  if (!process.argv.includes("--write") || !reason || reason.startsWith("--")) console.log(committedGateHash() === currentGateHash() ? "gate commitment holds" : "gate commitment is stale");
  else console.log(JSON.stringify(commitGate(reason)));
}
