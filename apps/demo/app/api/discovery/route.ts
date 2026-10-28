import { loadWardBoard } from "../../../src/lib/discovery.js";
import { repoRoot } from "../../../src/lib/paths.js";

export const dynamic = "force-dynamic";

// The ward board as JSON, read from the committed discovery fixtures.
export function GET(): Response {
  return Response.json(loadWardBoard(repoRoot()));
}
