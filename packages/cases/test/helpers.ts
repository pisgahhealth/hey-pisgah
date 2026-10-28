import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateCase } from "../src/generate.js";
import { loadPool, type CommittedPool } from "../src/load.js";
import { Manifest, type CaseFile, type Family, type Payer, type Ward } from "../src/types.js";
import type { Checked } from "../src/checks.js";

export const DATA = join(import.meta.dirname, "..", "..", "evaluator", "data");
const POOL_FILE: Record<CommittedPool, string> = { discovery: "discovery", dev: "dev", "dev/held": "dev_held", variation: "variation", demo: "demo" };

export function committed(): { pool: CommittedPool; file: CaseFile; manifest: Manifest }[] {
  const out: { pool: CommittedPool; file: CaseFile; manifest: Manifest }[] = [];
  for (const pool of Object.keys(POOL_FILE) as CommittedPool[]) {
    const manifests = (JSON.parse(readFileSync(join(DATA, "manifests", `${POOL_FILE[pool]}.json`), "utf8")) as unknown[]).map((m) => Manifest.parse(m));
    for (const file of loadPool(pool)) {
      const manifest = manifests.find((m) => m.case_id === file.case_id);
      if (!manifest) throw new Error(`no manifest for ${file.case_id}`);
      out.push({ pool, file, manifest });
    }
  }
  return out;
}
export const asChecked = (rows: { file: CaseFile; manifest: Manifest }[]): Checked[] =>
  rows.map((r) => ({ schedule: r.file.schedule, manifest: r.manifest, texts: { schedule: r.file.schedule, initial_state: r.file.initial_state, infra_fault: r.file.infra_fault, history: r.file.history } }));

// A wider sample than the pools, so the reserved run's draws are covered by the same assertions.
const SAMPLE: [Family, Ward, Payer][] = [
  ["F1", "A", "self_pay"], ["F1", "B", "self_pay"], ["F2", "A", "self_pay"], ["F2", "B", "self_pay"], ["F3", "A", "self_pay"], ["F3", "B", "self_pay"], ["F3", "C", "self_pay"],
  ["F4", "A", "self_pay"], ["F4", "C", "self_pay"], ["F5", "A", "hmo"], ["F5", "B", "hmo"], ["F6", "A", "self_pay"], ["F7", "A", "self_pay"], ["F7", "B", "self_pay"],
  ["F8", "A", "self_pay"], ["F8", "C", "corporate"], ["F9", "A", "self_pay"], ["F9", "B", "self_pay"], ["F10", "A", "self_pay"], ["F12", "A", "self_pay"], ["FV", "B", "self_pay"], ["FV", "B", "hmo"]
];
export function sample(perCell: number): Checked[] {
  const out: Checked[] = [];
  for (const [f, w, p] of SAMPLE) for (let i = 0; i < perCell; i++) {
    const g = generateCase(f, `sample|${f}|${w}|${p}|${i}`, w, p, { overlays: i % 5 === 4 && f !== "FV" && w !== "C" ? ["F11"] : [] });
    out.push({ schedule: g.schedule, manifest: g.manifest, texts: { schedule: g.schedule, initial_state: g.initial_state } });
  }
  return out;
}
