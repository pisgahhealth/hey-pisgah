import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { KEPT_LEVERS, asrSwitch, earSwitch, leverList, leversFrom, localDirs, percentile, sherpaEmbedder, startEmrServe, type EmrRuntime, type EmrServe, type EmrTaskView, type SpeedRow } from "@hey-pisgah/agent";
import { ModelClient } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";
import { decodeWav } from "@hey-pisgah/voice";
import { PisgahPort } from "../src/port.js";
import { loadProfile } from "../src/profile.js";
import { personCaller } from "../src/journey.sandbox.js";
import { SandboxBlock, mintAgentBearer, mintPersonBearer, sandboxQuery } from "../src/sandbox.js";
import { freshArrival } from "./sandbox-helpers.js";
import { SPEED_LINES } from "./e2s.sandbox.test.js";

// Runs only with SANDBOX=1 and G6=1; G6_PATH is vitals or orders, HEY_PISGAH_EAR and HEY_PISGAH_ASR name the switches, HEY_PISGAH_G6_OUT the result file.
const RUN = process.env["SANDBOX"] === "1" && process.env["G6"] === "1";
const PATH = process.env["G6_PATH"] === "orders" ? "orders" : "vitals";
const EAR = earSwitch(process.env["HEY_PISGAH_EAR"]);
const ASR = asrSwitch(process.env["HEY_PISGAH_ASR"]);
// Both streaming ears hear frames in real time; G6_TRANSPORT=chunks sends the strip's chunks instead.
const TRANSPORT = ASR !== "rest" && process.env["G6_TRANSPORT"] !== "chunks" ? "frames" : "chunks";
// Each run's arrival carries this label, and G6_RUN picks the wording so no two runs send the same owner line within the hospital's ten-minute window.
const LABEL = process.env["G6_LABEL"] ?? "E2 Child";
const RUN_NO = Number(process.env["G6_RUN"] ?? 0);
// D17's release is off in this harness unless HEY_PISGAH_RELEASE_WHOLE=1, so each row says which it measured.
const RELEASE = process.env["HEY_PISGAH_RELEASE_WHOLE"] === "1";
const RATE = 24_000;
const ORDER_WORDS = [
  ["Send a full blood count, stat.", "Send a malaria parasite test.", "Send a urinalysis."],
  ["Please send a full blood count now.", "Add a malaria parasite test as well.", "And a urinalysis, please."],
  ["Let's get a full blood count, urgently.", "Check for malaria parasites too.", "I'd like a urinalysis on him."],
  ["Full blood count for him straight away.", "A malaria parasite test, please.", "Urinalysis as well."],
  ["I want a full blood count done now.", "Run a malaria parasite test for him.", "Send off a urinalysis too."],
  ["Get me a full blood count quickly.", "Let's add a malaria parasite test.", "He needs a urinalysis."],
  ["Order a full blood count for him now.", "Malaria parasite test, please.", "Do a urinalysis for him."],
  ["A full blood count, right away please.", "Test him for malaria parasites.", "Let's send a urinalysis."],
  ["Full blood count, please, now.", "Send for a malaria parasite test.", "Urinalysis for him, please."],
  ["We need a full blood count now.", "And a malaria parasite test.", "A urinalysis, please, today."]
];
const ORDER_LINES = ORDER_WORDS[RUN_NO % ORDER_WORDS.length]!.map((text, i) => ({ text, test: ["full blood count", "malaria", "urinalysis"][i]! }));
const PARTS = ["heard", "asr", "delivered", "gate_start", "gate_end", "ear_done", "proposed", "hold_until", "written", "verified", "verify_ms"] as const;

const speak = (text: string, file: string, voice?: string): Uint8Array => {
  execFileSync("say", [...(voice ? ["-v", voice] : []), "-o", file, "--file-format=WAVE", `--data-format=LEI16@${RATE}`, `${text} [[slnc 900]]`], { stdio: "ignore", timeout: 30_000 });
  return new Uint8Array(readFileSync(file));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One listening session in the chosen transport: chunks posted as the strip posts them, or one request carrying frames at the pace they are spoken.
function listener(s: EmrServe, owner: string, patient: string, session: string, root: string) {
  let seq = 0;
  if (TRANSPORT === "chunks") {
    return {
      line: async (wav: Uint8Array, gapMs: number) => {
        const form = new FormData();
        form.append("audio", new Blob([Buffer.from(wav)], { type: "audio/wav" }), `l${seq}.wav`);
        form.append("owner", owner); form.append("patientId", patient); form.append("session_id", session); form.append("seq", String(seq++));
        const res = await fetch(`${s.url}/tasks/listen?wait=1`, { method: "POST", body: form });
        expect(res.status).toBe(202);
        await sleep(gapMs);
      },
      end: async () => { await s.listening.flush(session); return null; }
    };
  }
  // Frames of 20 ms go out on the clock they were spoken on, so the streaming ear meets the timing a microphone gives it.
  const frame = (RATE * 20) / 1000;
  const queue: Buffer[] = [];
  let done = false;
  const pcm = (samples: Float32Array) => { const b = Buffer.alloc(samples.length * 2); for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767))), i * 2); return b; };
  const t0 = Date.now();
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      while (!queue.length && !done) await sleep(5);
      const next = queue.shift();
      if (!next) { c.close(); return; }
      const due = t0 + (sent / RATE) * 1000;
      if (due > Date.now()) await sleep(due - Date.now());
      sent += next.length / 2;
      c.enqueue(new Uint8Array(next));
    }
  });
  const reply = fetch(`${s.url}/tasks/listen/stream?owner=${owner}&patientId=${patient}&session_id=${session}&rate=${RATE}`, { method: "POST", headers: { "content-type": "audio/pcm" }, body, duplex: "half" } as RequestInit);
  const push = (samples: Float32Array) => { for (let i = 0; i < samples.length; i += frame) queue.push(pcm(samples.subarray(i, i + frame))); };
  const waitSent = async () => { while (queue.length) await sleep(10); };
  push(new Float32Array(RATE));
  return {
    line: async (wav: Uint8Array, gapMs: number) => { push(decodeWav(wav).samples); push(new Float32Array(Math.round((RATE * gapMs) / 1000))); await waitSent(); void root; },
    end: async () => { done = true; const r = await reply; const b = (await r.json()) as unknown; expect(r.status, JSON.stringify(b).slice(0, 400)).toBe(202); return b; }
  };
}

function setup(profile: ReturnType<typeof loadProfile>, sb: SandboxBlock) {
  const mine = mintAgentBearer(sb);
  const port = new PisgahPort(profile, { bearers: { [mine.owner]: mine.bearer } });
  const root = mkdtempSync(join(tmpdir(), "hp-g6-"));
  return { mine, port, root };
}

async function serve(root: string, port: PisgahPort, withSpeaker: boolean) {
  let rt: EmrRuntime | null = null;
  const client = new ModelClient({ storeRoot: root, mode: "live", recordingsDir: join(root, "recordings"), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  const embed = withSpeaker ? sherpaEmbedder({ modelPath: process.env["HEY_PISGAH_SPEAKER_MODEL"] ?? "", sherpaDir: process.env["HEY_PISGAH_SHERPA_DIR"] }) : null;
  if (withSpeaker) expect(embed).not.toBeNull();
  const levers = leversFrom(process.env["HEY_PISGAH_SPEED"] ?? KEPT_LEVERS);
  const s = await startEmrServe({
    storeRoot: root, port, client, listenPort: Number(process.env["HEY_PISGAH_EMR_PORT"] ?? 4121), ears: EAR, asr: ASR,
    local: { ...localDirs(process.env["HEY_PISGAH_ASR_DIR"] ?? join(process.cwd(), ".hey-pisgah", "asr")), sherpaDir: process.env["HEY_PISGAH_SHERPA_DIR"] },
    ...(embed ? { embed } : {}), ...(RELEASE ? { releaseWhole: true } : {}), runtime: { holdMs: 4000, proofRetryMs: 1500, speed: levers, keepHeard: true }
  });
  rt = s.runtime;
  return { s, client, levers };
}

// Every row on the run's ledgers: model calls and the readings that are not model calls, each with its model and purpose.
function ledgerOf(root: string): Record<string, unknown>[] {
  return readdirSync(join(root, "ledger")).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readStream(root, `ledger/${f.replace(/\.jsonl$/, "")}`))
    .filter((e) => e.record_type === "model.call" || e.record_type === "reading.call").map((e) => {
      const x = e.payload as Record<string, unknown>;
      return { kind: e.record_type, provider: x["provider"], model: x["model"], purpose: x["purpose"], ms: x["latency_ms"], usd: x["cost_usd"], error: x["error"] ?? null, effort: x["effort"] ?? null };
    });
}

// Who read and decided each written value: the first ear, the model that chose the action, and every reading that had to agree.
function footprint(v: EmrTaskView, root: string, firstEar: string): Record<string, unknown> {
  const compared = readStream(root, `emr/${v.task_id}`).filter((e) => e.record_type === "ears.compared").map((e) => e.payload as Record<string, unknown>);
  const readings = compared.map((c) => (c["readings"] as { provider: string; model: string }[] | undefined)?.map((r) => `${r.provider}:${r.model}`) ?? [`${c["provider"]}:${c["model"]}`]);
  const gates = [...new Set(ledgerOf(root).filter((r) => r["kind"] === "model.call" && String(r["purpose"]).startsWith("emr.gate")).map((r) => `${r["provider"]}:${r["model"]}`))];
  return { first_ear: firstEar, decided_by: gates, number_readings: [...new Set(readings.map((r) => r.join(" + ")))], meta_models_per_number: readings.map((r) => [...gates, ...(firstEar.startsWith("meta") ? [firstEar] : []), ...r.filter((x) => x.startsWith("meta") || x.startsWith("modal"))].length) };
}

describe.skipIf(!RUN)("G6 local ears on the sandbox EMR", () => {
  it.skipIf(PATH !== "vitals")("times the eight vitals lines with the chosen ears, every value read back from the record", async () => {
    const spacing = Number(process.env["HEY_PISGAH_E2_SPACING_MS"] ?? 2500);
    const profile = loadProfile();
    const { patient, sb } = await freshArrival(profile, LABEL);
    const { mine, port, root } = setup(profile, sb);
    const { s, client, levers } = await serve(root, port, false);
    const out: Record<string, unknown> = { path: "vitals", harness: 2, label: LABEL, ear: EAR, asr: ASR, release_whole: RELEASE, transport: TRANSPORT, levers: leverList(levers), spacing_ms: spacing, hold_ms: 4000, started_at: new Date().toISOString(), load_start: loadavg(), synthetic: true };
    try {
      const r = await fetch(`${s.url}/tasks/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: mine.owner, patientId: patient, text: "Admit him as an emergency to the children's ward for abdominal pain." }) });
      expect(r.status).toBe(202);
      const taskId = ((await r.json()) as { task_id: string }).task_id;
      await s.runtime.settled(5 * 60_000);
      const admission = s.runtime.view(taskId)!.admission_id;
      expect(admission).toMatch(/^[0-9a-f-]{36}$/);
      const before = s.runtime.view(taskId)!.speed.rows.length;
      const session = `g6-${taskId}`.slice(0, 60);
      // Every clip is rendered before the first is sent, since rendering blocks this process and would stall the serve under measure.
      const clips = SPEED_LINES.map((line, seq) => speak(line.text, join(root, `v${seq}.wav`)));
      const ear = listener(s, mine.owner, patient, session, root);
      const t0 = Date.now();
      for (const clip of clips) await ear.line(clip, spacing);
      out["stream_reply"] = await ear.end();
      await s.runtime.settled(8 * 60_000);
      const v = s.runtime.view(taskId)!;
      const rows = v.speed.rows.slice(before).filter((x) => x.kind === "record_observation") as SpeedRow[];
      const acts = v.actions.filter((x) => x.kind === "record_observation");
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
      // A line said but not written is an error of this run: asked back, refused, or lost.
      const missing = SPEED_LINES.length - valueRows.filter((x) => x.right).length;
      const health = (await (await fetch(`${s.url}/health`)).json()) as Record<string, unknown>;
      Object.assign(out, {
        n: rows.length, p50_ms: percentile(ms, 50), p90_ms: percentile(ms, 90), max_ms: ms.length ? Math.max(...ms) : null, wall_ms: Date.now() - t0, lines_not_written: missing,
        parts_p50: Object.fromEntries(PARTS.map((k) => [k, med(k)])), errors: v.speed.errors, speed_corrections: v.speed.corrections, released_rows: rows.filter((x) => x.released).length,
        values: { acted: valueRows.length, wrong: valueRows.filter((x) => !x.right).length, rows: valueRows, db_checked: dbChecked.length, db_found: dbChecked.filter(Boolean).length },
        heard: v.transcript.slice(1).map((x) => ({ text: x.text, classes: x.classes, finished_by: x.ambient?.finished_by ?? null })),
        ears: v.ears, questions: v.asked.slice(-8).map((q) => q.text), actions: acts.map((x) => ({ state: x.state, args: x.args, reason: x.reason })), usd: v.usd, calls: v.calls,
        footprint: footprint(v, root, String((health["ears"] as Record<string, unknown>)["first_ear"])), health_ears: health["ears"], ledger: ledgerOf(root), rows, load_end: loadavg()
      });
      expect(valueRows.filter((x) => !x.right)).toEqual([]);
      expect(dbChecked.every(Boolean)).toBe(true);
    } finally {
      const file = process.env["HEY_PISGAH_G6_OUT"];
      if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`); }
      await s.close();
      client.close();
    }
  }, 30 * 60_000);

  it.skipIf(PATH !== "orders")("times owner lab orders on an emergency arrival from the end of the line to the lab board", async () => {
    const profile = loadProfile();
    const sb = SandboxBlock.parse(profile.sandbox);
    const person = personCaller(profile, sb, new Map(), []);
    const em = await person("unnamed_arrival", { ref: `${LABEL.replace(/\s+/g, "-")}-${Date.now().toString(36)}` });
    expect(em.ok, JSON.stringify(em)).toBe(true);
    const emVisit = String((em.json as { visitId: string }).visitId), emPatient = String((em.json as { id: string }).id);
    const { mine, port, root } = setup(profile, sb);
    const { s, client, levers } = await serve(root, port, true);
    const labBearer = mintPersonBearer(sb, { login: "lab.grace" });
    const seen = new Map<string, number>();
    let polling = true;
    const poll = async () => {
      while (polling) {
        try {
          const r = await fetch(`${profile.base_url}/lab/queue`, { headers: { authorization: `Bearer ${labBearer}`, accept: "application/json" } });
          const at = Date.now();
          for (const id of (await r.text()).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []) if (!seen.has(id)) seen.set(id, at);
        } catch { /* a dropped poll is tried again */ }
        await sleep(300);
      }
    };
    const poller = poll();
    await sleep(1500);
    const before = new Set(seen.keys());
    const out: Record<string, unknown> = { path: "orders", harness: 2, label: LABEL, run_no: RUN_NO, order_lines: ORDER_LINES.map((l) => l.text), ear: EAR, asr: ASR, release_whole: RELEASE, transport: TRANSPORT, levers: leverList(levers), hold_ms: 4000, voice: "Rishi", started_at: new Date().toISOString(), load_start: loadavg(), synthetic: true };
    try {
      const gap = Number(process.env["G6_ORDER_GAP_MS"] ?? 10_000);
      const session = `g6o-${emVisit.slice(0, 8)}`;
      const clips = ORDER_LINES.map((l, i) => speak(l.text, join(root, `o${i}.wav`), "Rishi"));
      const ear = listener(s, mine.owner, emPatient, session, root);
      for (const clip of clips) await ear.line(clip, gap);
      out["stream_reply"] = await ear.end();
      await s.runtime.settled(8 * 60_000);
      await sleep(3000);
      const views = s.runtime.views(mine.owner) as EmrTaskView[];
      const states = sandboxQuery(sb, "order_states_for_visit", { visit: emVisit });
      const rows: Record<string, unknown>[] = [];
      for (const v of views) {
        const lineEnd = new Map(v.transcript.map((l) => [l.id, Date.parse(l.ambient?.ended_at ?? l.at)]));
        for (const a of v.actions.filter((x) => x.kind === "order_test")) {
          const st = states.find((x) => x["id"] === a.proof?.record_id);
          const boardId = String(st?.["diagnostic_order_id"] ?? "");
          const at = boardId && !before.has(boardId) ? seen.get(boardId) ?? null : null;
          const from = lineEnd.get(a.line_id) ?? null;
          const sr = v.speed.rows.find((x) => x.action_id === a.action_id);
          // The decision is the step the ears change: from the end of the line to the order proposed, whether the voice match then sends or holds it.
          rows.push({ state: a.state, summary: a.summary, reason: a.reason, line: v.transcript.find((l) => l.id === a.line_id)?.text ?? "", speaker: v.transcript.find((l) => l.id === a.line_id)?.speaker?.speaker ?? null,
            decided_ms: from !== null ? Date.parse(a.proposed_at) - from : null, verified_ms: sr?.ms ?? null, board_ms: at !== null && from !== null ? at - from : null, parts: sr?.parts ?? null });
        }
      }
      const boardMs = rows.map((r) => r["board_ms"]).filter((x): x is number => typeof x === "number");
      const decidedMs = rows.map((r) => r["decided_ms"]).filter((x): x is number => typeof x === "number");
      const verifiedMs = rows.map((r) => r["verified_ms"]).filter((x): x is number => typeof x === "number");
      const health = (await (await fetch(`${s.url}/health`)).json()) as Record<string, unknown>;
      Object.assign(out, {
        n: verifiedMs.length, p50_ms: percentile(verifiedMs, 50), p90_ms: percentile(verifiedMs, 90), decided: { n: decidedMs.length, p50_ms: percentile(decidedMs, 50), p90_ms: percentile(decidedMs, 90), ms: decidedMs },
        lines_not_decided: ORDER_LINES.length - rows.filter((r) => /fbc|malaria|urinalysis/.test(String(r["summary"]))).length, board: { n: boardMs.length, p50_ms: percentile(boardMs, 50), p90_ms: percentile(boardMs, 90) },
        lines_not_ordered: ORDER_LINES.length - rows.filter((r) => r["state"] === "completed").length, rows,
        heard: views.flatMap((v) => v.transcript.map((x) => ({ text: x.text, classes: x.classes, speaker: x.speaker?.speaker ?? null, finished_by: x.ambient?.finished_by ?? null }))),
        errors: views.map((v) => v.speed.errors), questions: views.flatMap((v) => v.asked.map((q) => q.text)).slice(-8), notes: views.flatMap((v) => v.notes.map((n) => n.text)).slice(-10),
        usd: views.reduce((n, v) => n + v.usd, 0), calls: views.reduce((n, v) => n + v.calls, 0), health_ears: health["ears"], ledger: ledgerOf(root), load_end: loadavg()
      });
      expect(rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      polling = false;
      await poller;
      const file = process.env["HEY_PISGAH_G6_OUT"];
      if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`); }
      await s.close();
      client.close();
    }
  }, 30 * 60_000);
});
