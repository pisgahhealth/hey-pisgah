import type { EmrRuntime } from "@hey-pisgah/agent";
import type { LedgerRow } from "@hey-pisgah/contracts";
import { isTalk, type JView, type JourneyScript, type JourneyTrace, type TalkStep } from "@hey-pisgah/evaluator";
import type { ChatCompletion, MockResponder } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";

// What a person step needs from the run so far, and what it returns; the person's own bearer is the caller's business.
export type PersonCall = (op: string, vars: Record<string, string>) => Promise<{ ok: boolean; status: number | null; json: unknown; note?: string }>;
export type JourneyRunOptions = {
  script: JourneyScript; serveUrl: string; mode: JourneyTrace["mode"];
  // Owner ids by role, and the seeded ids the person steps use.
  owners: Record<"doctor" | "nurse" | "accounts", string>;
  seed: { patient_id: string; visit_id: string; ward_id?: string; bed_id?: string };
  person: PersonCall;
  ledger: () => JourneyTrace["ledger"];
  refusals: () => { prohibited: number; door: number };
  settleMs?: number; offerMs?: number; log?: (s: string) => void;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OPEN = new Set(["proposed", "sent", "acknowledged"]);

// Plays the journey script into serve step by step: talk lines go to each owner's task, person steps go to the person's own door, and each step waits for its outcome.
export async function runJourney(o: JourneyRunOptions): Promise<JourneyTrace> {
  const started = new Date().toISOString();
  const log = o.log ?? (() => {});
  const lines: JourneyTrace["lines"] = {};
  const person: JourneyTrace["person"] = {};
  let admission: string | null = null;
  const views = async (owner: string): Promise<JView[]> => (await (await fetch(`${o.serveUrl}/tasks?owner=${encodeURIComponent(owner)}`)).json()) as JView[];
  const viewOf = async (owner: string, taskId: string) => (await views(owner)).find((v) => v.task_id === taskId) ?? null;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${o.serveUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const until = async <T>(f: () => Promise<T | null | undefined | false>, ms: number, step = 250): Promise<T | null> => {
    const end = Date.now() + ms;
    for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) return null; await wait(step); }
  };
  const settled = (lineId: string) => (v: JView | null) => {
    if (!v) return false;
    const line = v.transcript.find((x) => x.line_id === lineId);
    return !!line && line.decided !== false && !v.actions.some((a) => OPEN.has(a.state)) && v.state !== "running";
  };
  const vars = (): Record<string, string> => ({
    patient_id: o.seed.patient_id, visit_id: o.seed.visit_id, ...(o.seed.ward_id ? { ward_id: o.seed.ward_id } : {}), ...(o.seed.bed_id ? { bed_id: o.seed.bed_id } : {}), ...(admission ? { admission_id: admission } : {})
  });

  for (const st of o.script.steps) {
    if (!isTalk(st)) {
      const at = new Date().toISOString();
      if (st.person === "registered") { person[st.id] = { ok: true, status: null, at, note: "done by the seed" }; continue; }
      if (st.person === "open_bill") {
        if (!admission) { person[st.id] = { ok: false, status: null, at, note: "no admission yet" }; continue; }
        const r = await post("/tasks/watch", { owner: o.owners.accounts, admissionId: admission });
        person[st.id] = { ok: r.status === 200, status: r.status, at };
        const taskId = String(r.body["task_id"] ?? "");
        await until(async () => (await viewOf(o.owners.accounts, taskId))?.asked.length, o.offerMs ?? 30_000, 500);
        continue;
      }
      if (st.person === "settle") {
        const bill = await o.person("bill", vars());
        const outstanding = String((bill.json as { bill?: { outstandingNgn?: string } } | null)?.bill?.outstandingNgn ?? "");
        const r = outstanding && Number(outstanding) > 0 ? await o.person("settle", { ...vars(), outstanding }) : { ok: false, status: null, json: null, note: `nothing outstanding to settle (${outstanding || "no bill"})` };
        person[st.id] = { ok: r.ok, status: r.status, at, ...(r.note ? { note: r.note } : {}) };
        log(`person ${st.id} ${st.person}: ${r.status ?? r.note}`);
        continue;
      }
      const r = await o.person(st.person, vars());
      person[st.id] = { ok: r.ok, status: r.status, at, ...(r.note ? { note: r.note } : {}) };
      log(`person ${st.id} ${st.person}: ${r.status ?? ""} ${r.note ?? ""}`);
      continue;
    }
    const owner = o.owners[st.owner];
    const target = st.at === "admission" && admission ? { admissionId: admission } : { patientId: o.seed.patient_id };
    const r = await post("/tasks/say", { owner, ...target, text: st.say, via: "gate" });
    if (r.status !== 202) { log(`say ${st.id} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`); continue; }
    const taskId = String(r.body["task_id"]), lineId = String(r.body["line_id"]);
    let v = await viewOf(owner, taskId);
    const heard = v?.transcript.find((x) => x.line_id === lineId)?.at ?? new Date().toISOString();
    if (st.pause || st.while_paused) {
      lines[st.id] = { owner, task_id: taskId, line_id: lineId, heard_at: heard, state_after: v?.state ?? null, reason_after: v?.reason ?? null };
      log(`${st.id} ${st.owner}: ${v?.state} ${v?.reason ?? ""}`);
      continue;
    }
    if (st.held) {
      // The held line must still be on hold when the pause arrives, so the next step goes as soon as its action is proposed.
      v = await until(async () => { const x = await viewOf(owner, taskId); return x && (x.actions.some((a) => a.line_id === lineId) || x.state !== "running") ? x : null; }, o.settleMs ?? 120_000, 100);
    } else {
      v = await until(async () => { const x = await viewOf(owner, taskId); return settled(lineId)(x) ? x : null; }, o.settleMs ?? 120_000);
    }
    lines[st.id] = { owner, task_id: taskId, line_id: lineId, heard_at: heard, state_after: v?.state ?? null, reason_after: v?.reason ?? null };
    if (!admission && v?.admission_id) admission = v.admission_id;
    log(`${st.id} ${st.owner}: ${v?.state} ${(v?.actions ?? []).filter((a) => a.line_id === lineId).map((a) => `${a.kind}:${a.state}`).join(" ")}`);
  }
  // A few watch reads after the last step, so each agent sees the settled record.
  await wait(o.offerMs ? Math.min(o.offerMs, 8000) : 8000);
  const all: JView[] = [];
  for (const owner of new Set(Object.values(o.owners))) all.push(...(await views(owner)));
  const ref = o.refusals();
  return {
    mode: o.mode, started_at: started, finished_at: new Date().toISOString(), lines, person, views: all, owner_of: { ...o.owners },
    ledger: o.ledger(), prohibited_attempts: ref.prohibited, door_refusals: ref.door
  };
}

export const talkSteps = (s: JourneyScript): TalkStep[] => s.steps.filter(isTalk);

// Every model call the runtime's tasks made, from the ledger streams, for the trace.
export function ledgerOf(rt: EmrRuntime, root: string): JourneyTrace["ledger"] {
  return rt.taskIds().flatMap((id) => {
    const t = rt.task(id);
    if (!t) return [];
    return readStream(root, `ledger/${t.run_id}`).filter((e) => e.record_type === "model.call").map((e) => {
      const r = e.payload as LedgerRow;
      return { at: r.at_wall, task_id: id, task_state: r.task_state ?? "none", cost_usd: r.cost_usd, provider: r.provider, effort: r.effort };
    });
  }).sort((a, b) => (a.at < b.at ? -1 : 1));
}

// A mock gate that answers each line with clauses keyed by its words: the script's own key for a dry run, or clauses recorded from a live run for a replay.
export function keyedGate(byText: Record<string, Record<string, unknown>[]>): MockResponder {
  return ({ body, hash }) => {
    const msgs = body["messages"] as { role: string; content: string }[];
    const user = String(msgs.find((m) => m.role === "user")?.content ?? "");
    const said = JSON.parse(/clinician_said: (".*")$/m.exec(user)?.[1] ?? '""') as string;
    const clauses = (byText[said] ?? [{ class: "aside" }]).map((c) => ({ words: said, ...c }));
    const c: ChatCompletion = {
      id: `mock-${hash.slice(0, 12)}`, object: "chat.completion", created: 0, model: String(body["model"]),
      choices: [{ index: 0, finish_reason: "tool_calls", logprobs: null, message: { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "gate", arguments: JSON.stringify({ clauses }) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    };
    return c;
  };
}

// The script's keyed clauses by line text.
export const scriptKey = (s: JourneyScript): Record<string, Record<string, unknown>[]> => Object.fromEntries(s.steps.filter(isTalk).filter((t) => t.key.length).map((t) => [t.say, t.key]));

// The clauses the live gate gave for each script line, read from the task streams, so a replay can play the same answers.
export function recordedGate(rt: EmrRuntime, root: string, s: JourneyScript): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  const says = new Set(s.steps.filter(isTalk).map((t) => t.say));
  for (const id of rt.taskIds()) {
    const recs = readStream(root, `emr/${id}`);
    const text = new Map(recs.filter((e) => e.record_type === "utterance.heard").map((e) => [String((e.payload as Record<string, unknown>)["line_id"]), String((e.payload as Record<string, unknown>)["text"])]));
    for (const e of recs.filter((x) => x.record_type === "gate.decided")) {
      const p = e.payload as { line_id: string; clauses: Record<string, unknown>[]; outside_line?: Record<string, unknown>[] };
      const said = text.get(p.line_id);
      if (said && says.has(said)) out[said] = [...p.clauses, ...(p.outside_line ?? [])].map((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null && v !== undefined)));
    }
  }
  return out;
}
