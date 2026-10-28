import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EvaluationPage } from "../components/evaluation";
import { StepPage } from "../components/pages";
import { loadClaims, type ClaimsModel } from "../src/lib/claims.js";
import { repoRoot } from "../src/lib/paths.js";
import { loadTaskPage, type TaskPage } from "../src/lib/task-source.js";

export const root = repoRoot();

export async function fixturePage(): Promise<TaskPage> {
  return loadTaskPage(root, { source: "fixture" });
}

export function renderStep(n: number, claims: ClaimsModel, task: TaskPage): string {
  return renderToStaticMarkup(createElement(StepPage, { n, claims, board: null, task }));
}

export function renderEval(tab: string, claims: ClaimsModel, task: TaskPage): string {
  return renderToStaticMarkup(createElement(EvaluationPage, { claims, tabSlug: tab, task }));
}

export { loadClaims };
