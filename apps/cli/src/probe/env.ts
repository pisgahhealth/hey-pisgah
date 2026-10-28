import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

// Parses KEY=VALUE lines from the keys file without ever echoing a value.
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

export function loadKeys(path = `${homedir()}/.hey-pisgah.env`): Record<string, string> {
  const file = existsSync(path) ? parseEnvText(readFileSync(path, "utf8")) : {};
  return { ...file, ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith("HEY_PISGAH_") && v !== undefined) as [string, string][]) };
}
