import type { z } from "zod";
import { ModelError } from "./errors.js";
import { ROUTES } from "./routes.js";
import type { CallArgs, CallResult, ChatCompletion, ChatMessage, ModelClient } from "./client.js";

export type StructuredResult<T> = { value: T; repairs: number; enforced_by: string | null; result: CallResult; source: "tool_call" | "content" };

type Candidate = { ok: true; json: unknown; source: "tool_call" | "content"; toolCallId: string | null } | { ok: false; error: string; source: "tool_call" | "content"; toolCallId: string | null };

// Takes the first tool call's arguments, else the message content, and parses it as JSON.
export function extractCandidate(c: ChatCompletion, toolName?: string): Candidate {
  const msg = c.choices[0]?.message;
  const call = msg?.tool_calls?.find((t) => t.type === "function");
  if (call && call.type === "function") {
    if (toolName && call.function.name !== toolName) return { ok: false, error: `called ${call.function.name}, expected ${toolName}`, source: "tool_call", toolCallId: call.id };
    try {
      return { ok: true, json: JSON.parse(call.function.arguments || "{}"), source: "tool_call", toolCallId: call.id };
    } catch (e) {
      return { ok: false, error: `arguments are not valid JSON: ${(e as Error).message}`, source: "tool_call", toolCallId: call.id };
    }
  }
  const text = (msg?.content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return { ok: true, json: JSON.parse(text), source: "content", toolCallId: null };
  } catch (e) {
    return { ok: false, error: `content is not valid JSON: ${(e as Error).message}`, source: "content", toolCallId: null };
  }
}

export function formatIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `- at $${i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("")}: ${i.message}`).join("\n");
}

// Validates with zod on every route, feeds the error paths back for at most maxRepairs turns, then fails closed.
export async function callStructured<S extends z.ZodType>(client: ModelClient, schema: S, args: CallArgs, opts: { maxRepairs?: number; toolName?: string } = {}): Promise<StructuredResult<z.infer<S>>> {
  const maxRepairs = opts.maxRepairs ?? 2;
  const enforced = ROUTES[args.provider].schemaEnforcement;
  const enforced_by = enforced === "none" ? null : args.provider;
  const messages: ChatMessage[] = [...args.messages];
  let lastError = "";
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const result = await client.call({ ...args, messages: [...messages], repairs: attempt });
    const cand = extractCandidate(result.completion, opts.toolName);
    let error: string;
    if (cand.ok) {
      const parsed = schema.safeParse(cand.json);
      if (parsed.success) {
        client.appendRecord(args.run_id, "model.structured", { purpose: args.purpose, provider: args.provider, ok: true, repairs: attempt, enforced_by, source: cand.source, response_id: result.row.response_id });
        return { value: parsed.data, repairs: attempt, enforced_by, result, source: cand.source };
      }
      error = formatIssues(parsed.error.issues);
    } else {
      error = `- ${cand.error}`;
    }
    lastError = error;
    if (attempt === maxRepairs) break;
    const reply = result.completion.choices[0]?.message;
    const text = `Your reply failed validation. Fix these and reply again with the corrected JSON only.\n${error}`;
    if (reply) messages.push(reply as ChatMessage);
    if (cand.toolCallId) messages.push({ role: "tool", tool_call_id: cand.toolCallId, content: text });
    else messages.push({ role: "user", content: text });
  }
  client.appendRecord(args.run_id, "model.structured", { purpose: args.purpose, provider: args.provider, ok: false, repairs: maxRepairs, enforced_by, last_error: lastError.slice(0, 2000) });
  throw new ModelError("structured_invalid", "no valid reply after the repair turns", { repairs: maxRepairs, last_error: lastError });
}
