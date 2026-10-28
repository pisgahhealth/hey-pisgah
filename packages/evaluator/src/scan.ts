import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isInside } from "@hey-pisgah/store";

export type Channel = "prompt" | "tool_output" | "model_output" | "other";
export type Hit = { file: string; path: string; channel: Channel; token: string };
export type Tokens = { ids: readonly string[]; canaries: readonly string[] };

const roleChannel: Record<string, Channel> = { system: "prompt", developer: "prompt", user: "prompt", tool: "tool_output", assistant: "model_output" };
const keyChannel = (k: string): Channel | null => (/^(response|choices|output|completion|content_out)$/.test(k) ? "model_output" : /^(tool_result|tool_output|result)$/.test(k) ? "tool_output" : /^(prompt|messages|system|instructions|request)$/.test(k) ? "prompt" : null);

function hitsIn(text: string, tokens: Tokens): string[] {
  const lower = text.toLowerCase();
  return [...tokens.ids.filter((t) => text.includes(t)), ...tokens.canaries.filter((t) => lower.includes(t.toLowerCase()))];
}

// Walks one parsed transcript, labelling each string by the nearest role or key that says who wrote it.
export function scanValue(v: unknown, tokens: Tokens, file: string, path = "$", channel: Channel = "other", out: Hit[] = []): Hit[] {
  if (typeof v === "string") { for (const token of hitsIn(v, tokens)) out.push({ file, path, channel, token }); return out; }
  if (Array.isArray(v)) { v.forEach((x, i) => scanValue(x, tokens, file, `${path}[${i}]`, channel, out)); return out; }
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const here = typeof o["role"] === "string" ? roleChannel[o["role"]] ?? channel : channel;
    for (const [k, x] of Object.entries(o)) {
      for (const token of hitsIn(k, tokens)) out.push({ file, path: `${path}.${k}`, channel: here, token });
      scanValue(x, tokens, file, `${path}.${k}`, keyChannel(k) ?? here, out);
    }
  }
  return out;
}

// Parses a JSON or JSONL file; a line that is not JSON is scanned as plain text so nothing escapes.
export function scanFile(file: string, tokens: Tokens): Hit[] {
  const text = readFileSync(file, "utf8");
  const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return s; } };
  if (file.endsWith(".jsonl")) return text.split("\n").filter((l) => l.trim()).flatMap((l, i) => scanValue(parse(l), tokens, file, `$${i + 1}`));
  return scanValue(parse(text), tokens, file);
}

function files(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(json|jsonl|txt|md)$/.test(n) ? [p] : [];
  });
}

// Scans every transcript under the roots except anything inside a reserved run's own folder.
export function scanTranscripts(roots: readonly string[], tokens: Tokens, exclude: readonly string[]): Hit[] {
  return roots.flatMap(files).filter((f) => !exclude.some((x) => isInside(x, f))).flatMap((f) => scanFile(f, tokens));
}

export class TranscriptLeak extends Error {
  readonly code = "transcript_leak";
  constructor(readonly hits: Hit[]) { super(`${hits.length} reserved tokens in non-reserved transcripts`); }
}

// Throws when any non-reserved prompt, tool output or model output names a reserved id or canary.
export function assertNoReservedLeak(roots: readonly string[], tokens: Tokens, exclude: readonly string[]): void {
  const hits = scanTranscripts(roots, tokens, exclude);
  if (hits.length) throw new TranscriptLeak(hits);
}
