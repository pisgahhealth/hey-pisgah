import { DEFAULT_SERVE_URL as SERVE_URL, DEMO_TASK } from "../../../../src/lib/task-source.js";

export const dynamic = "force-dynamic";

// Posts only the step 5 demo task to serve; the app forwards no other body, so it cannot drive serve elsewhere.
export async function POST(): Promise<Response> {
  try {
    const r = await fetch(`${SERVE_URL}/tasks`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(DEMO_TASK), signal: AbortSignal.timeout(5000), cache: "no-store"
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
