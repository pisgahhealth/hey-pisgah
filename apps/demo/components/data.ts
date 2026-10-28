import { cache } from "react";
import { loadClaims } from "../src/lib/claims.js";
import { repoRoot } from "../src/lib/paths.js";
import { loadTaskPage } from "../src/lib/task-source.js";

// One read per request for each source, shared by every component that renders it.
export const getRoot = cache(() => repoRoot());
export const getClaims = cache(() => loadClaims(getRoot()));
export const getTaskPage = cache((taskId: string | null) => loadTaskPage(getRoot(), { taskId }));
