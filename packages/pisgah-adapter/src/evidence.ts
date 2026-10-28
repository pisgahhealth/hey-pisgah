import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { READ_ONLY_KINDS } from "@hey-pisgah/agent";
import { SimEvent } from "@hey-pisgah/contracts";
import { loadJourney } from "@hey-pisgah/evaluator";
import type { VersionsSpec } from "./profile.js";

// One journey run as an evidence case in the discovery pool's shape: case-local ids, two clocks, and only kinds, roles and numbers.
export type ObservedCase = {
  case_id: string; ward_id: string; payer_type: string; requirement_version: string;
  facts: Record<string, string | string[]>; events: SimEvent[];
  observed: { origin: "emr_journey"; mode: string; version: number | null; events: number };
};

type Env = { record_type: string; wall_at: string; payload: Record<string, unknown> };
type Trace = { trace: { mode: string; started_at: string; person: Record<string, { ok: boolean; at: string }>; owner_of: Record<string, string> }; records: Record<string, Record<string, unknown>[]> };

const LAGOS_OFFSET_MIN = 60;
const ROLE: Record<string, string> = { doctor: "doctor", nurse: "nurse", accounts: "accounts_clerk", reception: "reception" };
const h8 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);
const ms = (iso: string) => Date.parse(iso);

// Reads every task stream of a run, oldest first.
function streams(runDir: string): Env[][] {
  const dir = join(runDir, "store", "emr");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Env));
}

// When the EMR wrote each record: the row's own time, else the audit row for the line in order, else the triage time, else the agent's acknowledgement.
function emrTimes(records: Trace["records"]): { byId: Map<string, string>; triagedById: Map<string, string>; byEvidence: Map<string, string[]> } {
  const byId = new Map<string, string>(), triagedById = new Map<string, string>(), byEvidence = new Map<string, string[]>();
  for (const [k, rows] of Object.entries(records)) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (k === "provenance") {
        const ev = String(r["evidence"] ?? ""), at = String(r["recorded_at"] ?? "");
        if (ev && at) byEvidence.set(ev, [...(byEvidence.get(ev) ?? []), at].sort((a, b) => ms(a) - ms(b)));
        continue;
      }
      if (typeof r["id"] === "string" && typeof r["created_at"] === "string") byId.set(r["id"], r["created_at"]);
      if (typeof r["id"] === "string" && typeof r["triaged_at"] === "string") triagedById.set(r["id"], r["triaged_at"]);
    }
  }
  return { byId, triagedById, byEvidence };
}

// The step a watched fact's value shows, by the profile's counterparts read backwards, so no EMR value is kept.
const stepOf = (spec: VersionsSpec | null, fact: string, value: string | null): string | null =>
  spec && value !== null ? Object.entries(spec.steps).find(([, w]) => w.fact === fact && w.equals === value)?.[0] ?? null : null;

// Exports one run directory as an observed case; occurred_at is when the words were spoken and recorded_at when the EMR wrote the record.
export function exportJourneyRun(runDir: string, spec: VersionsSpec | null, facts: Record<string, string | string[]>): ObservedCase {
  const trace = JSON.parse(readFileSync(join(runDir, "trace.json"), "utf8")) as Trace;
  const caseId = `c-${h8(`observed:${basename(runDir)}:${trace.trace.started_at}`)}`;
  const day = new Date(ms(trace.trace.started_at) + LAGOS_OFFSET_MIN * 60_000);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - LAGOS_OFFSET_MIN * 60_000;
  const t0 = ms(trace.trace.started_at);
  const minute = (iso: string) => Math.max(0, Math.min(2880, Math.floor((ms(iso) - midnight) / 60_000)));
  const sec = (iso: string) => Math.round((ms(iso) - t0) / 100) / 10;
  const roleOfOwner = new Map(Object.entries(trace.trace.owner_of).map(([role, id]) => [id, role]));
  const times = emrTimes(trace.records ?? {});
  const rec = (id: string) => `rec-${h8(`${caseId}:${id}`)}`;
  const lineNo = new Map<string, number>(), actionNo = new Map<string, number>(), questionNo = new Map<string, number>();
  const num = (m: Map<string, number>, id: string) => { if (!m.has(id)) m.set(id, m.size + 1); return m.get(id)!; };
  type Raw = { at: number; kind: string; clock: "server" | "two_clock"; occurred: string; recorded: string; actor_id: string | null; actor_role: string | null; subject: string | null; payload: Record<string, unknown> };
  const raw: Raw[] = [];
  const add = (kind: string, occurred: string, recorded: string, actor: { id: string | null; role: string | null }, payload: Record<string, unknown>, subject: string | null = null) =>
    raw.push({ at: ms(recorded), kind, clock: occurred === recorded ? "server" : "two_clock", occurred, recorded, actor_id: actor.id, actor_role: actor.role, subject, payload: { ...payload, occurred_s: sec(occurred), recorded_s: sec(recorded) } });

  const script = loadJourney();
  for (const [id, p] of Object.entries(trace.trace.person ?? {})) {
    const st = script.steps.find((s) => s.id === id) as { person?: string; by?: string } | undefined;
    if (!p.ok || !st?.person) continue;
    const role = ROLE[st.by ?? ""] ?? "staff";
    add("person.acted", p.at, p.at, { id: `${role}_1`, role }, { step: id, act: st.person });
  }
  for (const env of streams(runDir)) {
    const opened = env.find((e) => e.record_type === "emr.task.opened");
    if (!opened) continue;
    const role = ROLE[roleOfOwner.get(String(opened.payload["owner"])) ?? ""] ?? "staff";
    const person = { id: `${role}_1`, role }, agent = { id: `${role}_1_agent`, role: "agent" };
    add("task.opened", opened.wall_at, opened.wall_at, agent, { for_role: role });
    const spoken = new Map<string, string>(), lineOf = new Map<string, string>(), kindOf = new Map<string, string>(), byLine = new Map<string, number>();
    let stage: string | null = null;
    for (const e of env) {
      const x = e.payload;
      switch (e.record_type) {
        case "utterance.heard": spoken.set(String(x["line_id"]), String(x["spoken_at"] ?? e.wall_at)); break;
        case "gate.decided": {
          const l = String(x["line_id"]), at = spoken.get(l) ?? e.wall_at;
          const clauses = (x["clauses"] as { class?: string; kind?: string | null }[] | undefined) ?? [];
          add("line.classed", at, e.wall_at, agent, { line: num(lineNo, `${role}:${l}`), classes: clauses.map((c) => String(c.class ?? "unknown")), kinds: clauses.map((c) => c.kind ?? null) });
          break;
        }
        case "gate.refused": add("instruction.refused", spoken.get(String(x["line_id"])) ?? e.wall_at, e.wall_at, agent, { line: num(lineNo, `${role}:${String(x["line_id"])}`), record_kind: (x["kind"] as string | null) ?? null }); break;
        case "action.proposed": lineOf.set(String(x["action_id"]), String(x["line_id"])); kindOf.set(String(x["action_id"]), String(x["kind"])); break;
        case "action.written": {
          const a = String(x["action_id"]), kind = kindOf.get(a) ?? "unknown", l = lineOf.get(a) ?? "";
          const said = spoken.get(l) ?? e.wall_at;
          const w = (x["written"] as { record_id?: string } | undefined) ?? {};
          const rid = String(w.record_id ?? "");
          if (READ_ONLY_KINDS.has(kind)) { add("report.prepared", said, e.wall_at, agent, { record_kind: kind, action: num(actionNo, `${role}:${a}`), line: num(lineNo, `${role}:${l}`) }); break; }
          const ev = `transcript:${l}`;
          const i = byLine.get(ev) ?? 0;
          byLine.set(ev, i + 1);
          const rows = times.byEvidence.get(ev) ?? [];
          const [at, source] = times.byId.has(rid) ? [times.byId.get(rid)!, "emr_row"] : rows[i] ? [rows[i]!, "emr_audit"] : times.triagedById.has(rid) && kind === "record_triage_vitals" ? [times.triagedById.get(rid)!, "emr_row"] : [e.wall_at, "agent_ack"];
          add("record.written", said, at, agent, { record_kind: kind, record: rec(rid), action: num(actionNo, `${role}:${a}`), line: num(lineNo, `${role}:${l}`), recorded_clock: source, on_behalf_of: person.id }, rec(rid));
          break;
        }
        case "action.completed": add("record.proved", e.wall_at, e.wall_at, agent, { action: num(actionNo, `${role}:${String(x["action_id"])}`), record_kind: kindOf.get(String(x["action_id"])) ?? "unknown" }); break;
        case "action.unverified": add("record.unverified", e.wall_at, e.wall_at, agent, { action: num(actionNo, `${role}:${String(x["action_id"])}`), record_kind: kindOf.get(String(x["action_id"])) ?? "unknown" }); break;
        case "action.refused": add("write.refused", spoken.get(lineOf.get(String(x["action_id"])) ?? "") ?? e.wall_at, e.wall_at, agent, { action: num(actionNo, `${role}:${String(x["action_id"])}`), record_kind: kindOf.get(String(x["action_id"])) ?? "unknown", status: (x["status"] as number | null) ?? null }); break;
        case "action.failed": add("write.failed", e.wall_at, e.wall_at, agent, { action: num(actionNo, `${role}:${String(x["action_id"])}`), record_kind: kindOf.get(String(x["action_id"])) ?? "unknown" }); break;
        case "action.cancelled": add("action.cancelled", e.wall_at, e.wall_at, agent, { action: num(actionNo, `${role}:${String(x["action_id"])}`) }); break;
        case "question.asked": add("question.asked", e.wall_at, e.wall_at, agent, { question: num(questionNo, `${role}:${String(x["question_id"])}`), from_watch: x["line_id"] === "watch" }); break;
        case "question.answered": add("question.answered", e.wall_at, e.wall_at, person, { question: num(questionNo, `${role}:${String(x["question_id"])}`) }); break;
        case "offer.made": add("offer.made", e.wall_at, e.wall_at, agent, { record_kind: String(x["offer"]).split(":").at(-1) ?? null, version: (x["version"] as number | undefined) ?? null }); break;
        case "version.rules": add("version.read", e.wall_at, e.wall_at, agent, { version: Number(x["version"]), offers: ((x["offers"] as unknown[]) ?? []).length, nothing_to_offer: ((x["lines"] as string[]) ?? []).some((s) => s.startsWith("Nothing to offer")) }); break;
        case "version.check_failed": add("version.check_failed", e.wall_at, e.wall_at, agent, { version: Number(x["version"]), requirement_version: String(x["requirement_version"]) }); break;
        case "task.paused": add("task.paused", e.wall_at, e.wall_at, agent, { pending: ((x["pending"] as unknown[]) ?? []).length }); break;
        case "task.resumed": add("task.resumed", e.wall_at, e.wall_at, agent, { pending: ((x["pending"] as unknown[]) ?? []).length, changed: ((x["changed"] as unknown[]) ?? []).length }); break;
        case "watch.changed": {
          for (const c of (x["changes"] as { fact: string; to: string | null }[] | undefined) ?? []) {
            const s = stepOf(spec, c.fact, c.to);
            if (s && s !== stage) { stage = s; add("step.observed", e.wall_at, e.wall_at, agent, { step_id: s }); }
          }
          break;
        }
        default: break;
      }
    }
  }
  raw.sort((a, b) => a.at - b.at || ms(a.occurred) - ms(b.occurred));
  const events = raw.map((r, i) => SimEvent.parse({
    event_id: `ev-${h8(`${caseId}:${i + 1}`)}`, seq: i + 1, case_id: caseId, kind: r.kind, clock: r.clock,
    occurred_at: minute(r.occurred), recorded_at: minute(r.recorded), late_entry_reason: null, actor_id: r.actor_id, actor_role: r.actor_role, subject: r.subject, payload: r.payload
  }));
  const versionRead = events.find((e) => e.kind === "version.read");
  return {
    case_id: caseId, ward_id: String(facts["ward_id"] ?? "A"), payer_type: String(facts["payer_type"] ?? "self_pay"), requirement_version: spec?.requirement_version ?? "r1", facts, events,
    observed: { origin: "emr_journey", mode: trace.trace.mode, version: versionRead ? Number((versionRead.payload as { version: number }).version) : null, events: events.length }
  };
}

// Every run directory under a folder that holds a task store and a trace.
export function journeyRunDirs(root: string): string[] {
  return readdirSync(root).map((d) => join(root, d)).filter((d) => existsSync(join(d, "trace.json")) && existsSync(join(d, "store", "emr"))).sort();
}

export const OBSERVED_ABOUT = "Journey runs on the EMR sandbox, read back as evidence cases. occurred_at is when the words were spoken; recorded_at is when the EMR wrote the record. Both are minutes from 00:00 Lagos on the run day; occurred_s and recorded_s in a payload are seconds from the case start. Ids are case-local; no text from the EMR is kept.";
export type ObservedFile = { schema: "hey-pisgah/observed-cases/1"; about: string; exported_at: string; cases: ObservedCase[] };
