import { readFileSync, writeFileSync } from "node:fs";
import { HINT_CONDITIONS, PATIENT_NAMES, STAFF_NAMES, WARD_DRUGS, hintLines, scoreCondition, type HintRow } from "./hints.score.js";

// Publishes evaluation/results/transcribe-hints.json: word error, values right, and name and drug recall per hint condition, pooled and per run.
const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const calls = arg("calls"), out = arg("out", "evaluation/results/transcribe-hints.json");
const rows = readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l) as HintRow & { attempt: number; status: number | null; error: string | null });
// A retried call keeps only its last attempt.
const last = new Map<string, (typeof rows)[number]>();
for (const r of rows) last.set(`${r.cond}|${r.run}|${r.clip}`, r);
const kept = [...last.values()];
const lines = hintLines();
const runs = [...new Set(kept.map((r) => r.run))].sort();
const conditions = HINT_CONDITIONS.map((c) => {
  const mine = kept.filter((r) => r.cond === c.id);
  return {
    id: c.id, label: c.label, keywords: c.hints === null ? "none" : c.hints.length ? "vitals words, then patient and staff names and the ward drug list" : "vitals words only", language_bias: c.bias,
    all: scoreCondition(mine, lines), r1b: scoreCondition(mine, lines.filter((l) => l.source === "r1b")), v2: scoreCondition(mine, lines.filter((l) => l.source === "v2")),
    per_run: runs.map((run) => ({ run, ...scoreCondition(mine.filter((r) => r.run === run), lines) }))
  };
});
writeFileSync(out, `${JSON.stringify({
  generated_by: "packages/voice/research/hints.publish.run.ts", model: "muse-voice-transcribe-1.0", endpoint: "REST PUSH_TO_TALK",
  lines: { total: lines.length, r1b: lines.filter((l) => l.source === "r1b").length, v2: lines.filter((l) => l.source === "v2").length, with_names: lines.filter((l) => l.names.length).map((l) => l.clip), with_drugs: lines.filter((l) => l.drugs.length).map((l) => l.clip) },
  reference: "R1.b: the words said as reconstructed in real-set.json; v2: the script words (lines whose words changed are kept, which raises word error alike in every condition)",
  hints: { patients: PATIENT_NAMES, staff: STAFF_NAMES, ward_drugs: WARD_DRUGS },
  runs: runs.length, voided_429: rows.filter((r) => r.voided).length, failed: kept.filter((r) => r.raw === null).map((r) => ({ cond: r.cond, run: r.run, clip: r.clip, status: r.status })),
  cost_usd: Math.round(kept.reduce((n, r) => n + r.cost_usd, 0) * 1e6) / 1e6, conditions
}, null, 1)}\n`);
for (const c of conditions) process.stderr.write(`${c.id}: wer ${c.all.wer} values ${c.all.values.right}/${c.all.values.said} names ${c.all.names.heard}/${c.all.names.said} drugs ${c.all.drugs.heard}/${c.all.drugs.said}\n`);
