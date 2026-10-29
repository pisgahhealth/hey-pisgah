import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { leverList, leversFrom, percentile, startEmrServe, type EmrRuntime, type SpeedRow } from "@hey-pisgah/agent";
import { ModelClient, ledgerRowsIn } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { PisgahPort } from "../src/port.js";
import { loadProfile } from "../src/profile.js";
import { mintAgentBearer, sandboxQuery } from "../src/sandbox.js";
import { freshArrival } from "./sandbox-helpers.js";

// Runs only with SANDBOX=1 and E2S=1; HEY_PISGAH_SPEED names the levers ("none", "1,2" or "all") and HEY_PISGAH_E2S_OUT the result file.
const RUN = process.env["SANDBOX"] === "1" && process.env["E2S"] === "1";
// The eight lines E2 timed, with the values each must write.
export const SPEED_LINES: { text: string; values: Record<string, string> }[] = [
  { text: "Chart his pulse 116.", values: { pulse: "116" } }, { text: "Chart his temperature 38.3.", values: { temp_c: "38.3" } },
  { text: "Chart his respiratory rate 24.", values: { resp_rate: "24" } }, { text: "Chart his blood pressure 104 over 62.", values: { bp: "104/62" } },
  { text: "Chart his pulse 112.", values: { pulse: "112" } }, { text: "Chart his temperature 37.9.", values: { temp_c: "37.9" } },
  { text: "Chart his respiratory rate 22.", values: { resp_rate: "22" } }, { text: "Chart his pulse 108.", values: { pulse: "108" } }
];
const PARTS = ["heard", "asr", "delivered", "gate_start", "gate_end", "ear_done", "proposed", "hold_until", "written", "verified", "verify_ms"] as const;

describe.skipIf(!RUN)("E2.s vitals path speed on the sandbox EMR", () => {
  it("times the eight vitals lines from the end of each line to the verified record, with the readings agreeing and every value written as said", async () => {
    const levers = leversFrom(process.env["HEY_PISGAH_SPEED"]);
    const spacing = Number(process.env["HEY_PISGAH_E2_SPACING_MS"] ?? 2500);
    const profile = loadProfile();
    const { patient, sb } = await freshArrival(profile);
    const mine = mintAgentBearer(sb);
    const port = new PisgahPort(profile, { bearers: { [mine.owner]: mine.bearer } });
    const root = mkdtempSync(join(tmpdir(), "hp-e2s-"));
    let rt: EmrRuntime | null = null;
    const client = new ModelClient({ storeRoot: root, mode: "live", recordingsDir: join(root, "recordings"), taskStateOf: (id) => rt?.stateOf(id) ?? null });
    const s = await startEmrServe({ storeRoot: root, port, client, listenPort: Number(process.env["HEY_PISGAH_EMR_PORT"] ?? 4112), ears: "spark", runtime: { holdMs: 4000, proofRetryMs: 1500, speed: levers } });
    rt = s.runtime;
    const out: Record<string, unknown> = { levers: leverList(levers), spacing_ms: spacing, hold_ms: 4000, started_at: new Date().toISOString() };
    try {
      // The admission comes first by voice, as in E2, so the vitals go to the ward record on the clerking owner's task.
      const r = await fetch(`${s.url}/tasks/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: mine.owner, patientId: patient, text: "Admit him as an emergency to the children's ward for abdominal pain." }) });
      expect(r.status).toBe(202);
      const taskId = ((await r.json()) as { task_id: string }).task_id;
      await s.runtime.settled(5 * 60_000);
      const admission = s.runtime.view(taskId)!.admission_id;
      expect(admission).toMatch(/^[0-9a-f-]{36}$/);
      const before = s.runtime.view(taskId)!.speed.rows.length;
      const t0 = Date.now();
      for (const [seq, line] of SPEED_LINES.entries()) {
        const wav = join(root, `v${seq}.wav`);
        execFileSync("say", ["-o", wav, "--file-format=WAVE", "--data-format=LEI16@24000", `${line.text} [[slnc 900]]`], { stdio: "ignore", timeout: 30_000 });
        const form = new FormData();
        form.append("audio", new Blob([readFileSync(wav)], { type: "audio/wav" }), `v${seq}.wav`);
        form.append("owner", mine.owner); form.append("patientId", patient); form.append("session_id", `e2s-${taskId}`); form.append("seq", String(seq));
        const res = await fetch(`${s.url}/tasks/listen?wait=1`, { method: "POST", body: form });
        expect(res.status).toBe(202);
        await new Promise((x) => setTimeout(x, spacing));
      }
      await s.listening.flush(`e2s-${taskId}`);
      await s.runtime.settled(8 * 60_000);
      const v = s.runtime.view(taskId)!;
      const rows = v.speed.rows.slice(before).filter((x) => x.kind === "record_observation") as SpeedRow[];
      const acts = v.actions.filter((x) => x.kind === "record_observation");
      // Every written value must be the one said in its line, read back from the record itself.
      const lineText = new Map(v.transcript.map((x) => [x.id, x.text]));
      const expected = (lineId: string) => SPEED_LINES.find((l) => lineText.get(lineId)?.includes(l.text.split(" ").slice(-1)[0]!.replace(/\.$/, "")))?.values ?? null;
      const valueRows = acts.filter((a) => a.state === "completed").map((a) => {
        const want = expected(a.line_id);
        const got = Object.fromEntries(Object.entries(a.args).filter(([k]) => ["pulse", "temp_c", "resp_rate", "bp"].includes(k)).map(([k, x]) => [k, String(x)]));
        return { line: lineText.get(a.line_id) ?? "", want, got, right: !!want && JSON.stringify(got) === JSON.stringify(want) };
      });
      const db = sandboxQuery(sb, "observations_for", { admission });
      const inDb = (k: string, x: string) => db.some((o) => o["recorded_by"] === mine.agent && String(o[k] ?? "") !== "" && Number(o[k]) === Number(x));
      const dbChecked = valueRows.flatMap((x) => Object.entries(x.got).filter(([k]) => k !== "bp").map(([k, val]) => inDb(k, val)));
      const ms = rows.map((x) => x.ms);
      const med = (k: string) => percentile(rows.map((x) => x.parts[k]).filter((y): y is number => typeof y === "number"), 50);
      Object.assign(out, {
        n: rows.length, p50_ms: percentile(ms, 50), p90_ms: percentile(ms, 90), max_ms: Math.max(...ms), wall_ms: Date.now() - t0,
        parts_p50: Object.fromEntries(PARTS.map((k) => [k, med(k)])), gate_stages: rows.map((x) => x.gate ?? null),
        errors: v.speed.errors, values: { acted: valueRows.length, wrong: valueRows.filter((x) => !x.right).length, rows: valueRows, db_checked: dbChecked.length, db_found: dbChecked.filter(Boolean).length },
        calls_by_line: readStream(root, `emr/${taskId}`).filter((e) => e.record_type === "gate.decided").map((e) => { const x = e.payload as Record<string, unknown>; return { line: lineText.get(String(x["line_id"])) ?? "", stage: x["stage"] ?? "full", first_look: x["first_look"] ?? null, stage_ms: x["stage_ms"] ?? null, early: !!x["started_early"] }; }),
        ledger: readdirSync(join(root, "ledger")).flatMap((f) => ledgerRowsIn(join(root, "ledger", f))).map((x) => ({ purpose: x.purpose, ms: x.latency_ms, prompt: x.prompt_tokens, completion: x.completion_tokens, reasoning: x.reasoning_tokens, usd: x.cost_usd })),
        refusals: v.refusals.map((x) => x.asked_for), classes: v.transcript.slice(1).map((x) => x.classes.join("+")), ears: v.ears, questions: v.asked.slice(-8).map((q) => q.text), actions: acts.map((x) => ({ state: x.state, args: x.args, reason: x.reason })), usd: v.usd, calls: v.calls, rows
      });
      expect(rows.length).toBeGreaterThanOrEqual(6);
      expect(valueRows.filter((x) => !x.right)).toEqual([]);
      expect(dbChecked.every(Boolean)).toBe(true);
      expect(v.ears.compared).toBe(v.ears.agreed + acts.filter((a) => a.reason === "readings_differ").length);
    } finally {
      const file = process.env["HEY_PISGAH_E2S_OUT"];
      if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`); }
      await s.close();
      client.close();
    }
  }, 30 * 60_000);
});
