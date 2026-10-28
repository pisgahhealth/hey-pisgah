// A small expression language for claim predicates: dotted field names, numbers, strings, true, false, null, comparisons, !, && and ||.
type Tok = { t: "num" | "str" | "id" | "op" | "lp" | "rp"; v: string };
export type Expr =
  | { k: "lit"; v: number | string | boolean | null }
  | { k: "id"; name: string }
  | { k: "not"; e: Expr }
  | { k: "bin"; op: string; a: Expr; b: Expr };

export class PredicateError extends Error { readonly code = "bad_predicate"; }

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|'([^']*)'|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)|(==|!=|>=|<=|&&|\|\||[<>!])|(\()|(\)))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new PredicateError(`cannot read "${src.slice(i, i + 12)}"`);
    i = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: "num", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "str", v: m[2] });
    else if (m[3] !== undefined) out.push({ t: "id", v: m[3] });
    else if (m[4] !== undefined) out.push({ t: "op", v: m[4] });
    else if (m[5] !== undefined) out.push({ t: "lp", v: "(" });
    else out.push({ t: "rp", v: ")" });
  }
  return out;
}

export function parsePredicate(src: string): Expr {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const take = (op?: string) => { const t = toks[p]; if (!t || (op !== undefined && t.v !== op)) throw new PredicateError(`expected ${op ?? "a term"}`); p += 1; return t; };
  const binary = (next: () => Expr, ops: string[]) => (): Expr => {
    let a = next();
    while (peek()?.t === "op" && ops.includes(peek()!.v)) { const op = take().v; a = { k: "bin", op, a, b: next() }; }
    return a;
  };
  const primary = (): Expr => {
    const t = take();
    if (t.t === "num") return { k: "lit", v: Number(t.v) };
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "lp") { const e = or(); take(")"); return e; }
    if (t.t === "op" && t.v === "!") return { k: "not", e: primary() };
    if (t.t === "id") return t.v === "true" ? { k: "lit", v: true } : t.v === "false" ? { k: "lit", v: false } : t.v === "null" ? { k: "lit", v: null } : { k: "id", name: t.v };
    throw new PredicateError(`unexpected ${t.v}`);
  };
  const cmp = binary(primary, ["==", "!=", ">=", "<=", ">", "<"]);
  const and = binary(cmp, ["&&"]);
  const or = binary(and, ["||"]);
  const e = or();
  if (p !== toks.length) throw new PredicateError(`unexpected ${toks[p]!.v}`);
  return e;
}

export function identifiers(e: Expr, out: string[] = []): string[] {
  if (e.k === "id" && !out.includes(e.name)) out.push(e.name);
  if (e.k === "not") identifiers(e.e, out);
  if (e.k === "bin") { identifiers(e.a, out); identifiers(e.b, out); }
  return out;
}

export const fieldAt = (data: unknown, name: string): unknown =>
  name.split(".").reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), data);

export function evaluate(e: Expr, data: unknown): unknown {
  if (e.k === "lit") return e.v;
  if (e.k === "id") return fieldAt(data, e.name);
  if (e.k === "not") return !evaluate(e.e, data);
  if (e.op === "&&") return Boolean(evaluate(e.a, data)) && Boolean(evaluate(e.b, data));
  if (e.op === "||") return Boolean(evaluate(e.a, data)) || Boolean(evaluate(e.b, data));
  const a = evaluate(e.a, data), b = evaluate(e.b, data);
  if (e.op === "==") return a === b;
  if (e.op === "!=") return a !== b;
  if (typeof a !== "number" || typeof b !== "number") return false;
  return e.op === ">=" ? a >= b : e.op === "<=" ? a <= b : e.op === ">" ? a > b : a < b;
}

export type ClaimPredicate = { pass: Expr; amber: Expr | null; fields: string[]; passFields: string[] };

// A claim predicate is "<pass>" or "<pass> ; amber: <partial>".
export function parseClaimPredicate(src: string): ClaimPredicate {
  const [passSrc, amberSrc, extra] = src.split(/\s*;\s*amber:\s*/);
  if (extra !== undefined || passSrc === undefined) throw new PredicateError("one amber clause at most");
  const pass = parsePredicate(passSrc);
  const amber = amberSrc === undefined ? null : parsePredicate(amberSrc);
  const passFields = identifiers(pass);
  return { pass, amber, passFields, fields: amber ? identifiers(amber, [...passFields]) : passFields };
}

export type ClaimStatus = "green" | "amber" | "red" | "not_measured";

// Green when the pass clause holds, amber when only the partial clause does, red otherwise; a field a deciding clause needs but lacks is not measured.
export function claimStatus(pred: ClaimPredicate, data: unknown): { status: ClaimStatus; missing: string[] } {
  const lacking = (names: readonly string[]) => names.filter((f) => fieldAt(data, f) === undefined);
  const passMissing = lacking(pred.passFields);
  if (passMissing.length) return { status: "not_measured", missing: passMissing };
  if (evaluate(pred.pass, data)) return { status: "green", missing: [] };
  if (!pred.amber) return { status: "red", missing: [] };
  const amberMissing = lacking(identifiers(pred.amber));
  if (amberMissing.length) return { status: "not_measured", missing: amberMissing };
  return { status: evaluate(pred.amber, data) ? "amber" : "red", missing: [] };
}
