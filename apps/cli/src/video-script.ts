import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ClaimsStatusFile } from "@hey-pisgah/contracts";
import { ClaimsRegistry } from "./claims-check.js";

// Fills {name} placeholders from the measured values; a value that is missing stays visible as [name] so it is never silently dropped.
export const fill = (template: string, values: Record<string, unknown>): string =>
  template.replace(/\{([a-z0-9_]+)\}/g, (_, k: string) => (values[k] === null || values[k] === undefined ? `[${k}]` : String(values[k])));

export type ScriptLine = { claim_id: string; status: string; kind: "claim" | "limit"; text: string };

// Narration lines from the registry wording: green and amber claims are stated, red ones as limits; not-measured claims are left out and counted.
export function scriptLines(root: string, statusFile = `${root}/evaluation/claims.status.json`): { lines: ScriptLine[]; not_measured: string[] } {
  const registry = ClaimsRegistry.parse(JSON.parse(readFileSync(`${root}/evaluation/claims.json`, "utf8")));
  const status = ClaimsStatusFile.parse(JSON.parse(readFileSync(statusFile, "utf8")));
  const lines: ScriptLine[] = [];
  const notMeasured: string[] = [];
  for (const c of registry.claims) {
    const s = status.claims.find((x) => x.claim_id === c.claim_id);
    if (!s || s.status === "not_measured") { notMeasured.push(c.claim_id); continue; }
    const wording = s.status === "green" ? c.wording.pass : s.status === "amber" ? c.wording.partial : c.wording.fail;
    lines.push({ claim_id: c.claim_id, status: s.status, kind: s.status === "red" ? "limit" : "claim", text: s.status === "red" ? `A limit we found: ${fill(wording, s.values)}` : fill(wording, s.values) });
  }
  return { lines, not_measured: notMeasured };
}

// video:script [--status f] [--out f]: prints the narration and writes it as JSON when asked.
export function videoScript(root: string, argv: string[]): number {
  const at = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const statusFile = at("status") ?? `${root}/evaluation/claims.status.json`;
  if (!existsSync(statusFile)) { console.log("video:script: no claims status yet; run claims:check first"); return 3; }
  const r = scriptLines(root, statusFile);
  for (const l of r.lines) console.log(`${l.claim_id} [${l.status}] ${l.text}`);
  console.log(`not measured, left out: ${r.not_measured.join(", ") || "none"}`);
  const out = at("out");
  if (out) writeFileSync(out, `${JSON.stringify(r, null, 1)}\n`);
  return 0;
}
