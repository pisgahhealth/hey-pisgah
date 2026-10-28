import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Walks up from the working directory to the repository root, which holds the claims registry.
export function repoRoot(start: string = process.env["HEY_PISGAH_ROOT"] ?? process.cwd()): string {
  let d = resolve(start);
  for (;;) {
    if (existsSync(join(d, "evaluation", "claims.json")) && existsSync(join(d, "packages"))) return d;
    const up = dirname(d);
    if (up === d) throw new Error(`repository root not found above ${start}`);
    d = up;
  }
}

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

export type Env = { seq: number; record_type: string; occurred_at: number; recorded_at: number; payload: Record<string, unknown> };

// Reads a store stream file without opening it as a stream, so the app can never write or recover it.
export function readJsonl(file: string): Env[] | null {
  if (!existsSync(file)) return null;
  const out: Env[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Env); } catch { break; }
  }
  return out;
}

// Turns a simulated minute since midnight into a clock time.
export function hhmm(minute: number): string {
  const day = Math.floor(minute / 1440);
  const m = ((minute % 1440) + 1440) % 1440;
  const t = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return day > 0 ? `${t} +${day}d` : t;
}
