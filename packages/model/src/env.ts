import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const KEYS_PATH = join(homedir(), ".hey-pisgah.env");

// Parses KEY=VALUE lines; values are returned to the caller and never logged.
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

// Keys come from ~/.hey-pisgah.env only, never from the process environment.
export function loadKeys(path = KEYS_PATH): Record<string, string> {
  return existsSync(path) ? parseEnvText(readFileSync(path, "utf8")) : {};
}

// Every non-empty value in the keys file, for leak scans.
export function secretValues(path = KEYS_PATH): string[] {
  return Object.values(loadKeys(path)).filter((v) => v.length >= 6);
}
