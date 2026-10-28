import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startEmrServe, type EmrRuntime } from "@hey-pisgah/agent";
import { isTalk, journeyResults, loadJourney, type JAction, type JourneyResults, type JourneyScript, type JourneyTrace } from "@hey-pisgah/evaluator";
import { ModelClient } from "@hey-pisgah/model";
import { keyedGate, ledgerOf, recordedGate, runJourney, scriptKey, type PersonCall } from "./journey.js";
import { fillTemplate, loadProfile, type DoorProfile } from "./profile.js";
import { PisgahPort, type DoorLog } from "./port.js";
import { SandboxBlock, mintAgentBearer, mintPersonBearer, sandboxQuery } from "./sandbox.js";

type Seed = { patient: { patientId: string; aandeVisitId: string }; ward: { wardId: string; bedId: string }; owners: Record<"doctor" | "nurse" | "accounts", { facilityUserId: string; agentFacilityUserId: string; login: string }> };
export type SandboxJourney = { results: JourneyResults; trace: JourneyTrace; requests: DoorLog[]; records: Record<string, unknown>; recorded: Record<string, Record<string, unknown>[]>; serveLog: string[]; scrub: string[] };
// Kinds whose writes the record's audit trail carries, so each must show its provenance row.
export const AUDITED_KINDS = new Set(["record_observation", "add_care_plan_item", "record_note", "request_admission", "schedule_follow_up", "page_staff"]);

// A person's own call to the door for a step the agent never does; no agent headers, a fresh idempotency key per write.
function personCaller(profile: DoorProfile, sb: SandboxBlock, bearers: Map<string, string>, log: DoorLog[]): PersonCall {
  return async (op, vars) => {
    const spec = sb.person_ops[op];
    if (!spec) return { ok: false, status: null, json: null, note: `no person step ${op}` };
    let bearer = bearers.get(spec.login);
    if (!bearer) { bearer = mintPersonBearer(sb, { login: spec.login, ...(spec.clinic ? { clinic: spec.clinic } : {}) }); bearers.set(spec.login, bearer); }
    const path = spec.path.replace(/\$([a-z_]+)/g, (_m, k: string) => vars[k] ?? "");
    const body = spec.body ? fillTemplate(spec.body, vars) : undefined;
    const t0 = Date.now();
    const r = await fetch(`${profile.base_url.replace(/\/+$/, "")}/${path}`, {
      method: spec.method, headers: { authorization: `Bearer ${bearer}`, accept: "application/json", ...(body ? { "content-type": "application/json", [profile.headers.idempotency]: `person-${randomUUID()}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(profile.timeout_ms)
    });
    const text = await r.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    log.push({ at: new Date(t0).toISOString(), method: spec.method, path: `person:${op}`, status: r.status, ms: Date.now() - t0, replayed: false, headers: { authorization: "Bearer <person, redacted>" }, body: body ?? null, outcome: "response" });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json, ...(r.status >= 300 ? { note: text.slice(0, 200) } : {}) };
  };
}

// Runs the journey on the loopback sandbox: one agent bearer per owner, the person steps by the people's own bearers, then read-only record checks.
export async function runSandboxJourney(o: { mode: "live" | "mock"; port: number; recordingsDir?: string; storeRoot: string; holdMs?: number; watchMs?: number; log?: (s: string) => void }): Promise<SandboxJourney> {
  const profile = loadProfile();
  const sb = SandboxBlock.parse(profile.sandbox);
  if (!sb.journey_file) throw new Error("the profile's sandbox block names no journey file");
  const seed = JSON.parse(readFileSync(sb.journey_file, "utf8")) as Seed;
  const script: JourneyScript = loadJourney();
  const log = o.log ?? (() => {});
  const bearers: Record<string, string> = {};
  const first = mintAgentBearer(sb);
  bearers[first.owner] = first.bearer;
  for (const who of sb.owners) { const m = mintAgentBearer(sb, who); bearers[m.owner] = m.bearer; }
  const owners = { doctor: seed.owners.doctor.facilityUserId, nurse: seed.owners.nurse.facilityUserId, accounts: seed.owners.accounts.facilityUserId };
  for (const id of Object.values(owners)) if (!bearers[id]) throw new Error("an owner of the journey has no agent bearer");
  const requests: DoorLog[] = [];
  const port = new PisgahPort(profile, {
    bearers, onRequest: (l) => requests.push(l),
    episodeFor: async (admission) => String(sandboxQuery(sb, "episode_for_admission", { admission })[0]?.["id"] ?? "") || null
  });
  mkdirSync(o.storeRoot, { recursive: true });
  let rt: EmrRuntime | null = null;
  const client = o.mode === "live"
    ? new ModelClient({ storeRoot: o.storeRoot, mode: "live", ...(o.recordingsDir ? { recordingsDir: o.recordingsDir } : {}), taskStateOf: (id) => rt?.stateOf(id) ?? null })
    : new ModelClient({ storeRoot: o.storeRoot, mode: "mock", mock: keyedGate(scriptKey(script)), taskStateOf: (id) => rt?.stateOf(id) ?? null });
  const serveLog: string[] = [];
  const s = await startEmrServe({ storeRoot: o.storeRoot, port, client, listenPort: o.port, runtime: { holdMs: o.holdMs ?? 4000, proofRetryMs: 1500, watchMs: o.watchMs ?? 3000 }, log: (l) => serveLog.push(l) });
  rt = s.runtime;
  const personBearers = new Map<string, string>();
  const startedAt = new Date(Date.now() - 2000).toISOString();
  try {
    const trace = await runJourney({
      script, serveUrl: s.url, mode: o.mode, owners, seed: { patient_id: seed.patient.patientId, visit_id: seed.patient.aandeVisitId, ward_id: seed.ward.wardId, bed_id: seed.ward.bedId },
      person: personCaller(profile, sb, personBearers, requests), ledger: () => ledgerOf(s.runtime, o.storeRoot),
      refusals: () => ({ prohibited: port.refusals.filter((r) => r.reason === "denied_path" || r.reason === "not_allowlisted" || r.reason === "kind_not_held").length, door: requests.filter((r) => r.outcome === "response" && (r.status ?? 0) === 403).length }),
      settleMs: 6 * 60_000, offerMs: 40_000, log
    });
    const records = checkRecords(sb, script, trace, seed, startedAt);
    trace.records = records.by_step;
    return { results: journeyResults(script, trace), trace, requests, records: records.rows, recorded: recordedGate(s.runtime, o.storeRoot, script), serveLog, scrub: sb.scrub };
  } finally {
    await s.close();
  }
}

// Read-only checks that each agent write is in the record under the owner's agent, with provenance naming the owner.
function checkRecords(sb: SandboxBlock, script: JourneyScript, t: JourneyTrace, seed: Seed, since: string): { by_step: Record<string, { ok: boolean; why?: string }>; rows: Record<string, unknown> } {
  const agentOf: Record<string, string> = Object.fromEntries(Object.values(seed.owners).map((x) => [x.facilityUserId, x.agentFacilityUserId]));
  const q = (name: string, vars: Record<string, string>) => { try { return sandboxQuery(sb, name, vars); } catch (e) { return [{ error: e instanceof Error ? e.message.slice(0, 160) : "query failed" }]; } };
  const prov = q("provenance_since", { since });
  const admission = t.views.find((v) => v.admission_id)?.admission_id ?? "";
  const rows: Record<string, unknown> = { provenance: prov, admission: admission ? q("admission", { id: admission }) : [], visit: q("visit", { id: seed.patient.aandeVisitId }),
    notes: admission ? q("notes", { admission }) : [], care_items: admission ? q("care_items", { admission }) : [], pages: q("pages_since", { patient: seed.patient.patientId, since }),
    appointments: q("appointments", { visit: seed.patient.aandeVisitId }), observations: admission ? q("observations_for", { admission }) : [] };
  const by: Record<string, { ok: boolean; why?: string }> = {};
  for (const st of script.steps.filter(isTalk)) {
    const l = t.lines[st.id];
    if (!l) continue;
    const acts: JAction[] = t.views.flatMap((v) => v.actions).filter((a) => a.line_id === l.line_id && (a.state === "completed" || (a.state === "acknowledged" && a.unverified === true)));
    const agent = agentOf[l.owner] ?? "";
    const why: string[] = [];
    const mine = (prov as Record<string, unknown>[]).filter((p) => p["evidence"] === `transcript:${l.line_id}`);
    for (const p of mine) if (p["on_behalf_of"] !== l.owner || p["agent"] !== agent || p["actor"] !== agent || p["origin"] !== "voice") why.push(`provenance ${String(p["action_type"])} names the wrong owner or agent`);
    for (const a of acts) {
      const rid = a.proof?.record_id ?? "";
      if (AUDITED_KINDS.has(a.kind) && !mine.length) why.push(`no provenance row for ${a.kind}`);
      if (a.kind === "record_observation") { const r = q("observation", { id: rid })[0]; if (!r || r["recorded_by"] !== agent) why.push("observation not by the owner's agent"); }
      if (a.kind === "record_note") { const r = (rows["notes"] as Record<string, unknown>[]).find((x) => x["id"] === rid); if (!r || r["author"] !== agent) why.push("note not by the owner's agent"); }
      if (a.kind === "request_admission") { const r = (rows["admission"] as Record<string, unknown>[])[0]; if (!r || r["requested_by"] !== agent) why.push("admission not requested by the owner's agent"); }
      // Titles are encrypted at rest, so the check counts the owner's agent's items instead of reading them.
      if (a.kind === "add_care_plan_item") { const mineItems = (rows["care_items"] as Record<string, unknown>[]).filter((x) => x["created_by"] === agent).length; const want = acts.filter((x) => x.kind === "add_care_plan_item").length; if (mineItems < want) why.push(`${mineItems} care-plan items by the owner's agent, expected ${want}`); }
      if (a.kind === "page_staff") { if (!(rows["pages"] as Record<string, unknown>[]).some((x) => x["id"] === rid && x["sender"] === agent)) why.push("page not sent by the owner's agent"); }
      if (a.kind === "draft_consult_note") { const r = (rows["visit"] as Record<string, unknown>[])[0]; if (!r || r["draft_updated_by"] !== agent) why.push("draft not saved by the owner's agent"); }
      if (a.kind === "record_triage_vitals") { const r = (rows["visit"] as Record<string, unknown>[])[0]; if (!r || !r["triaged_at"] || (a.args["pulse"] !== undefined && r["pulse"] !== a.args["pulse"])) why.push("triage not in the visit"); }
      if (a.kind === "send_pay_link" && admission) { if (!q("pay_link_events", { admission }).some((x) => x["actor_id"] === agent)) why.push("no pay-link event by the owner's agent"); }
      if (a.kind === "schedule_follow_up") { if (!(rows["appointments"] as Record<string, unknown>[]).some((x) => x["booked_by"] === agent)) why.push("follow-up not booked by the owner's agent"); }
    }
    by[st.id] = why.length ? { ok: false, why: why.join("; ") } : { ok: true };
  }
  return { by_step: by, rows };
}

// Ids, the profile's private words and the place of the bed are kept out of anything public.
export const publicText = (v: unknown, scrub: readonly string[] = []): unknown => {
  let s = JSON.stringify(v).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>").replace(/\b(ward|bed) [^;."]* to [^;."]*[;.]? ?/g, "");
  for (const w of scrub) s = s.split(w).join("");
  return JSON.parse(s);
};

// Writes the private trace with every id, and the public results with none.
export function writeJourneyFiles(r: SandboxJourney, privateDir: string, resultsFile: string | null, recordedFile: string | null, scrub: readonly string[] = []): void {
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(join(privateDir, "trace.json"), `${JSON.stringify({ trace: r.trace, requests: r.requests, records: r.records, serveLog: r.serveLog }, null, 1)}\n`);
  writeFileSync(join(privateDir, "results.json"), `${JSON.stringify(r.results, null, 1)}\n`);
  if (resultsFile) writeFileSync(resultsFile, `${JSON.stringify(publicText(r.results, scrub), null, 1)}\n`);
  if (recordedFile) writeFileSync(recordedFile, `${JSON.stringify(publicText({ schema: "hey-pisgah/journey-gate/1", journey_id: r.results.journey_id, mode: r.results.mode, by_text: r.recorded }, scrub), null, 1)}\n`);
}
