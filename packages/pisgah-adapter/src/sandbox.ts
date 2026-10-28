import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseEnvText } from "@hey-pisgah/model";

// The private profile's sandbox block: where the loopback sandbox keeps its env file, how to mint an agent, and the read-only checks.
export const SandboxBlock = z.strictObject({
  env_file: z.string().min(1),
  db_url_var: z.string().regex(/^[A-Z_]+$/),
  owner: z.string().min(1),
  // The mint script prints one JSON line; output names its bearer, owner and agent fields.
  mint: z.strictObject({ cwd: z.string().min(1), command: z.string().min(1), args: z.array(z.string()), node_options: z.string(), output: z.strictObject({ bearer: z.string(), owner: z.string(), agent: z.string() }) }),
  // The other owners whose agents serve mints, by login and clinic; their password is the sandbox's own.
  owners: z.array(z.strictObject({ login: z.string().regex(/^[a-z0-9._-]{1,40}$/), clinic: z.string().min(1).max(80).optional() })).default([]),
  sql: z.record(z.string(), z.string()),
  // Words that mark sandbox records, removed from anything published.
  scrub: z.array(z.string().min(1)).default([]),
  // The seed's ids for the journey, written by the platform's own seed script.
  journey_file: z.string().min(1).optional(),
  // Steps a person does in the journey, run with the person's own bearer; agents never call these.
  person_ops: z.record(z.string(), z.strictObject({ login: z.string(), clinic: z.string().optional(), method: z.enum(["GET", "POST"]), path: z.string(), body: z.record(z.string(), z.json()).optional(), query: z.record(z.string(), z.string()).optional() })).default({})
});
export type SandboxBlock = z.infer<typeof SandboxBlock>;

const envOf = (s: SandboxBlock): Record<string, string> => parseEnvText(readFileSync(s.env_file, "utf8"));
const loopback = (url: string) => /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);

// The mint arguments for one login: the profile's own arguments with the login and clinic swapped in, and the agent flag only for an agent.
export function mintArgs(s: SandboxBlock, who: { login: string; clinic?: string | undefined } | null, agent: boolean): string[] {
  const base = [...s.mint.args];
  if (!who) return agent ? base : base.filter((a) => a !== "--agent");
  const out: string[] = [];
  for (let i = 0; i < base.length; i++) {
    const a = base[i]!;
    if (a === "--login") { out.push(a, who.login); i++; continue; }
    if (a === "--clinic") { i++; continue; }
    if (a === "--agent") continue;
    out.push(a);
  }
  if (who.clinic) out.push("--clinic", who.clinic);
  if (agent) out.push("--agent");
  return out;
}

function runMint(s: SandboxBlock, args: string[]): string {
  const env = envOf(s);
  const db = env[s.db_url_var];
  if (!db || !loopback(db)) throw new Error("the sandbox database is not on loopback");
  return execFileSync(s.mint.command, args, {
    cwd: s.mint.cwd, env: { ...process.env, ...env, DATABASE_URL: db, NODE_OPTIONS: s.mint.node_options }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 180_000
  });
}

// Mints a person's own bearer for a step the person does in the journey; it is returned and never printed.
export function mintPersonBearer(s: SandboxBlock, who: { login: string; clinic?: string | undefined }): string {
  const m = /^bearer: (\S+)$/m.exec(runMint(s, mintArgs(s, who, false)));
  if (!m || m[1]!.length < 20) throw new Error("the mint script printed no bearer");
  return m[1]!;
}

// Mints an agent bearer for the sandbox owner, or for another login, through the platform's own script; the bearer is returned and never printed.
export function mintAgentBearer(s: SandboxBlock, who: { login: string; clinic?: string | undefined } | null = null): { bearer: string; owner: string; agent: string | null } {
  const out = runMint(s, mintArgs(s, who, true));
  const line = out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
  const j = z.record(z.string(), z.unknown()).parse(JSON.parse(line ?? "null"));
  const bearer = j[s.mint.output.bearer], owner = j[s.mint.output.owner], agent = j[s.mint.output.agent];
  if (typeof bearer !== "string" || bearer.length < 20 || typeof owner !== "string") throw new Error("the mint script printed no bearer and owner");
  return { bearer, owner, agent: typeof agent === "string" ? agent : null };
}

// Runs one named read-only query from the profile with psql variables, in a read-only transaction, and returns its rows.
export function sandboxQuery(s: SandboxBlock, name: string, vars: Record<string, string>): Record<string, unknown>[] {
  const sql = s.sql[name];
  if (!sql) throw new Error(`no sandbox query named ${name}`);
  const db = envOf(s)[s.db_url_var];
  if (!db || !loopback(db)) throw new Error("the sandbox database is not on loopback");
  const args = ["-X", "-At", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), db];
  const out = execFileSync("psql", args, {
    input: `select coalesce(json_agg(t), '[]'::json) from (${sql}) t;\n`, encoding: "utf8",
    env: { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on" }, stdio: ["pipe", "pipe", "pipe"], timeout: 30_000
  });
  return JSON.parse(out.trim()) as Record<string, unknown>[];
}
