import { createHmac, timingSafeEqual } from "node:crypto";

// The strip token: the hospital's EMR signs it for the signed-in owner, and the serve takes no task, listen, presence or review call without it.
export const STRIP_TOKEN_AUDIENCE = "hey-pisgah-strip";
// The longest life a token may claim, so a misconfigured signer still cannot hand out a day-long token.
export const STRIP_TOKEN_MAX_MS = 15 * 60_000;
// How far the signer's clock may sit ahead of the serve's.
export const STRIP_TOKEN_SKEW_MS = 30_000;
const MAX_TOKEN_CHARS = 1024;

export type StripClaims = { aud: string; sub: string; org: string; iat: number; exp: number };
export type StripVerdict = { ok: true; owner: string; hospital: string; exp: number } | { ok: false; reason: "missing" | "malformed" | "bad_signature" | "wrong_audience" | "wrong_hospital" | "expired" | "not_yet_valid" | "too_long" };
// Token mode checks every call; open mode is today's local behaviour and only an explicit development switch turns it on.
export type StripAuth = { mode: "token"; key: string; hospital: string } | { mode: "open" };

const b64 = (b: Buffer) => b.toString("base64url");
const macOf = (key: Buffer, body: string) => createHmac("sha256", key).update(`v1.${body}`, "utf8").digest();

// The key is base64url and at least 32 bytes, so a short or mistyped key stops the service instead of signing weakly.
export function stripKey(key: string): Buffer {
  const k = Buffer.from(key, "base64url");
  if (k.length < 32 || b64(k) !== key.replace(/=+$/, "")) throw new Error("the strip key must be base64url of at least 32 bytes");
  return k;
}

// Signs one token; the EMR has its own signer with the same text, and this one is for tests and tools.
export function signStripToken(key: string, c: { owner: string; hospital: string; iat: number; exp: number }): string {
  const body = b64(Buffer.from(JSON.stringify({ aud: STRIP_TOKEN_AUDIENCE, sub: c.owner, org: c.hospital, iat: c.iat, exp: c.exp } satisfies StripClaims), "utf8"));
  return `v1.${body}.${b64(macOf(stripKey(key), body))}`;
}

// Checks the signature first, then audience, hospital and time, so nothing in an unsigned token is read as a claim.
export function verifyStripToken(key: string, hospital: string, token: string | undefined, now: number): StripVerdict {
  if (!token) return { ok: false, reason: "missing" };
  if (token.length > MAX_TOKEN_CHARS) return { ok: false, reason: "malformed" };
  const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return { ok: false, reason: "malformed" };
  const want = macOf(stripKey(key), m[1]!), got = Buffer.from(m[2]!, "base64url");
  if (got.length !== want.length || !timingSafeEqual(want, got)) return { ok: false, reason: "bad_signature" };
  let c: Partial<StripClaims>;
  try { c = JSON.parse(Buffer.from(m[1]!, "base64url").toString("utf8")) as Partial<StripClaims>; } catch { return { ok: false, reason: "malformed" }; }
  if (typeof c.sub !== "string" || !c.sub || typeof c.org !== "string" || typeof c.iat !== "number" || typeof c.exp !== "number") return { ok: false, reason: "malformed" };
  if (c.aud !== STRIP_TOKEN_AUDIENCE) return { ok: false, reason: "wrong_audience" };
  if (c.org !== hospital) return { ok: false, reason: "wrong_hospital" };
  if (c.exp - c.iat > STRIP_TOKEN_MAX_MS) return { ok: false, reason: "too_long" };
  if (c.iat > now + STRIP_TOKEN_SKEW_MS) return { ok: false, reason: "not_yet_valid" };
  if (c.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, owner: c.sub, hospital: c.org, exp: c.exp };
}

// The bearer value of an Authorization header, or undefined.
export function bearerOf(header: string | string[] | undefined): string | undefined {
  const h = Array.isArray(header) ? header[0] : header;
  const m = h ? /^Bearer ([^\s]+)$/i.exec(h.trim()) : null;
  return m?.[1];
}

export type ServeConfig = { strip: StripAuth; hosts: string[]; allowOrigin?: string; hostNames?: string[] };
const LOOPBACK_BIND = new Set(["127.0.0.1", "::1", "localhost"]);
const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

// The serve's per-hospital configuration from its environment: the strip key and hospital, the EMR origin, the addresses it binds and the host names it answers to.
export function serveConfigFromEnv(env: Record<string, string | undefined>): ServeConfig {
  const key = env["HEY_PISGAH_STRIP_KEY"], hospital = env["HEY_PISGAH_STRIP_HOSPITAL"];
  const open = env["HEY_PISGAH_STRIP_OPEN"] === "1";
  if (key && open) throw new Error("set HEY_PISGAH_STRIP_KEY or HEY_PISGAH_STRIP_OPEN=1, not both");
  if (key && !hospital) throw new Error("HEY_PISGAH_STRIP_KEY needs HEY_PISGAH_STRIP_HOSPITAL, the hospital its tokens are for");
  if (key) stripKey(key);
  if (!key && !open) throw new Error("no strip key: set HEY_PISGAH_STRIP_KEY and HEY_PISGAH_STRIP_HOSPITAL, or HEY_PISGAH_STRIP_OPEN=1 for local development, where any local caller may act as any owner");
  const hosts = list(env["HEY_PISGAH_SERVE_HOSTS"]);
  const bind = hosts.length ? hosts : ["127.0.0.1", "::1"];
  // Off loopback an open serve would be anyone's, so binding elsewhere needs the key.
  if (!key && bind.some((h) => !LOOPBACK_BIND.has(h))) throw new Error("HEY_PISGAH_SERVE_HOSTS binds off loopback, which needs HEY_PISGAH_STRIP_KEY");
  const origin = env["HEY_PISGAH_STRIP_ORIGIN"]?.trim();
  if (origin && !/^https?:\/\/[^/\s]+$/.test(origin)) throw new Error("HEY_PISGAH_STRIP_ORIGIN is one origin, such as https://emr.example.org");
  const names = list(env["HEY_PISGAH_SERVE_HOSTNAMES"]);
  return { strip: key ? { mode: "token", key, hospital: hospital! } : { mode: "open" }, hosts: bind, ...(origin ? { allowOrigin: origin } : {}), ...(names.length ? { hostNames: names } : {}) };
}
