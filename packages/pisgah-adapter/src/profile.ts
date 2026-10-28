import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { EmrId } from "@hey-pisgah/agent";

// The door's route table, header names and target ids live in a private profile file, so this public package names none of them.
export const DEFAULT_PROFILE_PATH = join(homedir(), ".hey-pisgah-door.json");

const HeaderName = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/);
const PathTpl = z.string().regex(/^[a-z0-9_{}-]+(\/[a-z0-9_{}-]+)*$/);
const Dotted = z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/);

export const DoorProfile = z.strictObject({
  base_url: z.url(),
  timeout_ms: z.number().int().min(1000).max(900_000).default(300_000),
  headers: z.strictObject({ on_behalf_of: HeaderName, origin: HeaderName, evidence: HeaderName, spoken_at: HeaderName, idempotency: HeaderName, replayed: HeaderName }),
  origin_value: z.string().regex(/^[a-z][a-z_]{0,39}$/),
  // Paths the port never calls, whatever asks; checked before the allowlist.
  deny: z.array(z.string().regex(/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/)).min(1),
  ops: z.strictObject({
    read_admission: z.strictObject({ method: z.literal("GET"), path: PathTpl, label: Dotted, facts: z.record(z.string(), Dotted), proof: z.record(z.string(), Dotted) }),
    write_observation: z.strictObject({ method: z.literal("POST"), path: PathTpl, body: z.record(z.string(), z.json()), writes_path: Dotted, primary_store: z.string().min(1) }),
    // The current inpatients the owner may see, so a caller can pick a live admission rather than a stored id.
    census: z.strictObject({ method: z.literal("GET"), path: PathTpl, list_path: Dotted, admission_path: Dotted, label_path: Dotted }).optional()
  }),
  targets: z.strictObject({ admission_by_patient: z.record(EmrId, EmrId), episode_by_admission: z.record(EmrId, EmrId) }),
  vocabulary: z.array(z.string().min(1).max(60)).max(60).default([]),
  // Only the sandbox integration test reads this block.
  sandbox: z.record(z.string(), z.json()).optional()
});
export type DoorProfile = z.infer<typeof DoorProfile>;

export function profilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env["HEY_PISGAH_DOOR_PROFILE"] || DEFAULT_PROFILE_PATH;
}

export function loadProfile(path = profilePath()): DoorProfile {
  if (!existsSync(path)) throw new Error("no door profile; set HEY_PISGAH_DOOR_PROFILE to a private profile file");
  return DoorProfile.parse(JSON.parse(readFileSync(path, "utf8")));
}

// Reads a dotted path such as "a.b.0.c" out of a JSON value.
export function pick(v: unknown, path: string): unknown {
  let cur: unknown = v;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

// Fills a body template: a string that is exactly "$name" takes that value, and its key is dropped when the value is absent.
export function fillTemplate(tpl: unknown, vars: Record<string, unknown>): unknown {
  if (typeof tpl === "string" && /^\$[a-z_]+$/.test(tpl)) return vars[tpl.slice(1)];
  if (Array.isArray(tpl)) return tpl.map((x) => fillTemplate(x, vars)).filter((x) => x !== undefined);
  if (tpl && typeof tpl === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(tpl)) { const y = fillTemplate(x, vars); if (y !== undefined) out[k] = y; }
    return out;
  }
  return tpl;
}

// Fills "{name}" segments of a path template; every value must be an id, so nothing can step out of the route.
export function fillPath(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{([a-z_]+)\}/g, (_m, k: string) => {
    const v = vars[k];
    if (v === undefined || !EmrId.safeParse(v).success) throw new Error(`path value ${k} is not an id`);
    return v;
  });
}

// A path template as a whole-path pattern, with each "{name}" matching one id.
export function pathPattern(tpl: string): RegExp {
  const esc = tpl.split(/\{[a-z_]+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${esc.join("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")}$`);
}
