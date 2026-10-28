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
  sql: z.record(z.string(), z.string())
});
export type SandboxBlock = z.infer<typeof SandboxBlock>;

const envOf = (s: SandboxBlock): Record<string, string> => parseEnvText(readFileSync(s.env_file, "utf8"));
const loopback = (url: string) => /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);

// Mints an agent bearer for the sandbox owner through the platform's own script; the bearer is returned and never printed.
export function mintAgentBearer(s: SandboxBlock): { bearer: string; owner: string; agent: string | null } {
  const env = envOf(s);
  const db = env[s.db_url_var];
  if (!db || !loopback(db)) throw new Error("the sandbox database is not on loopback");
  const out = execFileSync(s.mint.command, s.mint.args, {
    cwd: s.mint.cwd, env: { ...process.env, ...env, DATABASE_URL: db, NODE_OPTIONS: s.mint.node_options }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 180_000
  });
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
