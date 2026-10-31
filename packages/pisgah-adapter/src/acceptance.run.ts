import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { createServer, request as httpRequest } from "node:http";
import type { EmrTaskView } from "@hey-pisgah/agent";
import { decodeWav, encodeWav, parseWav } from "@hey-pisgah/voice";
import { loadProfile } from "./profile.js";
import { personCaller } from "./journey.sandbox.js";
import type { DoorLog } from "./port.js";
import { SandboxBlock, mintPersonCookie, sandboxQuery } from "./sandbox.js";
import { FAKE_OWNERS } from "./acceptance.fake.js";
import { bindLine, completion, didBy, fakeRealign, loadScript, speedTable, stepStatus, writeAccResults, type AccResult, type CheckOutcome, type DelegationRow, type Expect, type Fault, type Line, type SpeakerRow, type SpeedErr, type SpeedRowIn, type StepOutcome, type Who } from "./acceptance.js";

// Runs the acceptance script against a serve on the loopback sandbox: says or plays each line, waits for the record after it, injects the faults, and writes the result files.
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`set ${k}`); return v; };
const DRIVER = env("ACC_DRIVER", "say") as "human" | "say" | "post" | "text" | "fake";
const KIND = env("ACC_KIND", "rehearsal") as "rehearsal" | "final";
const BROWSER = env("ACC_BROWSER", DRIVER === "say" || DRIVER === "human" || DRIVER === "fake" ? "launch" : "none") as "launch" | "none";
const SERVE_PORT = Number(env("ACC_SERVE_PORT", "4131"));
const SERVE = `http://127.0.0.1:${SERVE_PORT}`;
const OUT = env("ACC_OUT");
// sandbox: the loopback EMR with read-only queries and person steps on its door; memory: the in-memory hospital the harness tests itself against.
const HOSPITAL = env("ACC_HOSPITAL", "sandbox") as "sandbox" | "memory";
const SEED = (HOSPITAL === "memory" ? { owners: FAKE_OWNERS } : JSON.parse(readFileSync(env("ACC_SEED_FILE"), "utf8"))) as { owners: Record<string, { facilityUserId: string }>; app_url?: string };
const APP = env("ACC_APP", SEED.app_url ?? "http://localhost:3311");
const START = env("ACC_SERVE_START");
const STOP_ON_FAIL = process.env["ACC_STOP_ON_FAIL"] === "1";
const RATE = Number(env("ACC_SAY_RATE", "175"));
if (KIND === "final" && DRIVER !== "human") throw new Error("the final run is Samuel's: ACC_DRIVER=human");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const t0 = Date.now();
mkdirSync(join(OUT, "clips"), { recursive: true });
const logFile = join(OUT, "harness.log");
const log = (s: string) => { const l = `${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s ${s}`; appendFileSync(logFile, `${l}\n`); process.stdout.write(`${l}\n`); };

const { script, sha256 } = loadScript(env("ACC_SCRIPT"));
const doorLog: DoorLog[] = [];
type Rows = Record<string, unknown>[];
type Hospital = { hasQuery: (n: string) => boolean; query: (n: string, vars: Record<string, string>) => Promise<Rows>; hasPerson: (op: string) => boolean; person: (op: string, vars: Record<string, string>) => Promise<{ ok: boolean; status: number | null; json?: unknown; note?: string }> };
function sandboxHospital(): Hospital {
  const profile = loadProfile();
  const sb = SandboxBlock.parse(profile.sandbox);
  const call = personCaller(profile, sb, new Map(), doorLog);
  return { hasQuery: (n) => !!sb.sql[n], query: async (n, v) => sandboxQuery(sb, n, v), hasPerson: (op) => !!sb.person_ops[op], person: (op, v) => call(op, v) };
}
const post = async (path: string, body: unknown) => { const r = await fetch(`${SERVE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: (await r.json().catch(() => null)) as unknown }; };
const memoryHospital = (): Hospital => ({
  hasQuery: () => true, hasPerson: () => true,
  query: async (n, v) => { const r = await post("/acc/query", { name: n, vars: v }); if (r.status === 404) throw new Error(`no query ${n} in the in-memory hospital`); return (r.json as Rows) ?? []; },
  person: async (op, v) => { const r = await post("/acc/person", { op, vars: v }); return { ok: r.status < 300, status: r.status, json: r.json, ...(r.status >= 300 ? { note: JSON.stringify(r.json).slice(0, 160) } : {}) }; }
});
const hospital = HOSPITAL === "memory" ? memoryHospital() : sandboxHospital();
// The seed names owners by role; the lab work goes to whichever scientist is on, so both are watched.
const ROLE_KEYS: Record<Who, string[]> = { doctor: ["doctor"], nurse: ["nurse"], pharmacist: ["pharmacist"], lab: ["labTech", "labHead"], surgeon: ["surgeon"], reception: ["reception"], accounts: ["accounts"], patient: [], dr_b: ["surgeon"], relative: [], harness: [] };
const ownersOf = (who: Who) => ROLE_KEYS[who].map((k) => SEED.owners[k]?.facilityUserId).filter((x): x is string => !!x);
const DOCTOR = ownersOf("doctor")[0]!;
const WATCHED = [...new Set((Object.keys(ROLE_KEYS) as Who[]).flatMap(ownersOf))];
const whoOf = (owner: string): Who => (Object.keys(ROLE_KEYS) as Who[]).find((w) => w !== "dr_b" && ownersOf(w).includes(owner)) ?? "harness";

const getJson = async <T>(path: string): Promise<T | null> => { try { const r = await fetch(`${SERVE}${path}`, { signal: AbortSignal.timeout(5000) }); return r.ok ? ((await r.json()) as T) : null; } catch { return null; } };
const views = new Map<string, EmrTaskView[]>();
// First time the harness saw each action in each state, on its own clock.
const seen = new Map<string, string>();
let polling = true;
async function pollOnce(): Promise<void> {
  await Promise.all(WATCHED.map(async (o) => {
    const v = await getJson<EmrTaskView[]>(`/tasks?owner=${o}`);
    if (!v) return;
    views.set(o, v);
    for (const t of v) for (const a of t.actions) { const k = `${a.action_id}:${a.state}`; if (!seen.has(k)) seen.set(k, now()); }
  }));
}
void (async () => { while (polling) { await pollOnce(); await wait(400); } })();
const allActions = (owner?: string) => [...views.entries()].filter(([o]) => !owner || o === owner).flatMap(([o, vs]) => vs.flatMap((t) => t.actions.map((a) => ({ ...a, owner: o, task_id: t.task_id, patient_id: t.patient_id, admission_id: t.admission_id }))));

// Patient A and B as the record names them once their arrivals open.
type Bound = { patient: string; visit: string | null; admission: string | null; tasks: Set<string> };
const bound: Partial<Record<"A" | "B", Bound>> = {};
async function refreshBound(): Promise<void> {
  for (const ref of ["A", "B"] as const) {
    const b = bound[ref];
    if (!b) continue;
    for (const [, vs] of views) for (const t of vs) if (t.patient_id === b.patient) { b.tasks.add(t.task_id); b.visit ??= t.visit_id; if (t.admission_id) b.admission ??= t.admission_id; }
    if (!b.admission && b.visit && HOSPITAL === "sandbox" && hospital.hasQuery("admission_for_visit")) { try { const a = (await hospital.query("admission_for_visit", { visit: b.visit }))[0]?.["id"]; if (a) b.admission = String(a); } catch { /* not admitted yet */ } }
  }
}
const resolveVar = (v: string): string => v.replace(/\$(A|B)\.(patient|visit|admission)/g, (_m, r: "A" | "B", f: "patient" | "visit" | "admission") => String(bound[r]?.[f] ?? ""));
const ofPatient = (ref: "A" | "B" | null, owner?: string) => allActions(owner).filter((a) => !ref || (bound[ref] && (a.patient_id === bound[ref]!.patient || bound[ref]!.tasks.has(a.task_id))));
const doctorTasks = (ref: "A" | "B" | null) => (views.get(DOCTOR) ?? []).filter((t) => !ref || (bound[ref] && (t.patient_id === bound[ref]!.patient || bound[ref]!.tasks.has(t.task_id))));

// The door as the serve sees it, through a proxy that can drop one write's reply after the hospital has done the write.
const PROXY_PORT = process.env["ACC_DOOR_PROXY_PORT"] ? Number(process.env["ACC_DOOR_PROXY_PORT"]) : null;
let dropNext: { path: string; hit: string | null } | null = null;
if (PROXY_PORT) {
  const upstream = new URL(env("ACC_DOOR_UPSTREAM", "http://localhost:3311"));
  createServer((req, res) => {
    const drop = dropNext && !dropNext.hit && req.method === "POST" && (req.url ?? "").includes(dropNext.path) ? dropNext : null;
    if (drop) drop.hit = `${req.method} ${req.url}`;
    const up = httpRequest({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: { ...req.headers, host: upstream.host } }, (r) => {
      // The hospital answered and has done the write; the serve never hears it.
      if (drop) { r.resume(); r.on("end", () => req.socket.destroy()); log(`lost ack: dropped the ${r.statusCode} reply to ${drop.hit}`); return; }
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  }).listen(PROXY_PORT, "127.0.0.1");
}

// Serve control by port and the documented start script only.
let restarts = 0;
const serveLog = () => join(OUT, `serve-${restarts}.log`);
function startServe(): void {
  const fd = openSync(serveLog(), "a");
  const child = spawn("/bin/bash", [START], { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, ACC_OUT: OUT } });
  child.unref();
  closeSync(fd);
}
function pidsOnPort(): number[] { try { return execFileSync("lsof", ["-tiTCP:" + SERVE_PORT, "-sTCP:LISTEN"], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number); } catch { return []; } }
function killServe(signal: "SIGKILL" | "SIGTERM"): number[] { const pids = pidsOnPort(); for (const p of pids) { try { process.kill(p, signal); } catch { /* gone */ } } return pids; }
async function healthy(ms = 120_000): Promise<boolean> { const end = Date.now() + ms; while (Date.now() < end) { if ((await getJson<{ ok: boolean }>("/health"))?.ok) return true; await wait(500); } return false; }
async function restartServe(signal: "SIGKILL" | "SIGTERM"): Promise<{ ms: number; ok: boolean; pids: number[] }> {
  const at = Date.now();
  const pids = killServe(signal);
  for (let i = 0; i < 40 && pidsOnPort().length; i++) await wait(250);
  restarts += 1;
  startServe();
  const ok = await healthy();
  return { ms: Date.now() - at, ok, pids };
}

// The voices: a synthetic clip played through the speakers, or posted as the strip's chunks, or typed, or Samuel at the microphone.
let seq = 0;
const session = `acc-${Date.now().toString(36)}`;
function render(voice: string, text: string, id: string): { file: string; ms: number } {
  const file = join(OUT, "clips", `${id}.wav`);
  execFileSync("say", ["-v", voice, "-r", String(RATE), "-o", file, "--file-format=WAVE", "--data-format=LEI16@16000", text], { timeout: 30_000 });
  const info = parseWav(new Uint8Array(readFileSync(file)));
  return { file, ms: info.ok ? Math.round(info.durationMs) : 0 };
}
// The words and voice ride as extra form fields the real serve ignores, so the in-memory hospital can stand in for its ear.
async function postChunk(owner: string, file: string, ms: number, text: string, voice: string, patientId?: string): Promise<unknown> {
  const form = new FormData();
  // A stand-in's own strip is on that patient's page, as the person answering would be.
  if (patientId) form.set("patientId", patientId);
  form.set("acc_text", text); form.set("acc_voice", voice);
  form.set("owner", owner); form.set("session_id", session); form.set("seq", String(seq++)); form.set("captured_at", String(Date.now() - ms));
  // No presence marker, as the strip sends none today; a marker with no recent input would mark every line not present.
  form.set("audio", new Blob([readFileSync(file)], { type: "audio/wav" }), "chunk.wav");
  const r = await fetch(`${SERVE}/tasks/listen`, { method: "POST", body: form });
  const end = new FormData();
  end.set("owner", owner); end.set("session_id", session); end.set("seq", String(seq++)); end.set("end", "1");
  // The end marker names the same page, or the service has no patient to finish the words for.
  if (patientId) end.set("patientId", patientId);
  await fetch(`${SERVE}/tasks/listen`, { method: "POST", body: end }).catch(() => undefined);
  return r.json().catch(() => null);
}
const rl = DRIVER === "human" ? createInterface({ input: process.stdin, output: process.stdout }) : null;
// The fake microphone: one file with every line said in the room at its own time, silence between, played by Chrome from the microphone grant on.
const FAKE_LEAD_MS = 150_000;
let fakeT0 = 0;
// The whole fake microphone file in memory, so a reloaded page's microphone can be given the rest of it from the moment of the reload.
let fakeBytes: Uint8Array | null = null;
let fakeRealigning: Promise<void> | null = null;
// The strip session the doctor's page last posted under, and who waits for the first post of a new one.
let lastStripSid: string | null = null;
let newSidSeen: ((sid: string) => void) | null = null;
// A planned reload cuts the file in the quiet before its line, wherever the reload itself lands.
let plannedCutMs: number | null = null;
// Waits until the fake microphone file reaches an offset, following the file's zero when a reload moves it.
async function untilFake(offsetMs: number): Promise<void> {
  for (;;) {
    if (fakeRealigning) await fakeRealigning;
    const left = fakeT0 + offsetMs - Date.now();
    if (left <= 0) return;
    await wait(Math.min(left, 1000));
  }
}
// Chrome reads its fake microphone file afresh whenever a page opens the microphone, so on any reload of the doctor's page the file is cut to play on from that moment.
function realignFakeMic(why: string): void {
  if (DRIVER !== "fake" || !fakeBytes || !fakeT0 || !page || fakeRealigning) return;
  const reloadAt = Date.now();
  const cut = plannedCutMs ?? fakeRealign(fakeT0, reloadAt, reloadAt).cutMs;
  plannedCutMs = null;
  const file = join(OUT, "fake-mic.wav");
  // The rest of the file after the cut, under a header that says its new length; written beside and renamed so Chrome never reads half a file.
  const data = fakeBytes.subarray(Math.min(fakeBytes.length, 44 + Math.round((cut / 1000) * 16_000) * 2));
  const head = Buffer.from(fakeBytes.subarray(0, 44));
  head.writeUInt32LE(36 + data.length, 4); head.writeUInt32LE(data.length, 40);
  const fd = openSync(`${file}.next`, "w"); writeSync(fd, head); writeSync(fd, data); closeSync(fd);
  renameSync(`${file}.next`, file);
  log(`fake microphone: the doctor's page reloaded (${why}); the file now plays on from ${(cut / 1000).toFixed(1)} s`);
  // The file starts again when the new page's microphone opens, which is when its first post reaches the serve under a new session; the header shows Listening earlier.
  const before = lastStripSid;
  fakeRealigning = new Promise<boolean>((resolve) => {
    const t = setTimeout(() => { newSidSeen = null; resolve(false); }, 180_000);
    newSidSeen = (sid) => { if (sid === before) return; clearTimeout(t); newSidSeen = null; resolve(true); };
  }).then((back) => {
    fakeT0 = fakeRealign(fakeT0, reloadAt, Date.now() - 100).fakeT0;
    log(`fake microphone: listening ${back ? "came back" : "did not come back"} ${((Date.now() - reloadAt) / 1000).toFixed(1)} s after the reload; the script's slots moved with it`);
    fakeRealigning = null;
  });
}
const fakeSlots = new Map<string, { at: number; clipMs: number; end: number }>();
const heardInRoom = (l: Line) => l.mode === "speak" || l.mode === "play";
function slotGap(l: Line, next: Line | undefined): number {
  if (!heardInRoom(l)) return l.mode === "wait" ? Math.min(l.timeout_s ?? 90, 180) * 1000 : l.mode === "fault" ? 45_000 : l.mode === "person" ? 30_000 : 20_000;
  if (l.interrupt) return 60_000;
  if (l.lose_ack || next?.confirm) return 40_000;
  return Number(process.env["ACC_FAKE_GAP_MS"] ?? 25_000);
}
function buildFakeMic(): void {
  const only = process.env["ACC_ONLY"] ? new Set(process.env["ACC_ONLY"].split(",")) : null;
  const lines = script.lines.filter((l) => !only || only.has(l.id));
  const rate = 16_000;
  const parts: Float32Array[] = [new Float32Array((FAKE_LEAD_MS / 1000) * rate)];
  let at = 0;
  lines.forEach((l, i) => {
    let clipMs = 0;
    if (heardInRoom(l)) {
      const voice = l.mode === "play" ? script.voices[l.who] ?? "Samantha" : script.voices["doctor"] ?? "Rishi";
      const clip = decodeWav(new Uint8Array(readFileSync(render(voice, l.text!, `${l.id}-fake`).file)));
      parts.push(clip.samples);
      clipMs = Math.round((clip.samples.length / clip.sampleRate) * 1000);
    }
    const gap = slotGap(l, lines[i + 1]);
    parts.push(new Float32Array(Math.round((gap / 1000) * rate)));
    fakeSlots.set(l.id, { at, clipMs, end: at + clipMs + gap });
    at += clipMs + gap;
  });
  parts.push(new Float32Array(20 * 60 * rate));
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  fakeBytes = encodeWav(all, rate);
  writeFileSync(join(OUT, "fake-mic.wav"), fakeBytes);
  writeFileSync(join(OUT, "fake-mic.schedule.json"), `${JSON.stringify(Object.fromEntries(fakeSlots), null, 1)}\n`);
  log(`fake microphone: ${lines.length} slots, ${Math.round(at / 60_000)} min after a ${FAKE_LEAD_MS / 1000} s lead-in`);
}

// A typed stand-in's phone is unique to the run, because the hospital refuses a phone another patient already holds; it is said in digit words.
const DIGIT_WORD = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const runPhone = (prefix: string, salt: number) => `${prefix}${String((Date.now() + salt * 7919) % 10_000_000).padStart(7, "0")}`;
const phones: Record<string, string> = { A: runPhone("0803", 1), B: runPhone("0806", 2) };
const withPhones = (t: string) => t.replace(/\{phone:(A|B)\}/g, (_m, r: "A" | "B") => phones[r]!.split("").map((d) => DIGIT_WORD[Number(d)]).join(" "));
async function deliver(line: Line): Promise<{ lineEnd: string | null; note: string | null }> {
  const text = withPhones(line.text!);
  if (line.mode === "type" || line.mode === "remote") {
    const owner = nudgedOwner(line.who, line.patient) ?? ownersOf(line.who)[0]!;
    const patientId = line.patient ? bound[line.patient]?.patient : undefined;
    if (line.mode === "remote") {
      const clip = render(script.voices[line.who] ?? "Daniel", text, `${line.id}-${seq}`);
      const r = await postChunk(owner, clip.file, clip.ms, text, script.voices[line.who] ?? "Daniel", patientId);
      return { lineEnd: now(), note: `posted ${script.voices[line.who] ?? "Daniel"} through ${line.who}'s strip: ${JSON.stringify(r).slice(0, 160)}` };
    }
    const at = now();
    const r = await fetch(`${SERVE}/tasks/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, text, spokenAt: at, ...(patientId ? { patientId } : {}) }) });
    return { lineEnd: at, note: `typed as ${line.who} (${owner.slice(0, 8)}): ${r.status}` };
  }
  const voice = line.mode === "play" ? script.voices[line.who] ?? "Samantha" : script.voices["doctor"] ?? "Rishi";
  if (line.mode === "speak" && DRIVER === "human") {
    process.stdout.write(`\n\x1b[1m  SAY (${line.id}): ${text}\x1b[0m\n  (the harness moves on when it hears you; Enter moves on if it does not)\n`);
    const promptAt = now();
    const ac = new AbortController();
    // Whichever comes first: the line appears in the doctor's transcript, or Samuel presses Enter.
    const heardIt = (async () => { while (!ac.signal.aborted && !lineAfter(promptAt)) await wait(300); return "heard"; })();
    const how = await Promise.race([rl!.question("", { signal: ac.signal }).then(() => "enter", () => "heard"), heardIt]);
    ac.abort();
    return { lineEnd: lineAfter(promptAt)?.ended ?? now(), note: how === "heard" ? "said by Samuel; line end from the transcript" : "said by Samuel; moved on by Enter" };
  }
  if (DRIVER === "text") {
    if (line.mode === "play") return { lineEnd: null, note: "skipped: another voice needs audio" };
    const at = now();
    const r = await fetch(`${SERVE}/tasks/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: DOCTOR, text, spokenAt: at }) });
    return { lineEnd: at, note: `typed: ${r.status} ${(await r.text()).slice(0, 160)}` };
  }
  // Under the fake microphone the words are already in the file Chrome plays; the harness waits for them to end.
  if (DRIVER === "fake") { const slot = fakeSlots.get(line.id); if (!slot) return { lineEnd: null, note: "no slot in the fake microphone file" }; await untilFake(FAKE_LEAD_MS + slot.at + slot.clipMs); return { lineEnd: now(), note: `in the fake microphone file at ${((FAKE_LEAD_MS + slot.at) / 1000).toFixed(1)} s, ${voice} ${slot.clipMs} ms` }; }
  const clip = render(voice, text, `${line.id}-${seq}`);
  if (DRIVER === "post") { const r = await postChunk(DOCTOR, clip.file, clip.ms, text, voice); return { lineEnd: now(), note: JSON.stringify(r).slice(0, 200) }; }
  execFileSync("afplay", [clip.file], { timeout: 60_000 });
  return { lineEnd: now(), note: `played ${voice} ${clip.ms} ms through the speakers` };
}
const nudgedOwner = (who: Who, ref: "A" | "B" | null): string | null => ownersOf(who).find((o) => ofPatient(ref, o).some((a) => a.kind === "nudge_owner" && a.state === "completed")) ?? null;

// The browser the doctor works in, launched headed so the strip's own counter can be read; the person signs in and grants the microphone.
type Page = { evaluate: <T>(fn: (arg: string) => T, arg: string) => Promise<T>; screenshot: (o: { path: string }) => Promise<unknown>; click: (s: string) => Promise<void>; goto: (u: string, o?: unknown) => Promise<unknown>; fill: (s: string, v: string) => Promise<void>; waitForURL: (f: (u: URL) => boolean, o?: unknown) => Promise<void>; waitForSelector: (s: string, o?: unknown) => Promise<unknown>; getByRole: (r: string, o?: unknown) => { waitFor: (o?: unknown) => Promise<void>; click: () => Promise<void>; locator: (s: string, o?: unknown) => { first: () => { click: () => Promise<void> } } }; waitForLoadState: (s: string) => Promise<void>; waitForFunction: (f: (a: string) => boolean, a: string, o?: unknown) => Promise<unknown>; locator: (s: string) => { count: () => Promise<number> } };
let page: Page | null = null;
let browserClose: (() => Promise<void>) | null = null;
const STRIP = 'section[aria-label^="Agent for"]';
async function openBrowser(): Promise<void> {
  const req = createRequire(env("ACC_PISGAH_PKG"));
  const { chromium } = req("playwright") as { chromium: { launch: (o: unknown) => Promise<{ newContext: (o: unknown) => Promise<{ setOffline: (on: boolean) => Promise<void>; grantPermissions: (p: string[], o: unknown) => Promise<void>; addInitScript: (f: (s: string) => void, a: string) => Promise<void>; newPage: () => Promise<Page> }>; close: () => Promise<void> }> } };
  const fakeArgs = DRIVER === "fake" ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${join(OUT, "fake-mic.wav")}%noloop`] : [];
  const browser = await chromium.launch({ channel: "chrome", headless: false, ignoreDefaultArgs: ["--enable-automation"], args: ["--window-size=1400,960", ...fakeArgs] });
  const ctx = await browser.newContext({ viewport: { width: 1380, height: 860 } });
  await ctx.grantPermissions(["microphone"], { origin: APP });
  await ctx.addInitScript((serve) => { try { window.localStorage.setItem("pisgah-agent-serve", serve); } catch { /* storage off */ } (window as unknown as { __accDoc?: number }).__accDoc = Date.now() + Math.random(); }, `http://localhost:${SERVE_PORT}`);
  page = await ctx.newPage();
  setOffline = (on) => ctx.setOffline(on);
  // The lab's own window, its own sign-in, opened now so the lab page is compiled before the run needs it.
  if (DRIVER !== "human" && script.lines.some((l) => l.op === "acc_lab_cancel")) {
    const labCtx = await browser.newContext({ viewport: { width: 1200, height: 860 } });
    browserNewContext = async () => labCtx;
    const lw = await labCtx.newPage();
    await lw.goto(`${APP}/login?next=%2Flab`, { timeout: 120_000 });
    await lw.fill('input[name="username"]', "lab.grace");
    await lw.fill('input[name="password"]', env("ACC_PASSWORD", "ZzTestW0-2026"));
    await lw.click('button[type="submit"]');
    await lw.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90_000 }).catch(() => undefined);
    await lw.goto(`${APP}/lab/orders/00000000-0000-4000-8000-000000000000`, { timeout: 120_000 }).catch(() => undefined);
    labWindow = lw;
    log("browser: lab.grace signed in on her own window; the lab order page is compiled");
  }
  // What the strip sends the serve and any page error, so a stopped ear shows in the log rather than as silence.
  const pg = page as unknown as { on: (ev: string, f: (x: unknown) => void) => void };
  // Any reload of the doctor's page, the harness's own or the dev server's after a memory restart, moves the fake microphone with it.
  // A same-page route change keeps the microphone, so only a new document (its init-script stamp changed) counts as a reload.
  let doc: unknown = null;
  pg.on("framenavigated", (f) => {
    const fr = f as { parentFrame: () => unknown; url: () => string; evaluate: (fn: () => unknown) => Promise<unknown> };
    if (fr.parentFrame() !== null) return;
    void fr.evaluate(() => (window as unknown as { __accDoc?: number }).__accDoc).then((d) => { const fresh = d !== doc; doc = d; if (fresh) realignFakeMic(fr.url().replace(/^https?:\/\/[^/]+/, "").slice(0, 60)); }, () => undefined);
  });
  pg.on("response", (r) => { const x = r as { url: () => string; status: () => number; request: () => { method: () => string } }; const u = x.url(); if (x.request().method() === "POST" && u.includes(`:${SERVE_PORT}/tasks/listen`)) { const sid = /session_id=([^&]+)/.exec(u)?.[1] ?? null; if (sid) { newSidSeen?.(sid); lastStripSid = sid; } } if (x.request().method() === "POST" && u.includes(`:${SERVE_PORT}/tasks/`)) appendFileSync(join(OUT, "strip-posts.log"), `${now()} ${u.replace(/^.*\/tasks/, "/tasks").slice(0, 80)} ${x.status()}\n`); });
  pg.on("requestfailed", (r) => { const x = r as { url: () => string; failure: () => { errorText: string } | null }; if (x.url().includes(`:${SERVE_PORT}/`)) appendFileSync(join(OUT, "strip-posts.log"), `${now()} FAILED ${x.url().replace(/^.*\/tasks/, "/tasks").slice(0, 80)} ${x.failure()?.errorText ?? ""}\n`); });
  pg.on("console", (m) => { const x = m as { type: () => string; text: () => string }; if (x.type() === "error") appendFileSync(join(OUT, "strip-posts.log"), `${now()} console ${x.text().slice(0, 200)}\n`); });
  browserClose = () => browser.close();
  await page.goto(`${APP}/login?next=%2Fdoctor`, { timeout: 120_000 });
  await page.fill('input[name="username"]', script.people["doctor"]!.login);
  await page.fill('input[name="password"]', env("ACC_PASSWORD", "ZzTestW0-2026"));
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  // The clinic picker ticks clinics and needs Continue; the URL does not change while it shows.
  const picker = page.getByRole("group", { name: "Clinics" });
  if (await picker.waitFor({ timeout: 30_000 }).then(() => true, () => false)) {
    await picker.locator("label", { hasText: "Accident & Emergency" }).first().click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90_000 }).catch(() => undefined);
  }
  await page.waitForSelector(STRIP, { timeout: 120_000 });
  log(`browser: signed in as ${script.people["doctor"]!.login}; the strip is mounted`);
  if (DRIVER === "human") {
    process.stdout.write("\n  In the Chrome window: press the ear button once to grant the microphone, then once more to start listening. Press Enter here when it says Listening.\n");
    await rl!.question("");
  } else {
    // The first press grants the microphone and arms the wake spotter; once it says so, a second press starts listening, as F1's walks do.
    // A press before the strip hydrates is lost, so the harness waits, presses, and presses again only if nothing changed.
    await wait(5000);
    const armed = () => page!.waitForFunction((st: string) => /Say hey Pisgah|Listening|Hearing you/.test(document.querySelector(`${st} header`)?.textContent ?? ""), STRIP, { timeout: 20_000 }).then(() => true, () => false);
    fakeT0 = Date.now();
    await page.click(`${STRIP} button[aria-label="Listen"]`);
    if (!(await armed())) { log("browser: the first press did not arm the strip; pressing again"); fakeT0 = Date.now(); await page.click(`${STRIP} button[aria-label="Listen"]`); if (!(await armed())) log("browser: the wake spotter did not say it was ready"); }
    if (!(await page.locator(`${STRIP} button[aria-label="Stop listening"]`).count())) await page.click(`${STRIP} button[aria-label="Listen"]`);
    await page.waitForSelector(`${STRIP} button[aria-label="Stop listening"]`, { timeout: 30_000 }).catch(() => { log("browser: the strip did not start listening"); harnessErrors.push("browser: the strip did not start listening"); });
    log("browser: the harness pressed Listen (the one microphone grant, and a start if the strip asked for one)");
  }
}
let setOffline: (on: boolean) => Promise<void> = async () => undefined;
let reloadBack = false;
async function touchesNow(): Promise<{ emr: number; strip: number } | null> {
  if (!page) return null;
  return page.evaluate((o) => ({ emr: Number(sessionStorage.getItem(`pisgah-agent-touches:${o}`) ?? "0"), strip: Number(sessionStorage.getItem(`pisgah-agent-strip-touches:${o}`) ?? "0") }), DOCTOR).catch(() => null);
}

// One expectation, checked against the serve's views and the sandbox's read-only queries.
// Every assertion is bound to this step: an action must come from this step's own utterance when the script says so, and must reach the asserted state while the step runs, so an older record never passes for a dropped instruction.
async function check(e: Expect, line: Line, lineId: string | null, before: Set<string>, started: string): Promise<{ ok: boolean; detail: string }> {
  await refreshBound();
  const ref = line.patient;
  const during = (at: string | null | undefined) => !!at && at >= started;
  if ("arrival" in e) {
    if (bound[e.arrival]) return { ok: true, detail: `bound to ${bound[e.arrival]!.patient.slice(0, 8)}` };
    const t = (views.get(DOCTOR) ?? []).find((x) => !before.has(x.task_id) && x.patient_id && x.actions.some((a) => a.kind === "open_unnamed_encounter" && a.state === "completed"));
    if (!t) return { ok: false, detail: "no new arrival yet" };
    bound[e.arrival] = { patient: t.patient_id!, visit: t.visit_id, admission: null, tasks: new Set([t.task_id]) };
    return { ok: true, detail: `arrival ${t.patient_id!.slice(0, 8)} visit ${t.visit_id?.slice(0, 8) ?? "?"}` };
  }
  if ("identity" in e) {
    const ids = doctorTasks(e.identity).flatMap((t) => t.identities);
    // The ear may spell a surname its own way, so a held name with the same first name counts, and the result says what was heard.
    const first = e.name.split(" ")[0]!.toLowerCase();
    const fresh = ids.filter((i) => during(i.at));
    // A name held in this step under the ear's own spelling still counts, and the detail shows the spelling so it is never hidden.
    const hit = fresh.find((i) => i.name === e.name) ?? fresh.find((i) => i.name.toLowerCase().startsWith(`${first} `)) ?? fresh[0];
    return { ok: !!hit, detail: hit ? `held ${hit.name}${hit.name === e.name ? "" : ` (said ${e.name})`} ${hit.phone ?? "no phone"} (${hit.state})` : `held: ${ids.map((i) => i.name).join(", ") || "none"}` };
  }
  if ("act" in e) {
    const owners = e.owner ? ownersOf(e.owner) : [DOCTOR];
    if (e.from_line && !lineId) return { ok: false, detail: `${e.act}: this step's words were not heard, so nothing can come from them` };
    const xs = owners.flatMap((o) => ofPatient(ref, o)).filter((a) => a.kind === e.act && (!e.from_line || a.line_id === lineId));
    const inState = xs.filter((a) => a.state === e.state && during(seen.get(`${a.action_id}:${a.state}`)));
    const n = e.n ?? 1;
    const vals = e.values ? inState.filter((a) => Object.entries(e.values!).every(([k, v]) => String(a.args[k] ?? "") === String(v))) : inState;
    return { ok: vals.length >= n, detail: `${e.act}: ${xs.map((a) => `${a.state}${a.reason ? `(${a.reason.slice(0, 60)})` : ""}`).join(", ") || "none"}${e.values ? `; values ${JSON.stringify(xs.map((a) => a.args)).slice(0, 160)}` : ""}` };
  }
  if ("awaits" in e) { const a = ofPatient(ref, DOCTOR).find((x) => x.kind === e.awaits && x.state === "proposed" && x.awaiting && during(x.proposed_at)); return { ok: !!a, detail: a ? `awaiting ${a.awaiting}` : "not awaiting" }; }
  if ("question" in e) { const q = doctorTasks(ref).flatMap((t) => t.asked).filter((x) => during(x.at)).map((x) => x.text); const hit = q.find((x) => x.toLowerCase().includes(e.question.toLowerCase())); return { ok: !!hit, detail: hit?.slice(0, 160) ?? `questions: ${q.slice(-2).join(" | ").slice(0, 160) || "none"}` }; }
  if ("no_write_from_line" in e) { const xs = ofPatient(ref, DOCTOR).filter((a) => a.kind === e.no_write_from_line && a.line_id === lineId && a.state === "completed"); return { ok: xs.length === 0, detail: `${xs.length} ${e.no_write_from_line} from this line` }; }
  if ("no_order_from_line" in e) { const xs = allActions().filter((a) => ["order_test", "prescribe"].includes(a.kind) && a.line_id === lineId && ["sent", "acknowledged", "completed"].includes(a.state)); return { ok: lineId !== null && xs.length === 0, detail: lineId ? `${xs.length} orders from this line` : "line not found in any transcript" }; }
  if ("class" in e) { const l = transcriptLine(lineId); return { ok: !!l && (l.class === e.class || l.classes.includes(e.class as never)), detail: l ? `class ${l.class} ${JSON.stringify(l.classes)}` : "line not found" }; }
  if ("speaker" in e) { const l = transcriptLine(lineId); return { ok: l?.speaker?.speaker === e.speaker, detail: l ? `speaker ${l.speaker?.speaker ?? "none"} ${l.speaker?.label ?? ""}` : "line not found" }; }
  if ("delegation" in e) {
    const ds = doctorTasks(ref).flatMap((t) => t.delegations).filter((d) => d.side === "delegator" && (d.team === e.delegation.team || d.task_kind === e.delegation.team));
    const st = e.delegation.state;
    const ok = ds.filter((d) => during(!st ? d.at : st === "assigned" ? d.assigned_at : st === "acknowledged" ? d.acknowledged_at : d.completed_at));
    return { ok: ok.length >= (e.delegation.n ?? 1), detail: `${e.delegation.team}: ${ds.map((d) => (d.completed_at ? "completed" : d.acknowledged_at ? "acknowledged" : d.assigned_at ? "assigned" : "asked")).join(", ") || "none"}` };
  }
  if ("obligation" in e) { const os = doctorTasks(ref).flatMap((t) => t.obligations).filter((o) => (!e.obligation.after || o.after === e.obligation.after)); const hit = os.find((o) => o.state === e.obligation.state && during(e.obligation.state === "held" ? o.held_at : o.fired_at ?? o.held_at)); return { ok: !!hit, detail: `${os.map((o) => `${o.title.slice(0, 40)}:${o.state}`).join(", ") || "none"}` }; }
  if ("tracking" in e) { await readTracking(); return { ok: trackingTarget === (bound[e.tracking]?.patient ?? "?") || (!!bound[e.tracking]?.admission && trackingTarget === bound[e.tracking]!.admission), detail: `tracking ${trackingTarget?.slice(0, 8) ?? "none"}` }; }
  if ("tasks_survive" in e) return { ok: survived, detail: survivedDetail };
  if ("not_heard" in e) {
    const words = (line.text ?? "").toLowerCase().replace(/[^a-z ]/g, "").split(" ").filter((w) => w.length > 4);
    const leaked = [...views.values()].flat().flatMap((t) => t.transcript).filter((l) => l.at >= started && words.filter((w) => l.text.toLowerCase().includes(w)).length >= Math.min(3, words.length));
    return { ok: leaked.length === 0, detail: leaked.length ? `heard while muted: ${leaked[0]!.text.slice(0, 80)}` : "nothing said while muted reached any transcript" };
  }
  if ("wake" in e) { const rows = wakeRows(); return { ok: rows.length > 0, detail: `${rows.length} wakes measured` }; }
  if ("query" in e) {
    if (!hospital.hasQuery(e.query)) return { ok: false, detail: `query ${e.query} is not in the profile` };
    try {
      const rows = await hospital.query(e.query, Object.fromEntries(Object.entries(e.vars).map(([k, v]) => [k, resolveVar(v)])));
      const okRows = e.match ? rows.filter((r) => Object.entries(e.match!).every(([k, v]) => r[k] === v)) : rows;
      return { ok: okRows.length >= (e.rows_min ?? 1), detail: `${rows.length} rows ${JSON.stringify(rows[0] ?? {}).slice(0, 160)}` };
    } catch (err) { return { ok: false, detail: `query failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}` }; }
  }
  return { ok: false, detail: "unknown expectation" };
}
const transcriptLine = (lineId: string | null) => (lineId ? [...views.values()].flat().flatMap((t) => t.transcript).find((l) => l.line_id === lineId) ?? null : null);
let trackingTarget: string | null = null;
async function readTracking(): Promise<void> { const t = await getJson<{ target: { patient_id?: string; admission_id?: string } | null }>(`/tasks/tracking?owner=${DOCTOR}`); trackingTarget = t?.target?.patient_id ?? t?.target?.admission_id ?? null; }
let survived = false;
let survivedDetail = "no restart yet";
const wakeRows = (): { latency_ms: number; keyword: string }[] => { const f = join(OUT, "store", "wake.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { latency_ms: number; keyword: string; owner: string }).filter((r) => r.owner === DOCTOR) : []; };

// The new doctor's line this script line became: the first transcript line heard after the line started, in any of the doctor's tasks.
function lineAfter(since: string, owners: string[] = [DOCTOR]): { line_id: string; text: string; at: string; ended: string | null } | null {
  const ls = owners.flatMap((o) => (views.get(o) ?? []).flatMap((t) => t.transcript)).filter((l) => l.at >= since).sort((a, b) => (a.at < b.at ? -1 : 1));
  const l = ls[0];
  return l ? { line_id: l.line_id, text: l.text, at: l.at, ended: l.ambient?.ended_at ?? null } : null;
}

// The utterance a script line became, bound by its words or, for a line the agent kept no words of, by when it was heard (acceptance.ts bindLine).
const claimed = new Set<string>();
function lineFor(text: string, since: string, owners: string[]): ReturnType<typeof lineAfter> {
  const rows = owners.flatMap((o) => (views.get(o) ?? []).flatMap((t) => t.transcript));
  const hit = bindLine(text, since, rows.map((l) => ({ line_id: l.line_id, text: l.text, at: l.at, kept: l.kept, ...(l.ambient ? { ambient: { raw_text: l.ambient.raw_text, ended_at: l.ambient.ended_at } } : {}) })), claimed);
  return hit ? { line_id: hit.line_id, text: hit.text, at: hit.at, ended: hit.ambient?.ended_at ?? null } : null;
}

// Reloads the doctor's page and waits for the strip to say it is listening again with no touch.
async function reloadPage(line: Line): Promise<void> {
  if (!page) return;
  const pg = page as unknown as { reload: (o?: unknown) => Promise<unknown> };
  await pg.reload({ timeout: 120_000 }).catch(() => harnessErrors.push(`${line.id}: the page did not reload`));
  const back = await page.waitForFunction((st: string) => /Listening|Hearing you/.test(document.querySelector(`${st} header`)?.textContent ?? ""), STRIP, { timeout: 60_000 }).then(() => true, () => false);
  log(`${line.id}: page reloaded; listening again with no touch: ${back}`);
  reloadBack = back;
  if (fakeRealigning) await fakeRealigning;
}

const steps: StepOutcome[] = [];
const harnessErrors: string[] = [];
const faults: Fault[] = [];
const otherTouches: AccResult["touches"]["other_people"] = [];
async function runLine(line: Line): Promise<void> {
  // Under the fake microphone each line runs in its slot of the file, so the room's timing never depends on the agent.
  const slot = DRIVER === "fake" ? fakeSlots.get(line.id) : undefined;
  // Under the fake microphone a reload runs in the quiet before its line, so the file is cut before the words and they play whole once listening is back.
  if (line.reload && page && DRIVER === "fake" && process.env["ACC_FAKE_RELOAD"] !== "0") { if (slot) plannedCutMs = FAKE_LEAD_MS + slot.at - 3000; await reloadPage(line); }
  if (slot) await untilFake(FAKE_LEAD_MS + slot.at);
  const started = now();
  const errors: string[] = [];
  // A line whose precondition never came is failed, whatever its own checks say, since it ran on a state the script did not expect.
  let unmet = false;
  await readTracking();
  for (const a of line.after ?? []) {
    const end0 = Date.now() + 180_000;
    const end = () => (slot ? fakeT0 + FAKE_LEAD_MS + slot.end - 1500 : end0);
    while (!nudgedOwner(a.nudged, line.patient) && Date.now() < end()) await wait(500);
    if (!nudgedOwner(a.nudged, line.patient)) { errors.push(`${a.nudged} was never nudged for this patient`); unmet = true; }
  }
  const before = new Set((views.get(DOCTOR) ?? []).map((t) => t.task_id));
  const touchBefore = (await touchesNow())?.emr ?? 0;
  let lineEnd: string | null = null, note: string | null = null, blocked = false;
  let interruptWatch: Promise<void> | null = null;
  if (line.interrupt) interruptWatch = watchInterrupt(line);
  if (line.mode === "fault") {
    const counts = Object.fromEntries(WATCHED.map((o) => [o, (views.get(o) ?? []).length]));
    const target = trackingTarget;
    const r = await restartServe("SIGTERM");
    await wait(1500);
    await pollOnce(); await readTracking();
    const after = Object.fromEntries(WATCHED.map((o) => [o, (views.get(o) ?? []).length]));
    survived = r.ok && WATCHED.every((o) => (after[o] ?? 0) >= (counts[o] ?? 0));
    survivedDetail = `restart ${r.ms} ms; tasks before ${JSON.stringify(Object.values(counts))} after ${JSON.stringify(Object.values(after))}; tracking ${target?.slice(0, 8) ?? "none"} -> ${trackingTarget?.slice(0, 8) ?? "none"}`;
    faults.push({ kind: "restart", line: line.id, at: started, killed_during: null, restarted_in_ms: r.ms, outcome: survivedDetail, ok: survived && target === trackingTarget });
  } else if (line.mode === "person") {
    const vars = Object.fromEntries(Object.entries(line.vars ?? {}).map(([k, v]) => [k, resolveVar(v)]));
    // A step that names a test gets that test's order id from the record, as the person would see it on screen.
    if (vars["order_test"] && HOSPITAL === "sandbox") { const o = (await hospital.query("acc_order_for_test", { visit: vars["visit"] ?? "", test: vars["order_test"] }))[0]; vars["order_id"] = String(o?.["order_id"] ?? ""); }
    // A settle names the amount owed, so the stay's bill is read first, as the accounts person reads it on screen.
    if (line.op === "settle" && !vars["outstanding"] && hospital.hasPerson("bill")) { const b = await hospital.person("bill", vars); vars["outstanding"] = String((b.json as { bill?: { outstandingNgn?: string } } | null)?.bill?.outstandingNgn ?? "0.00"); }
    // In Samuel's run his own attestations are his, at the screen; the harness only waits for them.
    if (DRIVER === "human" && line.who === "doctor") { process.stdout.write(`\n  AT THE SCREEN (${line.id}): ${line.note ?? line.op}\n  Press Enter here when done.\n`); await rl!.question(""); note = "done by Samuel at the screen"; }
    else if (HOSPITAL === "sandbox" && line.op === "acc_lab_result") { const r = await labResult(vars); note = r.note; if (!r.ok) errors.push(r.note); }
    else if (HOSPITAL === "sandbox" && line.op === "acc_lab_cancel") { const r = await labCancelOnScreen(vars); note = r.note; if (!r.ok) errors.push(r.note); }
    else if (!hospital.hasPerson(line.op!)) { blocked = true; errors.push(`person op ${line.op} is not in the profile`); }
    else { const r = await hospital.person(line.op!, vars); note = `person ${line.op}: ${r.status} ${r.note ?? ""}`.trim(); if (!r.ok) errors.push(note); }
    otherTouches.push({ line: line.id, who: line.who, what: `person step ${line.op} at that person's screen` });
    lineEnd = now();
  } else if (line.mode !== "wait") {
    if (line.mode === "type") otherTouches.push({ line: line.id, who: line.who, what: "typed stand-in line at that person's strip" });
    if (line.mode === "remote") otherTouches.push({ line: line.id, who: line.who, what: "spoken stand-in through that person's strip (no touch, listed so it is not mistaken for the doctor's)" });
    if (line.lose_ack && PROXY_PORT) dropNext = { path: line.lose_ack.path, hit: null };
    if (line.muted && page && DRIVER === "human") { process.stdout.write("\n  MUTE: press the strip's mute button (the crossed microphone), then press Enter here.\n"); await rl!.question(""); }
    else if (line.muted && page) { await page.click(`${STRIP} button[aria-label="Mute the agent"]`).catch(() => harnessErrors.push(`${line.id}: no Mute button`)); await wait(800); }
    // Chrome's fake microphone reads its file afresh on a reload, so the harness cuts the file at the reload (realignFakeMic); ACC_FAKE_RELOAD=0 skips the reload.
    if (line.reload && page && DRIVER === "fake" && process.env["ACC_FAKE_RELOAD"] === "0") log(`${line.id}: reload not run under the fake microphone; see the reload probe`);
    else if (line.reload && page && DRIVER !== "fake") await reloadPage(line);
    if (line.offline_s && page) await setOffline(true);
    const d = await deliver(line).catch((e: unknown) => ({ lineEnd: null, note: `delivery failed: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}` }));
    lineEnd = d.lineEnd; note = d.note;
    if (!lineEnd || /refused|delivery failed/.test(note ?? "")) harnessErrors.push(`${line.id}: ${note}`);
    if (line.offline_s && page) { await wait(line.offline_s * 1000); await setOffline(false); log(`${line.id}: the browser was offline ${line.offline_s} s while the line was said`); }
    if (line.muted && page && DRIVER === "human") { process.stdout.write("\n  UNMUTE: press the mute button again, then press Enter here.\n"); await rl!.question(""); }
    else if (line.muted && page) { await wait(1500); await page.click(`${STRIP} button[aria-label="Unmute the agent"]`).catch(() => harnessErrors.push(`${line.id}: could not unmute`)); }
    if (!lineEnd) blocked = true;
  }
  // Each check is tried until it holds or the line's time runs out; nothing passes by default.
  const limit0 = Date.now() + (line.timeout_s ?? 90) * 1000;
  const limit = () => (slot ? fakeT0 + FAKE_LEAD_MS + slot.end - 1500 : limit0);
  let heard: ReturnType<typeof lineAfter> = null;
  let outcomes: CheckOutcome[] = [];
  for (;;) {
    await wait(700);
    await refreshBound();
    if (!heard && ["speak", "play", "type", "remote"].includes(line.mode)) heard = lineFor(line.text ?? "", started, line.mode === "type" || line.mode === "remote" ? ownersOf(line.who) : [DOCTOR]);
    // The step's window opens when its own words were heard, if that was before the step began.
    const from = heard && heard.at < started ? new Date(Date.parse(heard.at) - 2000).toISOString() : started;
    outcomes = [];
    for (const e of line.expect) outcomes.push({ expect: e, optional: "optional" in e && e.optional === true, ...(await check(e, line, heard?.line_id ?? null, before, from)) });
    if (blocked || outcomes.every((c) => c.ok) || Date.now() > limit()) break;
  }
  if (interruptWatch) await interruptWatch;
  if (line.lose_ack && PROXY_PORT) {
    const hit = dropNext?.hit ?? null;
    const kinds = outcomes.filter((c) => "act" in c.expect);
    faults.push({ kind: "lost_ack", line: line.id, at: started, killed_during: hit, restarted_in_ms: null, outcome: hit ? `reply to ${hit} dropped; ${kinds.map((c) => c.detail).join("; ")}` : "no matching write was seen", ok: !!hit && kinds.every((c) => c.ok) });
    dropNext = null;
  }
  if (line.reload && page && (DRIVER !== "fake" || process.env["ACC_FAKE_RELOAD"] !== "0")) faults.push({ kind: "reload", line: line.id, at: started, killed_during: null, restarted_in_ms: null, outcome: `listening again with no touch: ${reloadBack}; ${outcomes.map((c) => c.detail).join("; ").slice(0, 240)}`, ok: reloadBack && outcomes.filter((c) => !c.optional).every((c) => c.ok) });
  if (line.offline_s && page) faults.push({ kind: "offline", line: line.id, at: started, killed_during: null, restarted_in_ms: null, outcome: outcomes.map((c) => c.detail).join("; ").slice(0, 300), ok: outcomes.filter((c) => !c.optional).every((c) => c.ok) });
  if (line.muted && page) faults.push({ kind: "mute", line: line.id, at: started, killed_during: null, restarted_in_ms: null, outcome: outcomes.map((c) => c.detail).join("; ").slice(0, 300), ok: outcomes.filter((c) => !c.optional).every((c) => c.ok) });
  const lineIds = new Set([heard?.line_id].filter(Boolean) as string[]);
  const verified = allActions().filter((a) => a.state === "completed" && (lineIds.has(a.line_id) || (seen.get(`${a.action_id}:completed`) ?? "") >= started)).map((a) => {
    const at = seen.get(`${a.action_id}:completed`) ?? null;
    return { kind: a.kind, owner: whoOf(a.owner), action_id: a.action_id, record_id: a.proof?.record_id ?? null, verified_at: at, ms_from_line_end: at && lineEnd ? Date.parse(at) - Date.parse(heard?.ended ?? lineEnd) : null };
  });
  const touchAfter = (await touchesNow())?.emr ?? 0;
  const status = unmet && !blocked ? "failed" : stepStatus(outcomes, blocked);
  const out: StepOutcome = { line: line.id, patient: line.patient, step: line.step, who: line.who, mode: line.mode, did_by: didBy(line, DRIVER), text: line.text ?? null, heard: heard?.text ?? null, line_id: heard?.line_id ?? null, line_end_at: heard?.ended ?? lineEnd, verified, checks: outcomes, status, confirm: line.confirm ?? null, touches_during: touchAfter - touchBefore, errors: [...errors, ...outcomes.filter((c) => !c.ok && !c.optional).map((c) => `${Object.keys(c.expect)[0]}: ${c.detail}`)], started_at: started, ended_at: now() };
  steps.push(out);
  log(`${line.id} ${status.toUpperCase()} ${line.step} [${out.did_by.split(" (")[0]}] ${note ?? ""}`);
  for (const c of outcomes) log(`    ${c.ok ? "ok " : c.optional ? "opt" : "BAD"} ${JSON.stringify(c.expect).slice(0, 90)} -> ${c.detail}`);
  if (page && process.env["ACC_SHOTS"] !== "0") await page.screenshot({ path: join(OUT, `${line.id}.png`) }).catch(() => undefined);
  writeFileSync(join(OUT, "steps.json"), `${JSON.stringify(steps, null, 1)}\n`);
  if (STOP_ON_FAIL && status === "failed") throw new Error(`stopped at ${line.id}`);
}

// The lab scientist's result at her screen: the order and its case and specimen versions are read, then accession, collection and the result, each as her own door call.
async function labResult(vars: Record<string, string>): Promise<{ ok: boolean; note: string }> {
  const read = async () => (await hospital.query("acc_order_for_test", { visit: vars["visit"] ?? "", test: vars["test"] ?? "" }))[0] as Record<string, unknown> | undefined;
  const steps: string[] = [];
  const as = (o: Record<string, unknown>) => ({ order_id: String(o["order_id"]), case_version: Number(o["case_version"]), specimen_id: String(o["specimen_id"] ?? ""), specimen_version: Number(o["specimen_version"] ?? 0), raw_text: vars["raw_text"] ?? "ZZ-TEST result" }) as unknown as Record<string, string>;
  let o = await read();
  if (!o) return { ok: false, note: `no ${vars["test"]} order on the visit` };
  for (const [op, need] of [["acc_lab_accession", () => !o!["specimen_id"]], ["acc_lab_record", () => !["collected", "received", "in_process", "processed"].includes(String(o!["specimen_state"] ?? ""))], ["acc_lab_result_post", () => true]] as const) {
    if (!need()) continue;
    const r = await hospital.person(op, as(o));
    steps.push(`${op} ${r.status}${r.note ? ` ${r.note.slice(0, 120)}` : ""}`);
    if (!r.ok) return { ok: false, note: steps.join("; ") };
    o = (await read()) ?? o;
  }
  return { ok: true, note: steps.join("; ") };
}

// The lab scientist cancels the test on her own lab screen in a second Chrome window: Samuel's run asks her to, the rehearsal clicks it for her.
let labWindow: Page | null = null;
async function labCancelOnScreen(vars: Record<string, string>): Promise<{ ok: boolean; note: string }> {
  const o = (await hospital.query("acc_order_for_test", { visit: vars["visit"] ?? "", test: vars["test"] ?? "" }))[0];
  if (!o?.["order_id"]) return { ok: false, note: `no ${vars["test"]} order on the visit` };
  const url = `${APP}/lab/orders/${String(o["order_id"])}`;
  if (DRIVER === "human") {
    process.stdout.write(`\n  LAB STEP: in a second browser window, sign in as lab.grace and open ${url}; under "Cancel before testing" pick "Requester cancelled", tick the box, press Cancel diagnostic case. Press Enter here when done.\n`);
    await rl!.question("");
  } else if (process.env["ACC_LAB_CANCEL_SCRIPT"]) {
    // The lab screen does not offer the cancel on an arrival with no identifiers, so the rehearsal runs the lab's own action as lab.grace.
    const out = (() => { try { return execFileSync("/bin/bash", [process.env["ACC_LAB_CANCEL_SCRIPT"]!], { env: { ...process.env, ACC_CANCEL_CASE: String(o["case_id"]) }, encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return String((e as { stderr?: string }).stderr ?? e); } })();
    const line = /lab cancel: (.*)/.exec(out)?.[1] ?? out.slice(-200);
    const caseDone = (await hospital.query("acc_case_cancelled", { visit: vars["visit"] ?? "", test: vars["test"] ?? "" })).length > 0;
    return { ok: caseDone, note: `lab.grace's own cancel action: ${line.slice(0, 220)}` };
  } else {
    if (!labWindow || !browserNewContext) return { ok: false, note: "no browser for the lab screen" };
    const w = labWindow as unknown as { goto: (u: string, o?: unknown) => Promise<unknown>; locator: (s: string) => { first: () => { click: () => Promise<void>; selectOption: (v: string) => Promise<unknown>; check: () => Promise<void> } }; getByRole: (r: string, o: unknown) => { click: () => Promise<void> }; getByText: (t: string, o?: unknown) => { first: () => { click: () => Promise<void>; waitFor: (o?: unknown) => Promise<void> } } };
    try {
      await w.goto(url, { timeout: 120_000 });
      await w.getByText("Cancel before testing").first().click();
      await w.locator('select[name="reasonCode"]').first().selectOption("requester_cancelled");
      await w.locator('details input[type="checkbox"]').first().check();
      await w.getByRole("button", { name: "Cancel diagnostic case" }).click();
      await w.getByText("cancelled", { exact: false }).first().waitFor({ timeout: 30_000 });
    } catch (e) { return { ok: false, note: `lab screen: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}` }; }
  }
  const after = (await hospital.query("acc_order_cancelled", { visit: vars["visit"] ?? "", test: vars["test"] ?? "" })).length;
  return { ok: after > 0, note: `lab.grace cancelled the ${vars["test"]} on the lab screen${DRIVER === "human" ? " (a person)" : " (clicked by the harness for her)"}: ${after ? "cancelled" : "not cancelled"}` };
}
let browserNewContext: (() => Promise<unknown>) | null = null;

// The lab scientist cancels a never-started test at her own screen; the web offers this and the door does not, so the harness calls her server action under her own web session.
async function labCancel(vars: Record<string, string>): Promise<{ ok: boolean; note: string }> {
  const o = (await hospital.query("acc_order_for_test", { visit: vars["visit"] ?? "", test: vars["test"] ?? "" }))[0];
  if (!o?.["case_id"]) return { ok: false, note: `no ${vars["test"]} case on the visit` };
  const sb = SandboxBlock.parse(loadProfile().sandbox);
  const cookie = mintPersonCookie(sb, { login: env("ACC_LAB_LOGIN", "lab.grace") });
  const page = env("ACC_LAB_CANCEL_PAGE", "/lab/orders/{order_id}").replace("{order_id}", String(o["order_id"]));
  await fetch(`${APP}${page}`, { headers: { cookie } }).catch(() => undefined);
  const manifest = JSON.parse(readFileSync(env("ACC_ACTION_MANIFEST"), "utf8")) as { node: Record<string, unknown> };
  const id = Object.entries(manifest.node).find(([, v]) => JSON.stringify(v).includes(env("ACC_LAB_CANCEL_ACTION", "cancelNeverStartedDiagnosticCase")))?.[0];
  if (!id) return { ok: false, note: "the cancel action is not compiled into the app copy yet" };
  const body = [{ caseId: String(o["case_id"]), expectedVersion: Number(o["case_version"]), reasonCode: "requester_cancelled", idempotencyKey: `acc-cancel-${String(o["case_id"])}` }];
  const r = await fetch(`${APP}${page}`, { method: "POST", headers: { cookie, "next-action": id, "content-type": "text/plain;charset=UTF-8", origin: APP, accept: "text/x-component" }, body: JSON.stringify(body) });
  const text = await r.text();
  const ok = r.ok && /"success":true/.test(text);
  return { ok, note: `lab cancel ${r.status} ${ok ? "cancelled" : text.slice(0, 200)}` };
}

// Kills the serve while the named write is under way, then restarts it, and records whether the write ended verified once.
async function watchInterrupt(line: Line): Promise<void> {
  const kind = line.interrupt!.kind;
  const end = Date.now() + 120_000;
  const found = (vs: EmrTaskView[] | null) => (vs ?? []).flatMap((t) => t.actions.filter((a) => a.kind === kind && (a.state === "sent" || a.state === "acknowledged") && (!line.patient || t.patient_id === bound[line.patient]?.patient)).map((a) => ({ action_id: a.action_id, state: a.state })))[0] ?? null;
  let hit: { action_id: string; state: string } | null = null;
  while (Date.now() < end && !hit) {
    hit = found(await getJson<EmrTaskView[]>(`/tasks?owner=${DOCTOR}`));
    if (!hit) await wait(40);
  }
  if (!hit) { faults.push({ kind: "interrupt", line: line.id, at: now(), killed_during: null, restarted_in_ms: null, outcome: `no ${kind} write was seen under way`, ok: false }); return; }
  const at = now();
  const r = await restartServe("SIGKILL");
  log(`interrupt: killed the serve (pids ${r.pids.join(",")}) while ${kind} was ${hit.state}; back in ${r.ms} ms`);
  const done = Date.now() + 120_000;
  let final: string | null = null;
  while (Date.now() < done) { await pollOnce(); const a = allActions(DOCTOR).find((x) => x.action_id === hit!.action_id); final = a?.state ?? null; if (final === "completed" || final === "failed" || final === "refused") break; await wait(1000); }
  const same = allActions(DOCTOR).filter((a) => a.kind === kind && a.state === "completed" && (!line.patient || a.patient_id === bound[line.patient]?.patient));
  faults.push({ kind: "interrupt", line: line.id, at, killed_during: hit.state, restarted_in_ms: r.ms, outcome: `after restart the write is ${final ?? "gone"}; ${same.length} completed ${kind} for this patient`, ok: final === "completed" && same.length === 1 });
}

async function main(): Promise<void> {
  log(`acceptance ${KIND} run ${OUT}: driver ${DRIVER}, browser ${BROWSER}, serve ${SERVE}, script ${sha256.slice(0, 12)}`);
  // A serve already on the port holds another run's store, so the harness starts its own unless told to reuse that one.
  if ((await healthy(2000)) && process.env["ACC_REUSE_SERVE"] !== "1") throw new Error(`a serve is already listening on ${SERVE}; stop it by its port or set ACC_REUSE_SERVE=1`);
  if (!(await healthy(2000))) { startServe(); if (!(await healthy())) throw new Error(`the serve did not come up on ${SERVE}; see ${serveLog()}`); }
  if (DRIVER === "fake") buildFakeMic();
  if (BROWSER === "launch") await openBrowser();
  const only = process.env["ACC_ONLY"] ? new Set(process.env["ACC_ONLY"].split(",")) : null;
  for (const line of script.lines) {
    if (only && !only.has(line.id)) continue;
    if (DRIVER === "text" && line.mode === "play") { steps.push({ line: line.id, patient: line.patient, step: line.step, who: line.who, mode: line.mode, did_by: didBy(line, DRIVER), text: line.text ?? null, heard: null, line_id: null, line_end_at: null, verified: [], checks: [], status: "skipped", confirm: null, touches_during: 0, errors: ["needs audio"], started_at: now(), ended_at: now() }); continue; }
    await runLine(line);
  }
  await pollOnce();
  await finish();
}

async function finish(): Promise<void> {
  polling = false;
  const acts = allActions();
  const rows: SpeedRowIn[] = [...views.entries()].flatMap(([o, vs]) => vs.flatMap((t) => t.speed.rows.map((r) => ({ kind: r.kind, ms: r.ms, owner: whoOf(o), line_id: r.line_id, action_id: r.action_id, ...(r.from_record ? { from_record: true } : {}) }))));
  const errRows: SpeedErr[] = acts.filter((a) => a.state === "failed" || a.state === "refused" || a.unverified).map((a) => ({ kind: a.kind, owner: whoOf(a.owner), action_id: a.action_id, state: a.unverified ? "unverified" : a.state, reason: a.reason }));
  const wake = wakeRows().map((r) => r.latency_ms);
  const t = await touchesNow();
  let emr: number | null = t?.emr ?? null, strip: number | null = t?.strip ?? null;
  let source: AccResult["touches"]["source"] = t ? "strip counter read from the browser" : "not counted";
  if (!t && rl) { const a = await rl.question("  Read the strip's line 'Touches N · strip touches M' and type N M: "); const [x, y] = a.trim().split(/\s+/).map(Number); if (Number.isFinite(x)) { emr = x!; strip = Number.isFinite(y) ? y! : null; source = "strip counter read off the screen by a person"; } }
  const confirmations = steps.filter((s) => s.confirm === "r3").length;
  const stepWindow = (at: string | null) => steps.find((s) => at && at >= s.started_at && at <= s.ended_at);
  // Only the run's own two patients count: agents also work through tasks other runs left open in the sandbox, which no step of this script asked for.
  const ours = (a: (typeof acts)[number]) => (["A", "B"] as const).some((r) => bound[r] && (a.patient_id === bound[r]!.patient || bound[r]!.tasks.has(a.task_id)));
  const unaccounted = acts.filter((a) => a.state === "completed" && ours(a) && !stepWindow(seen.get(`${a.action_id}:completed`) ?? null)).map((a) => ({ owner: whoOf(a.owner), kind: a.kind, action_id: a.action_id, completed_at: seen.get(`${a.action_id}:completed`) ?? null }));
  const delegations: DelegationRow[] = (views.get(DOCTOR) ?? []).flatMap((v) => v.delegations).filter((d) => d.side === "delegator").map((d) => {
    const acks = acts.filter((a) => a.kind === "acknowledge_task" && a.state === "completed" && a.args["delegation_id"] === d.delegation_id);
    const ackLine = acks[0] ? transcriptLine(acks[0].line_id) : null;
    const completes = acts.filter((a) => a.kind === "complete_task" && a.state === "completed" && a.args["delegation_id"] === d.delegation_id);
    return { id: d.delegation_id ?? d.key, team: d.team ?? d.task_kind, acknowledged: !!d.acknowledged_at, acknowledged_by_voice: !!ackLine && ackLine.source === "audio", completed_from_record: !!d.completed_at && completes.length > 0, acknowledged_counted_as_done: !!d.acknowledged_at && !!d.completed_at && completes.length === 0 };
  });
  // A line acted on with the owner's authority is one that wrote an order or a countersign, or that authorised or confirmed any action.
  const AUTH = ["order_test", "prescribe", "countersign", "record_diagnosis", "release_home"];
  const speakers: SpeakerRow[] = steps.filter((s) => (s.mode === "speak" || s.mode === "play") && s.line_id).map((s) => {
    const l = transcriptLine(s.line_id);
    const written = acts.filter((a) => a.line_id === s.line_id && ["sent", "acknowledged", "completed"].includes(a.state));
    const authorised = acts.some((a) => a.authorised_by_line === s.line_id && ["sent", "acknowledged", "completed"].includes(a.state));
    return { line: s.line, who: s.who, heard_as: l?.speaker?.speaker ?? null, acted_as_owner: authorised || written.some((a) => AUTH.includes(a.kind)), order_written: written.some((a) => ["order_test", "prescribe"].includes(a.kind)) };
  });
  const signs = acts.filter((a) => a.kind === "countersign" && a.state === "completed");
  const signedIds = new Set(signs.flatMap((a) => ((a.args["item_ids"] as string[] | undefined) ?? [])));
  const firstBatch = new Set(((signs[0]?.args["item_ids"] as string[] | undefined) ?? []));
  const later = acts.filter((a) => a.kind === "prescribe" && a.state === "completed" && signs[0] && (seen.get(`${a.action_id}:completed`) ?? "") > (seen.get(`${signs[0].action_id}:completed`) ?? ""));
  const unmatchedOrders = acts.filter((a) => ["order_test", "prescribe"].includes(a.kind) && ["sent", "acknowledged", "completed"].includes(a.state) && transcriptLine(a.line_id)?.speaker?.speaker !== "owner" && !a.authorised_by_line);
  const usd = [...views.values()].flat().reduce((s, x) => s + x.usd, 0), calls = [...views.values()].flat().reduce((s, x) => s + x.calls, 0);
  const rateLimited = [...Array(restarts + 1).keys()].map((i) => join(OUT, `serve-${i}.log`)).filter(existsSync).reduce((n, f) => n + (readFileSync(f, "utf8").match(/\b429\b/g)?.length ?? 0), 0);
  const commit = (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "unknown"; } })();
  const result: AccResult = {
    measured_at: now(), run_id: OUT.split("/").filter(Boolean).at(-1)!, kind: KIND, driver: DRIVER, browser: page ? "launched" : "none", script_sha256: sha256, engine_commit: commit,
    pisgah: env("ACC_PISGAH_STATE", "Samuel's working tree, uncommitted, frozen by the coordinator for this run"),
    payment: "simulated: every payment is a cash entry the accounts person records on the door; no money moves and no provider is called",
    steps, touches: { emr, strip, source, by_line: Object.fromEntries(steps.filter((s) => s.touches_during).map((s) => [s.line, s.touches_during])), other_people: otherTouches },
    // The grant, each explicit confirmation (which the screen may give instead), and each attestation the doctor makes at the screen, such as signing the consultation.
    touches_allowed: 1 + confirmations + script.lines.filter((l) => l.who === "doctor" && l.mode === "person").length, confirmations_spoken: confirmations,
    speed: { rows, table: speedTable(rows, errRows, wake), wake_ms: wake }, errors: steps.flatMap((s) => s.errors.map((e) => `${s.line}: ${e}`)), error_rows: errRows,
    faults, delegations, speakers, unaccounted,
    countersign: { batches: signs.length, batch_orders: firstBatch.size, batch_signed_by_voice: signs.some((a) => transcriptLine(a.line_id)?.source === "audio"), changed_after_batch_unsigned: signs[0] ? later.every((a) => !firstBatch.has(a.proof?.record_id ?? "")) && later.length > 0 : null, unmatched_voice_orders: unmatchedOrders.length },
    model: { calls, usd: Number(usd.toFixed(4)), rate_limited: rateLimited },
    harness_errors: harnessErrors, completion: { complete: false, reasons: [] }
  };
  result.completion = completion(result, script.lines.filter((l) => l.mode === "fault" || l.interrupt).length + (PROXY_PORT ? script.lines.filter((l) => l.lose_ack).length : 0) + (page ? script.lines.filter((l) => l.offline_s || l.muted || (l.reload && (DRIVER !== "fake" || process.env["ACC_FAKE_RELOAD"] !== "0"))).length : 0));
  void signedIds;
  const root = KIND === "final" ? env("ACC_PUBLISH_ROOT") : OUT;
  const files = writeAccResults(root, result, { previews_with_names: Number(process.env["ACC_PREVIEWS_WITH_NAMES"] ?? "0"), privilege_gained: 0 });
  writeFileSync(join(OUT, "door-requests.json"), `${JSON.stringify(doorLog.map((r) => ({ at: r.at, path: r.path, status: r.status, ms: r.ms })), null, 1)}\n`);
  log(`complete: ${result.completion.complete ? "yes" : `no (${result.completion.reasons.length}: ${result.completion.reasons.slice(0, 6).join("; ")})`}; harness errors ${harnessErrors.length}`);
  log(`done: ${steps.filter((s) => s.status === "verified").length} verified, ${steps.filter((s) => s.status === "partial").length} partial, ${steps.filter((s) => s.status === "failed").length} failed, ${steps.filter((s) => s.status === "blocked").length} blocked of ${steps.length}; touches ${emr ?? "?"} (allowed ${result.touches_allowed}); calls ${calls} $${usd.toFixed(3)}; 429s ${rateLimited}`);
  log(`wrote ${files.join(", ")}`);
  rl?.close();
  if (browserClose) await browserClose();
}

main().catch(async (e: unknown) => { log(`harness error: ${e instanceof Error ? e.message : String(e)}`); await finish().catch(() => undefined); process.exit(1); });
