import { canonical, sha256 } from "@hey-pisgah/contracts";
import {
  EmrPortError, OBSERVATION_KIND, ObservationArgs,
  type EmrCommit, type EmrContext, type EmrPort, type EmrProof, type EmrTarget, type EmrWriteKind, type Provenance
} from "@hey-pisgah/agent";
import { fillPath, fillTemplate, pathPattern, pick, type DoorProfile } from "./profile.js";

const EVIDENCE = /^[A-Za-z0-9_.:#/-]{1,200}$/;
const IDEM = /^[A-Za-z0-9_.:-]{1,255}$/;

export type DoorLog = {
  at: string; method: string; path: string; status: number | null; ms: number; replayed: boolean;
  headers: Record<string, string>; body: unknown; outcome: "response" | "refused" | "network_error"; reason?: string;
};
export type Refusal = { at: string; method: string; path: string; reason: "denied_path" | "not_allowlisted" | "no_bearer_for_owner" | "bad_header" };
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

// The hospital port over the platform's agent door: every call carries the agent bearer and the provenance headers, and only allowlisted routes are ever called.
export class PisgahPort implements EmrPort {
  readonly writeKinds = [OBSERVATION_KIND] as const;
  readonly refusals: Refusal[] = [];
  private readonly allow: { method: string; re: RegExp }[];

  constructor(readonly profile: DoorProfile, private readonly o: PisgahPortOptions) {
    const ops = profile.ops;
    this.allow = [ops.read_admission, ops.write_observation, ...(ops.census ? [ops.census] : [])].map((x) => ({ method: x.method, re: pathPattern(x.path) }));
    for (const a of this.allow) for (const d of profile.deny) if (a.re.test(d)) throw new Error("the profile allows a denied path");
  }

  refusedCount(): number { return this.refusals.length; }
  private now(): Date { return this.o.now?.() ?? new Date(); }

  private refuse(method: string, path: string, reason: Refusal["reason"]): DoorResult {
    this.refusals.push({ at: this.now().toISOString(), method, path, reason });
    this.o.onRequest?.({ at: this.now().toISOString(), method, path, status: null, ms: 0, replayed: false, headers: {}, body: null, outcome: "refused", reason });
    return { kind: "refused", reason };
  }

  // The only function that reaches the network: deny list first, then the allowlist, then the bearer for the named owner.
  async request(method: "GET" | "POST", path: string, prov: Provenance, init: { body?: unknown; idempotencyKey?: string } = {}): Promise<DoorResult> {
    const clean = path.replace(/^\/+|\/+$/g, "");
    if (this.profile.deny.some((d) => clean === d || clean.startsWith(`${d}/`))) return this.refuse(method, clean, "denied_path");
    if (!this.allow.some((a) => a.method === method && a.re.test(clean))) return this.refuse(method, clean, "not_allowlisted");
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
      res = await (this.o.fetch ?? fetch)(`${this.profile.base_url.replace(/\/+$/, "")}/${clean}`, {
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
    log(res.status, replayed, "response");
    return { kind: "response", status: res.status, json: body, replayed };
  }

  private admissionFor(target: EmrTarget): string {
    const id = target.admission_id ?? (target.patient_id ? this.profile.targets.admission_by_patient[target.patient_id] : undefined);
    if (!id) throw new EmrPortError("unknown_target", "no admission is known for that patient");
    return id;
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

  async resolve(target: EmrTarget, prov: Provenance): Promise<EmrContext> {
    const admissionId = this.admissionFor(target);
    const json = await this.readAdmission(admissionId, prov);
    const op = this.profile.ops.read_admission;
    const str = (v: unknown) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v).slice(0, 300) : String(v).slice(0, 300));
    const facts = Object.fromEntries(Object.entries(op.facts).map(([k, p]) => [k, str(pick(json, p))]));
    const label = str(pick(json, op.label)) ?? "the patient";
    const patient = target.patient_id ?? Object.entries(this.profile.targets.admission_by_patient).find(([, a]) => a === admissionId)?.[0] ?? null;
    const keywords = [label, ...Object.values(facts).filter((v): v is string => v !== null && v.length <= 60 && !v.startsWith("{") && /[A-Za-z]{2}/.test(v)), ...this.profile.vocabulary];
    return { admission_id: admissionId, patient_id: patient, label, facts, keywords };
  }

  async commit(kind: EmrWriteKind, rawArgs: ObservationArgs, intentKey: string, prov: Provenance): Promise<EmrCommit> {
    if (kind !== OBSERVATION_KIND) return { ok: false, reason: "kind_not_held", status: null, retryable: false, counted: true };
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
  async prove(_kind: EmrWriteKind, args: ObservationArgs, written: { record_id: string; record_version: number; event_ids: string[] }, prov: Provenance): Promise<EmrProof | null> {
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
}
type P = Record<string, unknown>;
