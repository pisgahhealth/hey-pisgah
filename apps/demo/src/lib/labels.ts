import { join } from "node:path";
import { readJson } from "./paths.js";

type StepDef = { step_id: string; action_kind: string; document_ref: { document_id: string; stage: string } | null };

export function humanize(s: string): string {
  const t = s.replace(/[_.]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function documentLabel(documentId: string, stage?: string | null): string {
  return stage ? `${humanize(documentId)} ${stage}` : humanize(documentId);
}

// Step labels come from the committed v1 definition, so the board never restates the hospital's process.
export function stepLabels(root: string): Map<string, string> {
  const def = readJson(join(root, "packages", "hospital", "src", "data", "v1.json")) as { steps: StepDef[] };
  return new Map(def.steps.map((s) => [s.step_id, s.document_ref ? documentLabel(s.document_ref.document_id, s.document_ref.stage) : humanize(s.action_kind)]));
}
