import { repoRoot } from "../../../src/lib/paths.js";
import { loadTaskPage } from "../../../src/lib/task-source.js";

export const dynamic = "force-dynamic";

// The step 5 task view as JSON, from serve when it runs and from the committed replay otherwise.
export async function GET(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get("task");
  return Response.json(await loadTaskPage(repoRoot(), { taskId: id }));
}
