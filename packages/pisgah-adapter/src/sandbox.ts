import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
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

function mintEnv(s: SandboxBlock): { cwd: string; env: NodeJS.ProcessEnv; timeout: number } {
  const env = envOf(s);
  const db = env[s.db_url_var];
  if (!db || !loopback(db)) throw new Error("the sandbox database is not on loopback");
  return { cwd: s.mint.cwd, env: { ...process.env, ...env, DATABASE_URL: db, NODE_OPTIONS: s.mint.node_options }, timeout: 180_000 };
}

function runMint(s: SandboxBlock, args: string[]): string {
  return execFileSync(s.mint.command, args, { ...mintEnv(s), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// Mints a person's own bearer for a step the person does in the journey; it is returned and never printed.
export function mintPersonBearer(s: SandboxBlock, who: { login: string; clinic?: string | undefined }): string {
  const m = /^bearer: (\S+)$/m.exec(runMint(s, mintArgs(s, who, false)));
  if (!m || m[1]!.length < 20) throw new Error("the mint script printed no bearer");
  return m[1]!;
}

// Mints an agent bearer for the sandbox owner, or for another login, through the platform's own script; the bearer is returned and never printed.
export function mintAgentBearer(s: SandboxBlock, who: { login: string; clinic?: string | undefined } | null = null): { bearer: string; owner: string; agent: string | null } {
  return agentOf(s, runMint(s, mintArgs(s, who, true)));
}

// The same mint without blocking, so a serve re-minting an expired bearer keeps answering meanwhile.
export async function mintAgentBearerAsync(s: SandboxBlock, who: { login: string; clinic?: string | undefined } | null = null): Promise<{ bearer: string; owner: string; agent: string | null }> {
  const run = promisify(execFile)(s.mint.command, mintArgs(s, who, true), { ...mintEnv(s), encoding: "utf8" });
  run.child.stdin?.end();
  return agentOf(s, (await run).stdout);
}

function agentOf(s: SandboxBlock, out: string): { bearer: string; owner: string; agent: string | null } {
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

// Mints a person's own web session cookie for a step only the web offers; it is returned and never printed.
export function mintPersonCookie(s: SandboxBlock, who: { login: string; clinic?: string | undefined }): string {
  const m = /^cookie: (\S+)$/m.exec(runMint(s, mintArgs(s, who, false)));
  if (!m || m[1]!.length < 30) throw new Error("the mint script printed no cookie");
  return m[1]!;
}

// What the hospital's agent mint answers: the bearer, its owner and agent, and when it expires.
const DoorMint = z.object({ bearer: z.string().min(20), owner: z.string(), agent: z.string().nullable(), expires_at: z.string() });

// The hospital's agent mint and the serve's hospital key, from HEY_PISGAH_MINT_URL and HEY_PISGAH_SERVE_KEY; null unless both are set, and plain http only to loopback.
export function doorMintFrom(env: Record<string, string | undefined>): { url: string; key: string } | null {
  const url = env["HEY_PISGAH_MINT_URL"], key = env["HEY_PISGAH_SERVE_KEY"];
  if (!url || !key) return null;
  const u = new URL(url);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) throw new Error("HEY_PISGAH_MINT_URL must be https, or http on loopback");
  return { url, key };
}

// Mints an owner's agent bearer at the hospital's own mint with the serve's key; null when the owner has no live login there, so a person never logged in gets no agent.
export async function mintAgentBearerFromDoor(door: { url: string; key: string }, owner: string, f: typeof fetch = fetch): Promise<{ bearer: string; owner: string; agent: string | null; expiresAt: number } | null> {
  const res = await f(door.url, { method: "POST", headers: { authorization: `Bearer ${door.key}`, "content-type": "application/json" }, body: JSON.stringify({ owner }), signal: AbortSignal.timeout(15_000) });
  if (res.status === 409 || res.status === 404) return null;
  if (!res.ok) throw new Error(`the hospital's mint answered ${res.status}`);
  const j = DoorMint.parse(await res.json());
  if (j.owner !== owner) throw new Error("the mint named another owner");
  return { bearer: j.bearer, owner, agent: j.agent, expiresAt: Date.parse(j.expires_at) };
}

// A bearer's expiry from its own exp claim in milliseconds, or null when it carries none.
export function bearerExpiry(bearer: string): number | null {
  try {
    const exp = (JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch { return null; }
}

// Mints again each owner's bearer that is missing or expires within aheadMs, keeping the old one when a mint fails or finds no live login, and returns the owners renewed.
export async function renewBearers(bearers: Record<string, string>, owners: readonly string[], mint: (owner: string) => Promise<string | null>, o: { now?: number; aheadMs?: number } = {}): Promise<string[]> {
  const now = o.now ?? Date.now(), ahead = o.aheadMs ?? 15 * 60_000, renewed: string[] = [];
  for (const owner of owners) {
    const current = bearers[owner];
    const exp = current ? bearerExpiry(current) : null;
    if (current && (exp === null || exp - now > ahead)) continue;
    const fresh = await mint(owner).catch(() => null);
    if (fresh) { bearers[owner] = fresh; renewed.push(owner); }
  }
  return renewed;
}
