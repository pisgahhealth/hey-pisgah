import { readFileSync, writeFileSync } from "node:fs";
import { loadTalk } from "./talk.js";
import { scoreAmbient, type AmbientRun } from "./score.js";

export type ValuesRun = { run: string; mode: string; values_acted: number; value_errors: number; questions: number; ears_compared: number | null; ears_agreed: number | null };

// C-19 over every kept labelled run: vitals values written, how many were wrong, and the questions asked beside them.
export function valuesAcrossRuns(runs: readonly { run: string; live: AmbientRun }[], now: () => Date = () => new Date()) {
  const talk = loadTalk();
  const rows: ValuesRun[] = runs.map(({ run, live }) => {
    const s = scoreAmbient(talk, live);
    return { run, mode: live.mode, values_acted: s.values_acted, value_errors: s.value_errors, questions: s.questions_asked, ears_compared: s.ears_compared, ears_agreed: s.ears_agreed };
  });
  const sum = (k: "values_acted" | "value_errors" | "questions") => rows.reduce((n, r) => n + r[k], 0);
  const eared = rows.filter((r) => r.ears_compared !== null);
  const compared = eared.reduce((n, r) => n + (r.ears_compared ?? 0), 0);
  const agreed = eared.reduce((n, r) => n + (r.ears_agreed ?? 0), 0);
  const acted = sum("values_acted");
  return {
    measured_at: now().toISOString(), measured: true, talk_id: talk.talk_id, runs: rows.length,
    values_acted: acted, value_errors: sum("value_errors"), value_error_rate: acted ? Math.round((sum("value_errors") / acted) * 1e6) / 1e6 : null, questions: sum("questions"),
    runs_with_two_readings: eared.length, ears_compared: compared, ears_agreed: agreed, agreement_rate: compared ? Math.round((agreed / compared) * 1e4) / 1e4 : null,
    by_run: rows
  };
}
export type ValuesResult = ReturnType<typeof valuesAcrossRuns>;

// Usage: values.ts --out <file> <name>=<run.live.json> ...
if (process.argv[1]?.endsWith("values.ts")) {
  const i = process.argv.indexOf("--out");
  const out = process.argv[i + 1];
  const runs = process.argv.slice(2).filter((a, j) => a.includes("=") && j + 2 !== i + 1).map((a) => { const [run, file] = a.split("="); return { run: run!, live: JSON.parse(readFileSync(file!, "utf8")) as AmbientRun }; });
  const r = valuesAcrossRuns(runs);
  if (out && i > 0) writeFileSync(out, `${JSON.stringify(r, null, 1)}\n`);
  console.log(JSON.stringify({ runs: r.runs, values_acted: r.values_acted, value_errors: r.value_errors, questions: r.questions, agreement_rate: r.agreement_rate }));
}
