import { canonical, sha256 } from "@hey-pisgah/contracts";
import {
  EMERGENCY_KIND, EmrId, EmrPortError, OBSERVATION_KIND, ObservationArgs, READ_ONLY_KINDS,
  type EmrCommit, type EmrContext, type EmrPort, type EmrProof, type EmrTarget, type EmrWriteKind, type InboxPage, type Provenance,
  type SayableNames, type WatchOffer, type WatchRead, type WorkArgs
} from "@hey-pisgah/agent";
import { fillPath, fillTemplate, pathPattern, pick, type DoorProfile } from "./profile.js";

const EVIDENCE = /^[A-Za-z0-9_.:#/-]{1,200}$/;
const QUERY_VALUE = /^[A-Za-z0-9_.:|-]{1,80}$/;
const IDEM = /^[A-Za-z0-9_.:-]{1,255}$/;

export type DoorLog = {
  at: string; method: string; path: string; status: number | null; ms: number; replayed: boolean;
  headers: Record<string, string>; body: unknown; outcome: "response" | "refused" | "network_error"; reason?: string;
};
export type Refusal = { at: string; method: string; path: string; reason: "denied_path" | "not_allowlisted" | "no_bearer_for_owner" | "bad_header" | "kind_not_held" };
type DoorResult =
  | { kind: "refused"; reason: Refusal["reason"] }
  | { kind: "network_error"; reason: string }
  | { kind: "response"; status: number; json: unknown; replayed: boolean };

export type PisgahPortOptions = {
  // One agent bearer per owner; the door refuses a header that names anyone but the bearer's owner.
  bearers: Record<string, string>;
  fetch?: typeof fetch;
  onRequest?: (log: DoorLog) => void;
  // Finds the care episode of an admission the profile does not list; the door has no read that returns it.
  episodeFor?: (admissionId: string) => Promise<string | null>;
  now?: () => Date;
};

const same = (a: unknown, b: unknown): boolean => {
  if (a === undefined || a === null) return false;
  const na = Number(a), nb = Number(b);
  if (typeof b === "number" || (typeof b === "string" && /^\d+(\.\d+)?$/.test(b))) return Number.isFinite(na) && na === nb;
  return String(a).replace(/\s+/g, "") === String(b).replace(/\s+/g, "");
};

type Vars = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v).slice(0, 300) : String(v).slice(0, 300));

// The hospital port over the platform's agent door: every call carries the agent bearer and the provenance headers, and only allowlisted routes are ever called.
export class PisgahPort implements EmrPort {
  readonly writeKinds = [OBSERVATION_KIND] as const;
  readonly refusals: Refusal[] = [];
  private readonly allow: { method: string; re: RegExp }[];
  // Ids the door gave back, so a patient's later words reach the admission and arrival the agent saw.
  private readonly learned = { admission_by_patient: new Map<string, string>(), visit_by_patient: new Map<string, string>(), patient_by_admission: new Map<string, string>(), label: new Map<string, string>() };

  constructor(readonly profile: DoorProfile, private readonly o: PisgahPortOptions) {
    const ops = profile.ops;
    const reads = [
      ...(ops.patient_context ? [ops.patient_context.path] : []), ...profile.owners.flatMap((o) => (o.context ? [o.context.path] : [])), ...Object.values(profile.watches).map((w) => w.path),
      ...(profile.inbox ? [profile.inbox.path, ...(profile.inbox.detail ? [profile.inbox.detail.path] : [])] : []),
      ...Object.values(profile.work).flatMap((w) => ("reads" in w ? Object.values(w.reads).map((r) => r.path) : [...(w.proof ? [w.proof.path] : []), ...(w.before ?? []).map((b) => b.path)]))
    ];
    const writes = Object.values(profile.work).flatMap((w) => ("method" in w ? [w.path] : []));
    this.allow = [
      ops.read_admission, ops.write_observation, ...(ops.census ? [ops.census] : []),
      ...reads.map((path) => ({ method: "GET", path })), ...writes.map((path) => ({ method: "POST", path }))
    ].map((x) => ({ method: x.method, re: pathPattern(x.path) }));
    for (const a of this.allow) for (const d of [...profile.deny, ...profile.deny_exact]) if (a.re.test(d)) throw new Error("the profile allows a denied path");
  }

  kindsFor(owner: string): readonly EmrWriteKind[] {
    return this.profile.owners.find((x) => x.id === owner)?.kinds ?? this.writeKinds;
  }
  offers(owner: string): readonly WatchOffer[] { return this.profile.owners.find((x) => x.id === owner)?.offers ?? []; }
  unverifiable(kind: EmrWriteKind): string | null {
    const w = this.profile.work[kind];
    return w && "method" in w ? w.unverifiable ?? null : null;
  }
  screenPage(owner: string, kind: EmrWriteKind): string | undefined { return this.profile.owners.find((x) => x.id === owner)?.screens[kind]; }
  pageHref(page: string): string | undefined { return (this.profile.pages as Record<string, string>)[page]; }
  names(): SayableNames {
    return {
      page_targets: Object.fromEntries(Object.entries(this.profile.page_targets).map(([k, v]) => [k, v.words])),
      clinics: Object.fromEntries(Object.entries(this.profile.clinics).map(([k, v]) => [k, v.words]))
    };
  }

  refusedCount(): number { return this.refusals.length; }
  private now(): Date { return this.o.now?.() ?? new Date(); }

  private refuse(method: string, path: string, reason: Refusal["reason"]): DoorResult {
    this.refusals.push({ at: this.now().toISOString(), method, path, reason });
    this.o.onRequest?.({ at: this.now().toISOString(), method, path, status: null, ms: 0, replayed: false, headers: {}, body: null, outcome: "refused", reason });
    return { kind: "refused", reason };
  }

  // The only function that reaches the network: deny list first, then the allowlist, then the bearer for the named owner.
  async request(method: "GET" | "POST", path: string, prov: Provenance, init: { body?: unknown; idempotencyKey?: string; query?: Record<string, string> } = {}): Promise<DoorResult> {
    const clean = path.replace(/^\/+|\/+$/g, "");
    if (this.profile.deny.some((d) => clean === d || clean.startsWith(`${d}/`)) || this.profile.deny_exact.includes(clean)) return this.refuse(method, clean, "denied_path");
    if (!this.allow.some((a) => a.method === method && a.re.test(clean))) return this.refuse(method, clean, "not_allowlisted");
    const query = Object.entries(init.query ?? {});
    if (query.some(([k, v]) => !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k) || !QUERY_VALUE.test(v))) return this.refuse(method, clean, "bad_header");
    const qs = query.length ? `?${new URLSearchParams(query).toString()}` : "";
    const bearer = this.o.bearers[prov.owner];
    if (!bearer) return this.refuse(method, clean, "no_bearer_for_owner");
    if (!EVIDENCE.test(prov.evidence) || Number.isNaN(Date.parse(prov.spoken_at)) || (init.idempotencyKey !== undefined && !IDEM.test(init.idempotencyKey))) return this.refuse(method, clean, "bad_header");
    const h = this.profile.headers;
    const shown: Record<string, string> = {
      [h.on_behalf_of]: prov.owner, [h.origin]: this.profile.origin_value, [h.evidence]: prov.evidence, [h.spoken_at]: prov.spoken_at,
      ...(init.idempotencyKey ? { [h.idempotency]: init.idempotencyKey } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}), accept: "application/json"
    };
    const t0 = performance.now();
    const at = this.now().toISOString();
    const log = (status: number | null, replayed: boolean, outcome: DoorLog["outcome"], reason?: string) =>
      this.o.onRequest?.({ at, method, path: clean, status, ms: Math.round(performance.now() - t0), replayed, headers: { authorization: "Bearer <redacted>", ...shown }, body: init.body ?? null, outcome, ...(reason ? { reason } : {}) });
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(`${this.profile.base_url.replace(/\/+$/, "")}/${clean}${qs}`, {
        method, headers: { authorization: `Bearer ${bearer}`, ...shown }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(this.profile.timeout_ms)
      });
    } catch (e) {
      const reason = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "unreachable";
      log(null, false, "network_error", reason);
      return { kind: "network_error", reason };
    }
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    const replayed = (res.headers.get(h.replayed) ?? "").toLowerCase() === "true";
    // A refused write keeps the door's own words in the log, for the private trace only.
    log(res.status, replayed, "response", res.status >= 300 ? text.slice(0, 300) : undefined);
    return { kind: "response", status: res.status, json: body, replayed };
  }

  private admissionFor(target: EmrTarget): string {
    const id = this.admissionOf(target);
    if (!id) throw new EmrPortError("unknown_target", "no admission is known for that patient");
    return id;
  }
  private admissionOf(target: EmrTarget): string | null {
    return target.admission_id || (target.patient_id ? this.profile.targets.admission_by_patient[target.patient_id] ?? this.learned.admission_by_patient.get(target.patient_id) : undefined) || null;
  }

  private async readAdmission(admissionId: string, prov: Provenance): Promise<unknown> {
    const op = this.profile.ops.read_admission;
    const r = await this.request(op.method, fillPath(op.path, { admission_id: admissionId }), prov);
    if (r.kind === "refused") throw new EmrPortError(r.reason, "the port refused the read");
    if (r.kind === "network_error") throw new EmrPortError(r.reason, "the hospital door could not be reached", null);
    if (r.status < 200 || r.status > 299) throw new EmrPortError("read_failed", `the hospital door answered ${r.status}`, r.status);
    return r.json;
  }

  // Current inpatients from the census read, newest first as the door lists them.
  async census(prov: Provenance): Promise<{ admission_id: string; label: string }[]> {
    const op = this.profile.ops.census;
    if (!op) throw new EmrPortError("no_census", "the profile has no census read");
    const r = await this.request(op.method, op.path, prov);
    if (r.kind !== "response") throw new EmrPortError(r.reason, "the census read did not complete");
    if (r.status < 200 || r.status > 299) throw new EmrPortError("read_failed", `the hospital door answered ${r.status}`, r.status);
    const list = pick(r.json, op.list_path);
    return (Array.isArray(list) ? list : []).map((x) => ({ admission_id: String(pick(x, op.admission_path) ?? ""), label: String(pick(x, op.label_path) ?? "") })).filter((x) => /^[0-9a-f-]{36}$/.test(x.admission_id));
  }

  // The patient before admission: the one list row for them gives the label and the arrival.
  private async patientContext(patientId: string, prov: Provenance): Promise<EmrContext> {
    const op = this.profile.ops.patient_context;
    if (!op) throw new EmrPortError("unknown_target", "no admission is known for that patient");
    const json = await this.read(op, { patient_id: patientId }, prov);
    const list = pick(json, op.list_path);
    const row = (Array.isArray(list) ? list : []).find((x) => String(pick(x, op.match) ?? "") === patientId);
    if (!row) throw new EmrPortError("unknown_target", "the patient is not in the list the agent can read");
    const visit = str(pick(row, op.visit));
    if (visit && EmrId.safeParse(visit).success) this.learned.visit_by_patient.set(patientId, visit);
    const label = str(pick(row, op.label)) ?? "the patient";
    this.learned.label.set(patientId, label);
    const facts = Object.fromEntries(Object.entries(op.facts).map(([k, p]) => [k, str(pick(row, p))]));
    return { admission_id: "", patient_id: patientId, visit_id: visit, label, facts, keywords: [label, ...this.profile.vocabulary] };
  }

  async resolve(target: EmrTarget, prov: Provenance): Promise<EmrContext> {
    const known = this.admissionOf(target);
    if (!known && target.patient_id) return this.patientContext(target.patient_id, prov);
    const admissionId = this.admissionFor(target);
    const own = this.profile.owners.find((x) => x.id === prov.owner)?.context;
    if (own) {
      const json = await this.read(own, { admission_id: admissionId }, prov);
      const label = str(pick(json, own.label)) ?? "the patient";
      const patient = target.patient_id ?? this.learned.patient_by_admission.get(admissionId) ?? null;
      return { admission_id: admissionId, patient_id: patient, visit_id: null, label, facts: Object.fromEntries(Object.entries(own.facts).map(([k, p]) => [k, str(pick(json, p))])), keywords: [label, ...this.profile.vocabulary] };
    }
    const json = await this.readAdmission(admissionId, prov);
    const op = this.profile.ops.read_admission;
    const facts = Object.fromEntries(Object.entries(op.facts).map(([k, p]) => [k, str(pick(json, p))]));
    const label = str(pick(json, op.label)) ?? "the patient";
    const patient = target.patient_id ?? Object.entries(this.profile.targets.admission_by_patient).find(([, a]) => a === admissionId)?.[0] ?? this.learned.patient_by_admission.get(admissionId) ?? null;
    if (patient) { this.learned.patient_by_admission.set(admissionId, patient); this.learned.admission_by_patient.set(patient, admissionId); }
    this.learned.label.set(admissionId, label);
    const keywords = [label, ...Object.values(facts).filter((v): v is string => v !== null && v.length <= 60 && !v.startsWith("{") && /[A-Za-z]{2}/.test(v)), ...this.profile.vocabulary];
    return { admission_id: admissionId, patient_id: patient, visit_id: patient ? this.learned.visit_by_patient.get(patient) ?? null : null, label, facts, keywords };
  }

  async commit(kind: EmrWriteKind, rawArgs: WorkArgs, intentKey: string, prov: Provenance): Promise<EmrCommit> {
    if (!this.kindsFor(prov.owner).includes(kind)) {
      this.refusals.push({ at: this.now().toISOString(), method: "POST", path: `kind:${kind}`, reason: "kind_not_held" });
      return { ok: false, reason: "kind_not_held", status: null, retryable: false, counted: true };
    }
    if (kind !== OBSERVATION_KIND || this.profile.work[OBSERVATION_KIND]) return this.commitWork(kind, rawArgs, intentKey, prov);
    const parsed = ObservationArgs.safeParse(rawArgs);
    if (!parsed.success) return { ok: false, reason: "invalid_arguments", status: null, retryable: false, counted: false };
    const a = parsed.data;
    const episode = this.profile.targets.episode_by_admission[a.admission_id] ?? (await this.o.episodeFor?.(a.admission_id)) ?? null;
    if (!episode) return { ok: false, reason: "no_episode_for_admission", status: null, retryable: false, counted: false };
    const remarks = [a.corrects_record_id ? `Corrects entry ${a.corrects_record_id}.` : null, a.remark ?? null].filter((x): x is string => x !== null).join(" ") || undefined;
    const op = this.profile.ops.write_observation;
    const body = fillTemplate(op.body, { episode_id: episode, temp_c: a.temp_c, pulse: a.pulse, resp_rate: a.resp_rate, bp: a.bp, remarks });
    const r = await this.request(op.method, op.path, prov, { body, idempotencyKey: intentKey });
    if (r.kind === "refused") return { ok: false, reason: r.reason, status: null, retryable: false, counted: true };
    if (r.kind === "network_error") return { ok: false, reason: r.reason, status: null, retryable: true, counted: false };
    if (r.status === 429 || r.status >= 500) return { ok: false, reason: `door_${r.status}`, status: r.status, retryable: true, counted: false };
    if (r.status < 200 || r.status > 299) {
      const code = pick(r.json, "error.code");
      return { ok: false, reason: `door_${r.status}${typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? `_${code}` : ""}`, status: r.status, retryable: false, counted: false };
    }
    const writes = pick(r.json, op.writes_path);
    const list = Array.isArray(writes) ? writes.filter((w): w is { store: string; id: string } => !!w && typeof w === "object" && typeof (w as P).store === "string" && typeof (w as P).id === "string") : [];
    const primary = list.find((w) => w.store === op.primary_store);
    if (!primary) return { ok: false, reason: "ack_without_record", status: r.status, retryable: false, counted: false };
    return { ok: true, record_id: primary.id, record_version: 1, event_ids: list.map((w) => `${w.store}:${w.id}`), replayed: r.replayed };
  }

  // A fresh read of the admission must show every written value as its latest observation; the door has no read of one entry by id.
  async prove(kind: EmrWriteKind, rawArgs: WorkArgs, written: { record_id: string; record_version: number; event_ids: string[] }, prov: Provenance): Promise<EmrProof | null> {
    if (kind !== OBSERVATION_KIND || this.profile.work[OBSERVATION_KIND]) return this.proveWork(kind, rawArgs, written, prov);
    const args = rawArgs as ObservationArgs;
    const json = await this.readAdmission(args.admission_id, prov);
    const checks = Object.entries(this.profile.ops.read_admission.proof).filter(([k]) => (args as Record<string, unknown>)[k] !== undefined);
    if (!checks.length) return null;
    const seen = Object.fromEntries(checks.map(([k, p]) => [k, pick(json, p) ?? null]));
    if (!checks.every(([k]) => same(seen[k], (args as Record<string, unknown>)[k]))) return null;
    return {
      record_id: written.record_id, record_version: written.record_version, event_ids: written.event_ids,
      record_hash: sha256(canonical({ record_id: written.record_id, seen })), verified_at: this.now().toISOString(),
      read: `fresh admission read shows ${checks.map(([k]) => k).join(", ")} as written`
    };
  }

  // One profile read with "$name" values filled from vars; a read the profile cannot fill is skipped as null.
  private async read(spec: { path: string; query?: Record<string, string> | undefined }, vars: Vars, prov: Provenance): Promise<unknown> {
    const fill = (v: string) => (v.startsWith("$") ? str(vars[v.slice(1)]) : v);
    const pathVars = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, str(v) ?? undefined]));
    const query = Object.fromEntries(Object.entries(spec.query ?? {}).map(([k, v]) => [k, fill(v)]));
    if (Object.values(query).some((v) => v === null)) throw new EmrPortError("missing_value", "a value the read needs is not known yet");
    const r = await this.request("GET", fillPath(spec.path, pathVars), prov, { query: query as Record<string, string> });
    if (r.kind === "refused") throw new EmrPortError(r.reason, "the port refused the read");
    if (r.kind === "network_error") throw new EmrPortError(r.reason, "the hospital door could not be reached", null);
    if (r.status < 200 || r.status > 299) throw new EmrPortError("read_failed", `the hospital door answered ${r.status}`, r.status);
    return r.json;
  }

  // The values a work template may use: the arguments, the patient's known ids, and a few derived forms.
  private varsFor(kind: string, a: WorkArgs): Vars {
    const patient = (a["patient_id"] as string | undefined) ?? (a["admission_id"] ? this.learned.patient_by_admission.get(String(a["admission_id"])) : undefined);
    const v: Vars = { ...a, ...(patient ? { patient_id: patient } : {}) };
    if (!v["visit_id"] && patient) v["visit_id"] = this.learned.visit_by_patient.get(patient);
    if (typeof a["bp"] === "string") { const [sys, dia] = a["bp"].split("/").map(Number); v["bp_sys"] = sys; v["bp_dia"] = dia; }
    if (typeof a["temp_c"] === "string") v["temp_num"] = Number(a["temp_c"]);
    if (kind === OBSERVATION_KIND) { const r = [a["corrects_record_id"] ? `Corrects entry ${String(a["corrects_record_id"])}.` : null, a["remark"] ?? null].filter(Boolean).join(" "); if (r) v["remarks"] = r; }
    if (kind === "record_note") v["note_body"] = a["label"] === "handover" && !/^handover\b/i.test(String(a["text"])) ? `Handover. ${String(a["text"])}` : a["text"];
    const label = (a["admission_id"] ? this.learned.label.get(String(a["admission_id"])) : undefined) ?? (patient ? this.learned.label.get(patient) : undefined);
    if (kind === "page_staff") {
      const t = this.profile.page_targets[String(a["to"])];
      if (t) Object.assign(v, t.vars);
      v["page_body"] = `${label ? `${label}: ` : ""}${String(a["text"])}`;
    }
    if (kind === "schedule_follow_up") v["clinic_id"] = this.profile.clinics[String(a["clinic"])]?.id;
    return v;
  }

  // A write kind from the profile: pre-reads fill values, the key makes a retry replay, and the answer names the record.
  private async commitWork(kind: string, a: WorkArgs, intentKey: string, prov: Provenance): Promise<EmrCommit> {
    const op = this.profile.work[kind];
    if (!op) return { ok: false, reason: "kind_not_in_profile", status: null, retryable: false, counted: false };
    const vars = this.varsFor(kind, a);
    if (READ_ONLY_KINDS.has(kind) || "reads" in op) {
      if (!("reads" in op)) return { ok: false, reason: "kind_not_in_profile", status: null, retryable: false, counted: false };
      const got: Record<string, unknown> = {};
      try { for (const [alias, r] of Object.entries(op.reads)) got[alias] = await this.read(r, vars, prov); } catch (e) {
        return { ok: false, reason: e instanceof EmrPortError ? e.code : "read_failed", status: e instanceof EmrPortError ? e.status : null, retryable: !(e instanceof EmrPortError) || e.status === null || (e.status ?? 0) >= 500, counted: false };
      }
      const report = op.report ? render(op.report, got) : undefined;
      const draft = op.draft ? render(op.draft, got) : undefined;
      const id = String(a["admission_id"] ?? a["visit_id"] ?? "read");
      return { ok: true, record_id: id, record_version: 1, event_ids: [`${op.store}:${sha256(canonical(got)).slice(0, 16)}`], replayed: false, ...(report ? { report } : {}), ...(draft ? { draft } : {}) };
    }
    for (const b of op.before ?? []) {
      let json: unknown;
      try { json = await this.read(b, vars, prov); } catch (e) { return { ok: false, reason: e instanceof EmrPortError ? `before_${e.code}` : "before_failed", status: null, retryable: false, counted: false }; }
      const hit = pickAll(json, b.list).find((x) => Object.entries(b.where).every(([k, want]) => pick(x, k) === want));
      if (!hit) return { ok: false, reason: "nothing_free", status: null, retryable: false, counted: false };
      const value = String(pick(hit, b.field) ?? "");
      const parts = b.split ? value.split(b.split) : [value];
      b.vars.forEach((name, i) => { const p = parts[i]; if (p !== undefined && name !== "_") vars[name] = /^\d+$/.test(p) ? Number(p) : p; });
    }
    if (kind === "schedule_follow_up" && vars["clinic_id"] && vars["slot_clinic_id"] && vars["clinic_id"] !== vars["slot_clinic_id"]) return { ok: false, reason: "slot_in_another_clinic", status: null, retryable: false, counted: false };
    const body = fillTemplate(op.body, vars);
    const r = await this.request("POST", fillPath(op.path, Object.fromEntries(Object.entries(vars).map(([k, x]) => [k, str(x) ?? undefined]))), prov, { body, idempotencyKey: intentKey });
    if (r.kind === "refused") return { ok: false, reason: r.reason, status: null, retryable: false, counted: true };
    if (r.kind === "network_error") return { ok: false, reason: r.reason, status: null, retryable: true, counted: false };
    if (r.status === 429 || r.status >= 500) return { ok: false, reason: `door_${r.status}`, status: r.status, retryable: true, counted: false };
    if (r.status < 200 || r.status > 299) {
      const code = pick(r.json, "error.code");
      return { ok: false, reason: `door_${r.status}${typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? `_${code}` : ""}`, status: r.status, retryable: false, counted: false };
    }
    if (op.ack.positive && !(Number(pick(r.json, op.ack.positive)) > 0)) return { ok: false, reason: "no_recipient", status: r.status, retryable: false, counted: false };
    let id: string | null = op.ack.id_path ? str(pick(r.json, op.ack.id_path)) : null;
    let events = id ? [`${op.ack.store}:${id}`] : [];
    if (op.ack.writes_path) {
      const writes = pick(r.json, op.ack.writes_path);
      const list = Array.isArray(writes) ? writes.filter((w): w is { store: string; id: string } => !!w && typeof w === "object" && typeof (w as P).store === "string" && typeof (w as P).id === "string") : [];
      id = list.find((w) => w.store === op.ack.primary_store)?.id ?? id;
      events = list.map((w) => `${w.store}:${w.id}`);
    }
    for (const [store, path] of Object.entries(op.ack.also ?? {})) { const v = str(pick(r.json, path)); if (v) events.push(`${store}:${v}`); }
    id ??= str(a["admission_id"] ?? a["visit_id"]);
    if (!id) return { ok: false, reason: "ack_without_record", status: r.status, retryable: false, counted: false };
    // A new unnamed patient's arrival and label are learned at once, so the next words and reads reach that arrival.
    if (kind === EMERGENCY_KIND && EmrId.safeParse(id).success) {
      const visit = str(pick(r.json, op.ack.also?.["visit"] ?? "visitId"));
      if (visit && EmrId.safeParse(visit).success) this.learned.visit_by_patient.set(id, visit);
      this.learned.label.set(id, String(a["unidentified_ref"] ?? "the unnamed patient"));
    }
    if (kind === "request_admission" && EmrId.safeParse(id).success && vars["patient_id"]) {
      this.learned.admission_by_patient.set(String(vars["patient_id"]), id);
      this.learned.patient_by_admission.set(id, String(vars["patient_id"]));
    }
    return { ok: true, record_id: id, record_version: 1, event_ids: events.length ? events : [`${op.ack.store}:${id}`], replayed: r.replayed };
  }

  // A fresh read after the write must show it; a read-only kind proves itself by reading again.
  private async proveWork(kind: string, a: WorkArgs, written: { record_id: string; record_version: number; event_ids: string[] }, prov: Provenance): Promise<EmrProof | null> {
    const op = this.profile.work[kind];
    if (!op) return null;
    const vars: Vars = { ...this.varsFor(kind, a), record_id: written.record_id };
    if ("reads" in op) {
      const first = Object.values(op.reads)[0];
      if (!first) return null;
      try { await this.read(first, vars, prov); } catch { return null; }
      return { ...written, record_hash: sha256(canonical({ record_id: written.record_id, kind })), verified_at: this.now().toISOString(), read: `fresh read of ${Object.keys(op.reads).join(" and ")}` };
    }
    if (!op.proof) return null;
    const proofSpec = op.proof;
    let json: unknown;
    try { json = await this.read(proofSpec, vars, prov); } catch { return null; }
    let base: unknown = json;
    if (proofSpec.find) {
      base = pickAll(json, proofSpec.find.list).filter((x) => Object.entries(proofSpec.find!.where).every(([k, want]) => checkOne(pick(x, k), want, vars))).at(-1);
      if (base === undefined) return null;
    }
    const seen = Object.fromEntries(Object.keys(proofSpec.checks).map((k) => [k, pick(base, k) ?? null]));
    // A check on a value the work did not carry is skipped, but at least one check must run.
    const run = Object.entries(proofSpec.checks).filter(([, want]) => !skipped(want, vars));
    if (!run.length || !run.every(([k, want]) => checkOne(seen[k], want, vars))) return null;
    return {
      record_id: written.record_id, record_version: written.record_version, event_ids: written.event_ids,
      record_hash: sha256(canonical({ record_id: written.record_id, seen })), verified_at: this.now().toISOString(),
      read: `fresh read shows ${Object.keys(proofSpec.checks).join(", ")} as written`
    };
  }

  // What the owner's agent watches for this subject, flattened to labelled facts.
  async watch(owner: string, subject: EmrTarget & { visit_id?: string | null }, prov: Provenance): Promise<WatchRead | null> {
    const names = this.profile.owners.find((x) => x.id === owner)?.watches ?? [];
    if (!names.length) return null;
    const vars: Vars = { admission_id: subject.admission_id || undefined, patient_id: subject.patient_id, visit_id: subject.visit_id ?? (subject.patient_id ? this.learned.visit_by_patient.get(subject.patient_id) : undefined) };
    const facts: Record<string, string | null> = {};
    const labels: Record<string, string> = {};
    for (const n of names) {
      const w = this.profile.watches[n];
      if (!w) continue;
      const needs = [...w.path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!).concat(Object.values(w.query ?? {}).filter((v) => v.startsWith("$")).map((v) => v.slice(1)));
      if (needs.some((k) => !vars[k])) continue;
      let json: unknown;
      try { json = await this.read(w, vars, prov); } catch { continue; }
      for (const [k, f] of Object.entries(w.facts)) { facts[`${n}.${k}`] = str(pick(json, f.path)); labels[`${n}.${k}`] = f.label; }
    }
    return Object.keys(facts).length ? { facts, labels } : null;
  }

  // The agent's own inbox through the door; a page's body stays unread unless the detail read is allowed.
  async inbox(owner: string, prov: Provenance): Promise<InboxPage[]> {
    const spec = this.profile.inbox;
    if (!spec || !this.profile.owners.find((x) => x.id === owner)?.inbox) return [];
    const json = await this.read(spec, {}, prov);
    const list = pick(json, spec.list_path);
    const out: InboxPage[] = [];
    for (const row of Array.isArray(list) ? list : []) {
      const id = str(pick(row, spec.id));
      if (!id || !EmrId.safeParse(id).success) continue;
      let patient: string | null = null;
      if (spec.detail) { try { patient = str(pick(await this.read(spec.detail, { page_id: id }, prov), spec.detail.patient)); } catch { patient = null; } }
      out.push({ page_id: id, subject: str(pick(row, spec.subject)) ?? "", at: str(pick(row, spec.at)) ?? this.now().toISOString(), patient_id: patient });
    }
    return out;
  }
}

// One proof check: "$name" equal, "@nonnull", "@startswith:$name" on the first 40 characters, or "@contains:$name".
function checkOne(seen: unknown, want: string, vars: Vars): boolean {
  const val = (x: string) => (x.startsWith("$") ? vars[x.slice(1)] : x);
  if (want === "@nonnull") return seen !== null && seen !== undefined && seen !== "";
  if (want.startsWith("@startswith:")) { const w = str(val(want.slice(12))); return !!w && typeof seen === "string" && norm(seen).startsWith(norm(w).slice(0, 40)); }
  if (want.startsWith("@contains:")) { const w = str(val(want.slice(10))); return !!w && typeof seen === "string" && norm(seen).includes(norm(w).slice(0, 40)); }
  return same(seen, val(want));
}
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const skipped = (want: string, vars: Vars) => { const m = /\$([a-z_]+)$/.exec(want); return !!m && (vars[m[1]!] === undefined || vars[m[1]!] === null); };

// Picks a list path where "a[].b" flattens each element's b, so nested groups read as one list.
export function pickAll(v: unknown, path: string): unknown[] {
  if (path.includes(",")) return path.split(",").flatMap((p) => pickAll(v, p));
  let cur: unknown[] = [v];
  for (const seg of path.split("[].")) cur = cur.flatMap((x) => { const y = pick(x, seg); return Array.isArray(y) ? y : y === undefined ? [] : [y]; });
  return cur;
}

// Renders "{alias.path}" and "{alias.list[].field}" placeholders from the reads; a missing value reads "none".
export function render(tpl: string, got: Record<string, unknown>): string {
  return tpl.replace(/\{([A-Za-z0-9_]+(?:(?:\.|\[\]\.)[A-Za-z0-9_]+)*)\}/g, (_m, path: string) => {
    if (path.includes("[].")) { const all = pickAll(got, path).map((x) => str(x) ?? "").filter(Boolean); return all.length ? all.join(", ") : "none"; }
    return str(pick(got, path)) ?? "none";
  }).replace(/\s+/g, " ").trim();
}
type P = Record<string, unknown>;
