import { createHash } from "node:crypto";

// Frozen: canonical JSON (sorted keys, no whitespace) and sha256 over it; every hash in the system uses these two functions.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export class NotCanonicalisable extends Error {}

export function canonical(value: unknown, path = "$"): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new NotCanonicalisable(`${path}: non-finite number`);
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "undefined") throw new NotCanonicalisable(`${path}: undefined is not JSON`);
  if (Array.isArray(value)) return `[${value.map((v, i) => canonical(v, `${path}[${i}]`)).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k], `${path}.${k}`)}`).join(",")}}`;
  }
  throw new NotCanonicalisable(`${path}: only plain objects, arrays and JSON scalars`);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hashJson(value: unknown): string {
  return sha256(canonical(value));
}
