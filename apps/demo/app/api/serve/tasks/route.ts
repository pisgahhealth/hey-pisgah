import { DEFAULT_SERVE_URL as SERVE_URL, DEMO_TASK } from "../../../../src/lib/task-source.js";

export const dynamic = "force-dynamic";

// Reads an optional {goal} body; an empty body keeps the recorded goal, and any other field is refused.
async function goalFrom(req: Request | undefined): Promise<string | null> {
  const text = req ? await req.text() : "";
  if (!text.trim()) return DEMO_TASK.goal;
  let b: unknown;
  try { b = JSON.parse(text); } catch { return null; }
  if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => k !== "goal")) return null;
  const g = (b as { goal?: unknown }).goal;
  if (g === undefined) return DEMO_TASK.goal;
  if (typeof g !== "string") return null;
  const goal = g.replace(/\s+/g, " ").trim();
  return goal.length >= 1 && goal.length <= 500 ? goal : null;
}

// Posts the step 5 case to serve with the goal a person typed or spoke; the case and owner stay fixed.
export async function POST(req?: Request): Promise<Response> {
  const goal = await goalFrom(req);
  if (goal === null) return Response.json({ error: "the body may hold only a goal of 1 to 500 characters" }, { status: 400 });
  try {
    const r = await fetch(`${SERVE_URL}/tasks`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...DEMO_TASK, goal }), signal: AbortSignal.timeout(5000), cache: "no-store"
    });
    return Response.json(await r.json(), { status: r.status });
  } catch (e) {
    return Response.json({ error: `serve not reachable at ${SERVE_URL}: ${e instanceof Error ? e.message.slice(0, 120) : "error"}` }, { status: 502 });
  }
}

export async function GET(): Promise<Response> {
  try {
    const r = await fetch(`${SERVE_URL}/tasks`, { signal: AbortSignal.timeout(2000), cache: "no-store" });
    return Response.json(await r.json(), { status: r.status });
  } catch {
    return Response.json({ error: `serve not reachable at ${SERVE_URL}` }, { status: 502 });
  }
}
