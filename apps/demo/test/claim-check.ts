import { readFileSync } from "node:fs";
import { join } from "node:path";

// An independent reader of rendered HTML for the registry rule; it shares no code with the components it checks.
export type Registry = { claims: { claim_id: string; question: string; wording: Record<"pass" | "partial" | "fail" | "not_measured", string> }[] };
export type StatusFile = { claims: { claim_id: string; status: string; values: Record<string, unknown> }[] };
export type ClaimEl = { id: string; status: string; wording: string | null; start: number; end: number };

const KEY: Record<string, "pass" | "partial" | "fail" | "not_measured"> = { green: "pass", amber: "partial", red: "fail", not_measured: "not_measured" };

export function loadRegistry(root: string): { registry: Registry; status: StatusFile } {
  return {
    registry: JSON.parse(readFileSync(join(root, "evaluation", "claims.json"), "utf8")) as Registry,
    status: JSON.parse(readFileSync(join(root, "evaluation", "claims.status.json"), "utf8")) as StatusFile
  };
}

export function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");
}

function elementEnd(html: string, start: number): number {
  const tag = /^<([a-zA-Z0-9]+)/.exec(html.slice(start))?.[1];
  if (!tag) throw new Error(`no tag at ${start}`);
  const re = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, "g");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1]) depth -= 1; else if (!m[2]) depth += 1;
    if (depth === 0) return re.lastIndex;
  }
  throw new Error(`unclosed <${tag}> at ${start}`);
}

export function claimElements(html: string): ClaimEl[] {
  const out: ClaimEl[] = [];
  const re = /data-claim="([^"]*)"/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const start = html.lastIndexOf("<", m.index);
    const end = elementEnd(html, start);
    const open = html.slice(start, html.indexOf(">", start) + 1);
    const inner = html.slice(start, end);
    const w = /<span[^>]*data-claim-wording=""[^>]*>([^<]*)<\/span>/.exec(inner);
    out.push({ id: m[1]!, status: /data-claim-status="([^"]*)"/.exec(open)?.[1] ?? "", wording: w ? decode(w[1]!) : null, start, end });
    re.lastIndex = end;
  }
  return out;
}

export function expectedWording(reg: Registry, st: StatusFile, id: string): string | null {
  const c = reg.claims.find((x) => x.claim_id === id);
  const s = st.claims.find((x) => x.claim_id === id);
  if (!c || !s) return null;
  const key = KEY[s.status];
  if (!key) return null;
  return c.wording[key].replace(/\{([a-z0-9_]+)\}/g, (_, k: string) => (s.values[k] === undefined || s.values[k] === null ? `[${k} missing]` : String(s.values[k])));
}

// Every fixed piece of claim text: the questions and each wording split at its value slots.
export function claimFragments(reg: Registry): string[] {
  const out = new Set<string>();
  for (const c of reg.claims) {
    out.add(c.question);
    for (const w of Object.values(c.wording)) for (const piece of w.split(/\{[a-z0-9_]+\}/)) if (piece.trim().split(/\s+/).length >= 3) out.add(piece.trim());
  }
  return [...out];
}

export function stripClaims(html: string): string {
  let out = "";
  let at = 0;
  for (const el of claimElements(html)) { out += html.slice(at, el.start); at = el.end; }
  return out + html.slice(at);
}

function text(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").toLowerCase();
}

// Returns every breach of the registry rule in one rendered page.
export function checkHtml(html: string, reg: Registry, st: StatusFile): string[] {
  const problems: string[] = [];
  const ids = new Set(reg.claims.map((c) => c.claim_id));
  for (const el of claimElements(html)) {
    if (!ids.has(el.id)) { problems.push(`${el.id}: not a registry id`); continue; }
    const s = st.claims.find((x) => x.claim_id === el.id)?.status;
    if (el.status !== s) problems.push(`${el.id}: shows status ${el.status}, file says ${String(s)}`);
    const want = expectedWording(reg, st, el.id);
    if (el.wording !== want) problems.push(`${el.id}: shows "${String(el.wording)}", registry wording is "${String(want)}"`);
  }
  const stripped = stripClaims(html);
  const rest = `${text(stripped)}\n${decode(stripped).toLowerCase()}`;
  for (const f of claimFragments(reg)) if (rest.includes(f.toLowerCase())) problems.push(`claim text outside a registry component: "${f}"`);
  return problems;
}
