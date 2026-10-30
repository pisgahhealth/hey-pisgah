import { createServer, type IncomingMessage } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadScript, type Expect, type Line, type Script } from "./acceptance.js";

// The in-memory hospital the acceptance harness tests itself against, which proves the harness and never the agent, since every record here is written from the script's own expectations.
export const FAKE_OWNERS: Record<string, { facilityUserId: string }> = {
  doctor: { facilityUserId: "fake-doctor" }, nurse: { facilityUserId: "fake-nurse" }, pharmacist: { facilityUserId: "fake-pharmacist" }, labTech: { facilityUserId: "fake-lab" },
  labHead: { facilityUserId: "fake-lab-head" }, surgeon: { facilityUserId: "fake-surgeon" }, reception: { facilityUserId: "fake-reception" }, accounts: { facilityUserId: "fake-accounts" }
};
const ROLE_OWNER: Record<string, string> = { doctor: "fake-doctor", nurse: "fake-nurse", pharmacist: "fake-pharmacist", lab: "fake-lab", surgeon: "fake-surgeon", reception: "fake-reception", accounts: "fake-accounts" };
const TEAM_ROLE: Record<string, string> = { front_desk: "reception", lab: "lab", pharmacy: "pharmacist", surgery: "surgeon" };
const ROLE_TEAM: Record<string, string> = Object.fromEntries(Object.entries(TEAM_ROLE).map(([t, r]) => [r, t]));
const VOICE_SPEAKER: Record<string, { speaker: string; label: string | null }> = { Rishi: { speaker: "owner", label: null }, Daniel: { speaker: "other_clinician", label: "Dr Ime" }, Samantha: { speaker: "unverified", label: null }, Moira: { speaker: "unverified", label: null } };

type Act = { action_id: string; kind: string; state: string; line_id: string; args: Record<string, unknown>; reason: string | null; awaiting?: string; authorised_by_line?: string; proof?: { record_id: string }; proposed_at: string; target: string };
type Task = {
  task_id: string; owner: string; patient_id: string | null; visit_id: string | null; admission_id: string; actions: Act[]; usd: number; calls: number;
  transcript: { id: string; line_id: string; text: string; at: string; source: string; class: string | null; classes: string[]; speaker?: { speaker: string; label: string | null }; ambient?: { ended_at: string } }[];
  questions: { question_id: string; text: string }[]; identities: { name: string; phone: string | null; state: string }[];
  delegations: { key: string; delegation_id: string; side: string; team: string; task_kind: string; assigned_at: string | null; acknowledged_at: string | null; completed_at: string | null }[];
  obligations: { title: string; state: string; after: string | null }[]; speed: { rows: { kind: string; ms: number; line_id: string; action_id: string }[] };
};
type State = { tasks: Task[]; tracking: Record<string, string | null>; refs: Record<string, string>; done: string[]; queries: Record<string, Record<string, unknown>[]>; n: number };

export async function startFakeHospital(o: { port: number; dir: string; script: Script; fail?: Set<string>; log?: (s: string) => void }): Promise<{ close: () => Promise<void> }> {
  const file = join(o.dir, "fake.json");
  mkdirSync(o.dir, { recursive: true });
  const st: State = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as State) : { tasks: [], tracking: {}, refs: {}, done: [], queries: {}, n: 0 };
  // Each change is written whole before it is answered, so a kill at any moment leaves the last answered state.
  const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify(st)); renameSync(`${file}.tmp`, file); };
  const now = () => new Date().toISOString();
  const id = (p: string) => `${p}-${(++st.n).toString(36)}`;
  const taskOf = (owner: string, ref: string | null): Task => {
    const patient = ref ? st.refs[ref] ?? null : null;
    let t = st.tasks.find((x) => x.owner === owner && x.patient_id === patient);
    if (!t) { t = { task_id: id("task"), owner, patient_id: patient, visit_id: patient ? `${patient}-visit` : null, admission_id: "", actions: [], transcript: [], questions: [], identities: [], delegations: [], obligations: [], speed: { rows: [] }, usd: 0, calls: 0 }; st.tasks.push(t); }
    return t;
  };
  // A write goes proposed, then sent, then completed and timed; a restart finishes any write a kill left sent, once.
  const write = (t: Task, kind: string, line: string, args: Record<string, unknown>, endAt: string, finalState = "completed") => {
    const a: Act = { action_id: id("act"), kind, state: "proposed", line_id: line, args, reason: null, proposed_at: now(), target: t.task_id };
    t.actions.push(a);
    save();
    if (finalState === "proposed") return a;
    setTimeout(() => { a.state = "sent"; save(); }, 300);
    setTimeout(() => complete(a, endAt), 1500);
    return a;
  };
  const complete = (a: Act, endAt: string) => {
    if (a.state === "completed") return;
    a.state = "completed"; a.proof = { record_id: id("rec") };
    const t = st.tasks.find((x) => x.task_id === a.target)!;
    t.speed.rows.push({ kind: a.kind, ms: Math.max(0, Date.now() - Date.parse(endAt)), line_id: a.line_id, action_id: a.action_id });
    if (a.kind === "admit_patient" && t.patient_id) for (const x of st.tasks.filter((y) => y.patient_id === t.patient_id)) x.admission_id = `${t.patient_id}-stay`;
    save();
  };
  for (const t of st.tasks) for (const a of t.actions) if (a.state === "sent") setTimeout(() => complete(a, a.proposed_at), 1000);

  const apply = (line: Line, lineId: string, endAt: string, voice: string | null) => {
    if (o.fail?.has(line.id)) { o.log?.(`fake: ${line.id} left without its record (negative control)`); return; }
    const ref = line.patient;
    const doc = () => taskOf("fake-doctor", ref);
    for (const e of line.expect as Expect[]) {
      if ("arrival" in e) { st.refs[e.arrival] = `fake-patient-${e.arrival}`; const t = doc(); write(t, "open_unnamed_encounter", lineId, {}, endAt); st.tracking["fake-doctor"] = st.refs[e.arrival]!; }
      else if ("identity" in e) doc().identities.push({ name: e.name, phone: null, state: "open" });
      else if ("act" in e) {
        const t = taskOf(e.owner ? ROLE_OWNER[e.owner]! : "fake-doctor", ref);
        const waiting = t.actions.filter((a) => a.kind === e.act && a.state === "proposed" && a.awaiting);
        if (waiting.length && e.state === "completed") { for (const a of waiting) { delete a.awaiting; a.authorised_by_line = lineId; complete(a, endAt); } continue; }
        // An acknowledgement names the oldest task handed to that person's team for this patient and marks it acknowledged, never done.
        if (e.act === "acknowledge_task" && e.owner) { const d = doc().delegations.find((x) => x.team === ROLE_TEAM[e.owner!] && !x.acknowledged_at); if (d) d.acknowledged_at = now(); write(t, e.act, lineId, { delegation_id: d?.delegation_id ?? null }, endAt); continue; }
        for (let i = 0; i < (e.n ?? 1) - (e.act === "countersign" ? t.actions.filter((a) => a.kind === "countersign" && a.state === "completed").length : 0); i++) {
          const a = write(t, e.act, lineId, { ...(e.values ?? {}), ...(e.act === "countersign" ? { item_ids: [`rx-${i}`] } : {}) }, endAt, e.state === "proposed" ? "proposed" : "completed");
          if (["order_test", "prescribe"].includes(e.act)) a.authorised_by_line = lineId;
        }
      } else if ("awaits" in e) { const a = write(doc(), e.awaits, lineId, {}, endAt, "proposed"); a.awaiting = "confirm"; }
      else if ("question" in e) doc().questions.push({ question_id: id("q"), text: `Read back: ${e.question}` });
      else if ("delegation" in e) {
        const t = doc();
        const mine = t.delegations.filter((d) => d.team === e.delegation.team);
        if (e.delegation.state === "acknowledged") mine.forEach((d) => (d.acknowledged_at ??= now()));
        else if (e.delegation.state === "completed") { for (const d of mine) { d.completed_at ??= now(); write(t, "complete_task", lineId, { delegation_id: d.delegation_id }, endAt); } }
        else for (let i = 0; i < (e.delegation.n ?? 1); i++) {
          const did = id("del");
          t.delegations.push({ key: did, delegation_id: did, side: "delegator", team: e.delegation.team, task_kind: e.delegation.team, assigned_at: now(), acknowledged_at: null, completed_at: null });
          const role = TEAM_ROLE[e.delegation.team];
          if (role) write(taskOf(ROLE_OWNER[role]!, ref), "nudge_owner", `rec-${did}`, { delegation_id: did }, endAt);
        }
      } else if ("obligation" in e) { const os = doc().obligations; const hit = os.find((x) => x.after === (e.obligation.after ?? null)); if (hit) hit.state = e.obligation.state; else os.push({ title: line.text ?? line.id, state: e.obligation.state, after: e.obligation.after ?? null }); }
      else if ("tracking" in e) st.tracking["fake-doctor"] = st.refs[e.tracking] ?? null;
      else if ("wake" in e) appendFileSync(join(o.dir, "wake.jsonl"), `${JSON.stringify({ at: now(), owner: "fake-doctor", keyword: "emergency", latency_ms: 420 })}\n`);
      else if ("query" in e) st.queries[`${e.query}:${JSON.stringify(e.vars)}`] = Array.from({ length: Math.max(1, e.rows_min ?? 1) }, () => ({ ...(e.match ?? {}), fake: true }));
      else if ("class" in e || "speaker" in e) { /* set on the transcript line below */ }
    }
    save();
  };
  // A heard or typed line becomes a transcript line on the owner's task, then the script line it matches is played.
  const heard = (owner: string, text: string, voice: string | null, source: "audio" | "text") => {
    const line = o.script.lines.find((l) => l.text === text && !st.done.includes(l.id));
    const ref = line?.patient ?? null;
    const t = taskOf(owner, ref ?? (owner === "fake-doctor" ? Object.entries(st.refs).find(([, p]) => p === st.tracking["fake-doctor"])?.[0] ?? null : null));
    const lineId = id("line");
    const cls = (line?.expect.find((e) => "class" in e) as { class: string } | undefined)?.class ?? (line?.who === "doctor" ? "instruction" : "aside");
    const at = now();
    if (line) { st.done.push(line.id); apply(line, lineId, at, voice); }
    const tt = line ? taskOf(owner, line.patient) : t;
    tt.transcript.push({ id: lineId, line_id: lineId, text, at, source, class: cls, classes: [cls], ...(voice ? { speaker: owner !== "fake-doctor" ? { speaker: "owner", label: null } : VOICE_SPEAKER[voice] ?? { speaker: "unverified", label: null } } : {}), ambient: { ended_at: at } });
    save();
    // Lines nobody says that follow this one are played two seconds later, as agents acting on the record would.
    if (line) followWaits(line);
    return { task_id: tt.task_id, line_id: lineId };
  };
  const followWaits = (after: Line) => {
    const i = o.script.lines.findIndex((l) => l.id === after.id);
    const next = o.script.lines[i + 1];
    if (next && next.mode === "wait" && !st.done.includes(next.id)) { st.done.push(next.id); setTimeout(() => { apply(next, id("line"), now(), null); save(); followWaits(next); }, 2000); }
  };
  const body = async (req: IncomingMessage): Promise<Buffer> => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c); };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const send = (s: number, v: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    void (async () => {
      if (url.pathname === "/health") return send(200, { ok: true, mode: "memory", tasks: st.tasks.length });
      if (url.pathname === "/tasks" && req.method === "GET") return send(200, st.tasks.filter((t) => t.owner === url.searchParams.get("owner")).map(({ ...t }) => t));
      if (url.pathname === "/tasks/tracking") { const p = st.tracking[url.searchParams.get("owner") ?? ""] ?? null; return send(200, { target: p ? { patient_id: p } : null }); }
      if (url.pathname === "/tasks/say" && req.method === "POST") { const b = JSON.parse((await body(req)).toString()) as { owner: string; text: string }; return send(202, heard(b.owner, b.text, null, "text")); }
      if (url.pathname === "/tasks/listen" && req.method === "POST") {
        const form = await new Response(new Uint8Array(await body(req)), { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
        if (form.get("end") === "1") return send(202, { accepted: true });
        return send(202, heard(String(form.get("owner")), String(form.get("acc_text") ?? ""), String(form.get("acc_voice") ?? "Rishi"), "audio"));
      }
      if (url.pathname === "/acc/query" && req.method === "POST") { const b = JSON.parse((await body(req)).toString()) as { name: string; vars: Record<string, string> }; const k = Object.keys(st.queries).find((x) => x.startsWith(`${b.name}:`)); return send(200, k ? st.queries[k] : []); }
      if (url.pathname === "/acc/person" && req.method === "POST") {
        const b = JSON.parse((await body(req)).toString()) as { op: string };
        const line = o.script.lines.find((l) => l.mode === "person" && l.op === b.op && !st.done.includes(l.id));
        if (!line) return send(404, { error: `no person step ${b.op} left` });
        st.done.push(line.id); apply(line, id("line"), now(), null); save(); followWaits(line);
        return send(200, { ok: true, bill: { outstandingNgn: "0.00" } });
      }
      return send(404, { error: "no such route" });
    })().catch((e: unknown) => send(500, { error: e instanceof Error ? e.message : String(e) }));
  });
  await new Promise<void>((r) => server.listen(o.port, "127.0.0.1", () => r()));
  o.log?.(`in-memory hospital on 127.0.0.1:${o.port}, ${st.tasks.length} tasks kept`);
  return { close: () => new Promise<void>((r) => server.close(() => r())) };
}

// Run as a process so the harness can kill it by port and start it again from its documented command.
if (process.argv[1]?.endsWith("acceptance.fake.ts")) {
  const port = Number(process.env["ACC_SERVE_PORT"] ?? 4131);
  const dir = join(process.env["ACC_OUT"] ?? ".", "store");
  const { script } = loadScript(process.env["ACC_SCRIPT"] ?? "");
  const fail = new Set((process.env["ACC_FAKE_FAIL"] ?? "").split(",").filter(Boolean));
  void startFakeHospital({ port, dir, script, fail, log: (s) => process.stdout.write(`${s}\n`) });
}
