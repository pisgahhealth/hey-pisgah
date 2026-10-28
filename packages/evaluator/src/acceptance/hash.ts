import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hashJson, sha256 } from "@hey-pisgah/contracts";
import { ACCEPTANCE_DIR } from "../data.js";

const CODE_DIR = fileURLToPath(new URL("./", import.meta.url));

// The frozen acceptance code and the content rules, hashed together; a change shows as a new hash.
export function acceptanceHash(): string {
  const files: Record<string, string> = {};
  for (const f of readdirSync(CODE_DIR).filter((x) => x.endsWith(".ts")).sort()) files[`src/acceptance/${f}`] = sha256(readFileSync(`${CODE_DIR}${f}`, "utf8"));
  files["acceptance/content-rules.json"] = sha256(readFileSync(`${ACCEPTANCE_DIR}content-rules.json`, "utf8"));
  return hashJson(files);
}

export const committedAcceptanceHash = (): string => readFileSync(`${ACCEPTANCE_DIR}acceptance.sha256`, "utf8").trim().split(/\s+/)[0] ?? "";

if (process.argv[1]?.endsWith("hash.ts") && process.argv[2] === "--write") writeFileSync(`${ACCEPTANCE_DIR}acceptance.sha256`, `${acceptanceHash()}\n`);
