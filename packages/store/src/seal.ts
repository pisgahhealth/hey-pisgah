import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StoreError } from "./errors.js";

// Areas whose heard words, names and phones are sealed at rest.
export const SEALED_AREAS: readonly string[] = ["emr", "learning"];
// Payload keys whose string values are sealed in those areas, at any depth.
export const SEALED_KEYS: ReadonlySet<string> = new Set([
  "text", "raw_text", "words", "quote", "said", "transcript", "raw_transcript", "question", "asked_for", "report", "draft", "summary", "title", "read", "label", "instruction", "message", "notes", "description", "history", "complaint",
  "name", "full_name", "display_name", "surname", "other_names", "first_name", "last_name", "middle_name", "given_name", "unidentified_ref", "phone", "phone_number", "mobile", "email", "address", "next_of_kin", "kin_name", "kin_phone", "relative"
]);
// Sealed keys whose words retention keeps, so a retained task still shows its patient label.
export const RETAIN_KEEPS: ReadonlySet<string> = new Set(["label"]);

export type SealKey = { enc: Buffer; mac: Buffer; kid: string };
export type Sealing = { key: SealKey | null; required: boolean };

const PREFIX = "hps1.";
let current: Sealing | undefined;

function parseKey(text: string): SealKey {
  const t = text.trim();
  const raw = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, "hex") : Buffer.from(t, "base64");
  if (raw.length !== 32) throw new StoreError("store_key_invalid", "the store key must be 32 bytes as 64 hex characters or base64");
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", raw, Buffer.alloc(0), info, 32));
  return { enc: derive("hey-pisgah store seal v1"), mac: derive("hey-pisgah store digest v1"), kid: createHash("sha256").update(raw).digest("hex").slice(0, 12) };
}

// Reads one KEY=VALUE line from the keys file without keeping the rest.
function keysFileValue(name: string): string | null {
  const file = join(homedir(), ".hey-pisgah.env");
  if (!existsSync(file)) return null;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line.startsWith(`${name}=`)) continue;
    const v = line.slice(name.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    return v || null;
  }
  return null;
}

// The hospital key comes from a file named by HEY_PISGAH_STORE_KEY_FILE or the keys file, never from the repo.
export function sealingFromEnv(env: NodeJS.ProcessEnv = process.env): Sealing {
  const file = env["HEY_PISGAH_STORE_KEY_FILE"];
  const text = file ? (existsSync(file) ? readFileSync(file, "utf8") : null) : keysFileValue("HEY_PISGAH_STORE_KEY");
  if (file && text === null) throw new StoreError("store_key_missing", "HEY_PISGAH_STORE_KEY_FILE names no file");
  return { key: text ? parseKey(text) : null, required: env["HEY_PISGAH_STORE_SEAL"] === "required" };
}

export function sealing(): Sealing {
  current ??= sealingFromEnv();
  return current;
}

// Sets the key for this process, for serves given it directly and for tests; undefined reloads from the environment.
export function configureSealing(o: { key: string | null; required?: boolean } | undefined): void {
  current = o === undefined ? undefined : { key: o.key ? parseKey(o.key) : null, required: o.required ?? false };
}

export const areaSealed = (streamId: string): boolean => SEALED_AREAS.includes(streamId.split("/")[0]!);

function encrypt(k: SealKey, plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k.enc, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

function decrypt(k: SealKey, b64: string, aad: string): string {
  const buf = Buffer.from(b64, "base64");
  try {
    const d = createDecipheriv("aes-256-gcm", k.enc, buf.subarray(0, 12));
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  } catch {
    throw new StoreError("store_key_mismatch", "a sealed field did not open with this key", { aad });
  }
}

// A keyed digest of the words, kept after retention so the words can be proved later by whoever holds them and the key.
export const wordsDigest = (k: SealKey, plain: string): string => createHmac("sha256", k.mac).update(plain, "utf8").digest("hex");

type Sealed = { $sealed: 1; kid: string; digest: string; ct?: string; ct_sha256?: string };
const isSealed = (v: unknown): v is Sealed => !!v && typeof v === "object" && (v as Record<string, unknown>)["$sealed"] === 1;

// Walks a payload and rebuilds only the branches the visitor changes, so an untouched payload keeps its reference.
function walk(v: unknown, path: string, visit: (key: string, value: unknown, path: string) => unknown): unknown {
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x, i) => { const y = walk(x, `${path}[${i}]`, visit); if (y !== x) changed = true; return y; });
    return changed ? out : v;
  }
  if (!v || typeof v !== "object" || isSealed(v)) return v;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const p = `${path}.${k}`;
    const own = visit(k, x, p);
    const y = own === x ? walk(x, p, visit) : own;
    if (y !== x) changed = true;
    out[k] = y;
  }
  return changed ? out : v;
}

const aadOf = (streamId: string, seq: number, path: string) => `${streamId}|${seq}|${path}`;

// True when a payload holds a non-empty sensitive string that is not sealed, as a journal written before the key does.
export function hasPlainWords(payload: unknown): boolean {
  let found = false;
  walk(payload, "$", (key, value) => { if (!found && SEALED_KEYS.has(key) && typeof value === "string" && value !== "") found = true; return value; });
  return found;
}

export function hasSealMarker(payload: unknown): boolean {
  let found = false;
  const scan = (v: unknown): void => { if (found) return; if (isSealed(v)) { found = true; return; } if (Array.isArray(v)) v.forEach(scan); else if (v && typeof v === "object") Object.values(v).forEach(scan); };
  scan(payload);
  return found;
}

// Seals every non-empty string under a sealed key; the AAD binds each value to its stream, line and field.
export function sealPayload(k: SealKey, payload: unknown, streamId: string, seq: number): unknown {
  return walk(payload, "$", (key, value, path) =>
    SEALED_KEYS.has(key) && typeof value === "string" && value !== "" ? { $sealed: 1, kid: k.kid, digest: wordsDigest(k, value), ct: encrypt(k, value, aadOf(streamId, seq, path)) } : value);
}

// Opens every sealed field; a retained field reads as an empty string, and a sealed field with no key or another key throws.
export function openPayload(k: SealKey | null, payload: unknown, streamId: string, seq: number): unknown {
  return walk(payload, "$", (_key, value, path) => {
    if (!isSealed(value)) return value;
    if (typeof value.ct !== "string") return "";
    if (!k) throw new StoreError("store_key_missing", "this stream holds sealed words and no store key is configured", { stream_id: streamId, seq });
    if (value.kid !== k.kid) throw new StoreError("store_key_mismatch", "this stream was sealed with another store key", { stream_id: streamId, seq, kid: value.kid });
    return decrypt(k, value.ct, aadOf(streamId, seq, path));
  });
}

// Drops the ciphertext of every sealed field except the kept keys, leaving its digest and the hash of what was dropped.
export function retainPayload(payload: unknown, keep: ReadonlySet<string> = RETAIN_KEEPS): { payload: unknown; fields: number } {
  let fields = 0;
  const out = walk(payload, "$", (key, value) => {
    if (!isSealed(value) || typeof value.ct !== "string" || keep.has(key)) return value;
    fields += 1;
    const { ct, ...rest } = value;
    return { ...rest, ct_sha256: createHash("sha256").update(ct, "utf8").digest("hex") };
  });
  return { payload: out, fields };
}

// Seals one text, such as a pending transcript file, under its context; with no key configured it is returned as it is unless sealing is required.
export function seal(plain: string, context: string): string {
  const s = sealing();
  if (!s.key) {
    if (s.required) throw new StoreError("store_key_missing", "sealing is required and no store key is configured");
    return plain;
  }
  return `${PREFIX}${s.key.kid}.${encrypt(s.key, plain, `text|${context}`)}`;
}

// Opens a text sealed by seal(); text that was never sealed passes through, so older plain files still read.
export function open(text: string, context: string): string {
  if (!text.startsWith(PREFIX)) return text;
  const s = sealing();
  const [kid, b64] = text.slice(PREFIX.length).split(".", 2) as [string, string | undefined];
  if (!s.key) throw new StoreError("store_key_missing", "this text is sealed and no store key is configured");
  if (kid !== s.key.kid || b64 === undefined) throw new StoreError("store_key_mismatch", "this text was sealed with another store key", { kid });
  return decrypt(s.key, b64, `text|${context}`);
}
