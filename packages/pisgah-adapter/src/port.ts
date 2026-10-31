import { canonical, sha256 } from "@hey-pisgah/contracts";
import {
  EMERGENCY_KIND, EmrId, EmrPortError, NEW_RECORD_KINDS, OBSERVATION_KIND, ObservationArgs, READ_ONLY_KINDS,
  type DelegationRead, type DelegationTeam, type EmrCommit, type EmrContext, type EmrPort, type EmrProof, type EmrTarget, type EmrWriteKind, type InboxPage, type OrderResult, type Orderables, type Provenance,
  type PaperworkReadBack, type ReadBack, type SayableNames, type SpeakerInput, type SpeakerVerdict, type WatchOffer, type WatchRead, type WorkArgs
} from "@hey-pisgah/agent";
import { fillPath, fillTemplate, pathPattern, pick, type DoorProfile } from "./profile.js";

const EVIDENCE = /^[A-Za-z0-9_.:#/-]{1,200}$/;
const QUERY_VALUE = /^[A-Za-z0-9_.:|-]{1,80}$/;
const IDEM = /^[A-Za-z0-9_.:-]{1,255}$/;
// A voice authority header is the matched line's evidence and the hospital's token for it.
const TOKEN = /^(?:v1\.\d{13}\.[A-Za-z0-9_-]{43}|v2\.\d{13}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})$/;
const VOICE = new RegExp(`^transcript:[A-Za-z0-9_.:#/-]{1,180}~${TOKEN.source.slice(1, -1)}$`);
const DIGEST = /^[0-9a-f]{64}$/;
// A 2xx that names no record: the hospital saved the write, so the runtime holds it uncertain and reads for it, never sending it again.
const COMMITTED_WITHOUT_RECORD = (status: number): EmrCommit => ({ ok: false, reason: "committed_without_record", status, retryable: true, counted: false, committed: true });

export type DoorLog = {
  at: string; method: string; path: string; status: number | null; ms: number; replayed: boolean;
  headers: Record<string, string>; body: unknown; outcome: "response" | "refused" | "network_error"; reason?: string;
};
export type Refusal = { at: string; method: string; path: string; reason: "denied_path" | "not_allowlisted" | "no_bearer_for_owner" | "bad_header" | "kind_not_held" | "needs_confirmation" };
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
  // The door's request budget for one agent session: a burst and a steady rate per second; reads wait behind a reserve kept for writes.
  budget?: DoorBudget | null;
};
export type DoorBudget = { capacity: number; perSecond: number; writeReserve: number; readWaitMs: number };
// Pisgah's door gives an agent session 60 requests at once and one a second after that (rate-limit.ts).
export const PISGAH_AGENT_BUDGET: DoorBudget = { capacity: 60, perSecond: 1, writeReserve: 15, readWaitMs: 15_000 };

// One owner's share of the door budget: a write always goes and spends a token, a read waits for a token above the write reserve and gives up after its wait.
export class DoorPacer {
  private tokens: number;
  private at: number;
  constructor(private readonly b: DoorBudget, private readonly clock: () => number = Date.now) { this.tokens = b.capacity; this.at = clock(); }
  private refill(): void { const now = this.clock(); this.tokens = Math.min(this.b.capacity, this.tokens + ((now - this.at) / 1000) * this.b.perSecond); this.at = now; }
  write(): void { this.refill(); this.tokens = Math.max(0, this.tokens - 1); }
  async read(sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<boolean> {
    const end = this.clock() + this.b.readWaitMs;
    for (;;) {
      this.refill();
      if (this.tokens >= this.b.writeReserve + 1) { this.tokens -= 1; return true; }
      if (this.clock() >= end) return false;
      // A read never sleeps past its own wait, so a token that would come later is not taken.
      await sleep(Math.min(end - this.clock(), Math.ceil(((this.b.writeReserve + 1 - this.tokens) / this.b.perSecond) * 1000) + 20));
    }
  }
}

const same = (a: unknown, b: unknown): boolean => {
  if (a === undefined || a === null) return false;
  const na = Number(a), nb = Number(b);
  if (typeof b === "number" || (typeof b === "string" && /^\d+(\.\d+)?$/.test(b))) return Number.isFinite(na) && na === nb;
  return String(a).replace(/\s+/g, "") === String(b).replace(/\s+/g, "");
};

type Vars = Record<string, unknown>;
const concatBytes = (ps: readonly Uint8Array[]): Uint8Array => { const o = new Uint8Array(ps.reduce((n, p) => n + p.byteLength, 0)); let at = 0; for (const p of ps) { o.set(p, at); at += p.byteLength; } return o; };
const str = (v: unknown) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v).slice(0, 300) : String(v).slice(0, 300));

// The hospital port over the platform's agent door: every call carries the agent bearer and the provenance headers, and only allowlisted routes are ever called.
export class PisgahPort implements EmrPort {
  readonly writeKinds = [OBSERVATION_KIND] as const;
  readonly refusals: Refusal[] = [];
  private readonly allow: { method: string; re: RegExp }[];
  // Ids the door gave back, so a patient's later words reach the admission and arrival the agent saw.
  private readonly learned = { admission_by_patient: new Map<string, string>(), visit_by_patient: new Map<string, string>(), patient_by_admission: new Map<string, string>(), label: new Map<string, string>() };

  // Present only when the profile names the hospital's speaker match and read-back, so an older profile keeps attribution off.
  readonly speaker?: (owner: string, voice: SpeakerInput, prov: Provenance) => Promise<SpeakerVerdict>;
  readonly readBack?: (owner: string, visitId: string, prov: Provenance) => Promise<ReadBack>;
  readonly readPaperwork?: (owner: string, admissionId: string, prov: Provenance) => Promise<PaperworkReadBack>;
  readonly orderResults?: (owner: string, subject: EmrTarget & { visit_id?: string | null }, prov: Provenance) => Promise<OrderResult[]>;

  constructor(readonly profile: DoorProfile, private readonly o: PisgahPortOptions) {
    const ops = profile.ops;
    if (ops.speaker) this.speaker = (owner, voice, prov) => this.matchSpeaker(owner, voice, prov);
    if (ops.read_back) this.readBack = (owner, visitId, prov) => this.readBackFor(owner, visitId, prov);
    if (ops.paperwork) this.readPaperwork = (owner, admissionId, prov) => this.paperworkFor(owner, admissionId, prov);
    if (profile.result_orders) this.orderResults = (_owner, subject, prov) => this.resultsFor(subject, prov);
    const reads = [
      ...(profile.result_orders ? [profile.result_orders.path] : []),
      ...(ops.patient_context ? [ops.patient_context.path] : []), ...profile.owners.flatMap((o) => (o.context ? [o.context.path] : [])), ...Object.values(profile.watches).map((w) => w.path),
      ...(profile.inbox ? [profile.inbox.path, ...(profile.inbox.detail ? [profile.inbox.detail.path] : [])] : []),
      ...(profile.delegations ? [profile.delegations.list.path, profile.delegations.one.path] : []),
      ...Object.values(profile.work).flatMap((w) => ("reads" in w ? Object.values(w.reads).map((r) => r.path) : [...(w.proof ? [w.proof.path] : []), ...(w.before ?? []).map((b) => b.path)]))
    ];
    const writes = Object.values(profile.work).flatMap((w) => ("method" in w ? [w.path] : []));
    this.allow = [
      ops.read_admission, ops.write_observation, ...(ops.census ? [ops.census] : []),
      ...(ops.speaker ? [{ method: "POST", path: ops.speaker.path }] : []), ...(ops.read_back ? [{ method: "GET", path: ops.read_back.path }] : []),
      ...(ops.paperwork ? [{ method: "GET", path: ops.paperwork.path }] : []),
      ...reads.map((path) => ({ method: "GET", path })), ...writes.map((path) => ({ method: "POST", path })), ...(profile.memos ? [{ method: "POST", path: profile.memos.path }, ...(profile.memos.alerts_path ? [{ method: "POST", path: profile.memos.alerts_path }] : [])] : [])
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
    const o = this.profile.orders;
    return {
      page_targets: Object.fromEntries(Object.entries(this.profile.page_targets).map(([k, v]) => [k, v.words])),
      clinics: Object.fromEntries(Object.entries(this.profile.clinics).map(([k, v]) => [k, v.words])),
      wards: Object.fromEntries(Object.entries(this.profile.wards).map(([k, v]) => [k, v.words])),
      ...(o ? { tests: Object.fromEntries(Object.entries(o.tests).map(([k, v]) => [k, v.words])), drugs: Object.fromEntries(Object.entries(o.drugs).map(([k, v]) => [k, v.words])) } : {})
    };
  }
  resultFacts(owner: string): readonly string[] { return this.profile.result_facts[owner] ?? []; }
  resultStates(): readonly string[] { return this.profile.result_orders?.states ?? []; }

  // Each order on the visit by its record id, its test key by the hospital's own test name, and its state now.
  private async resultsFor(subject: EmrTarget & { visit_id?: string | null }, prov: Provenance): Promise<OrderResult[]> {
    const spec = this.profile.result_orders!;
    const visit = subject.visit_id ?? (subject.patient_id ? this.learned.visit_by_patient.get(subject.patient_id) : undefined);
    if (!visit) return [];
    const json = await this.read(spec, { visit_id: visit, patient_id: subject.patient_id, admission_id: subject.admission_id || undefined }, prov);
    const byName = new Map(Object.entries(this.profile.orders?.tests ?? {}).map(([k, v]) => [v.name.toLowerCase(), k]));
    return pickAll(json, spec.list).flatMap((x) => {
      const id = opt(pick(x, spec.id));
      if (!id || !EmrId.safeParse(id).success) return [];
      const name = opt(pick(x, spec.test));
      return [{ id, test: name ? byName.get(name.toLowerCase()) ?? null : null, state: opt(pick(x, spec.state)) }];
    });
  }
  verbalIssuers(owner: string): Record<string, { words: readonly string[]; label: string }> {
    return Object.fromEntries(Object.entries(this.profile.verbal_issuers).filter(([, v]) => v.receivers.includes(owner)).map(([k, v]) => [k, { words: v.words, label: v.label }]));
  }

  orderables(): Orderables {
    const o = this.profile.orders;
    return { tests: Object.fromEntries(Object.entries(o?.tests ?? {}).map(([k, v]) => [k, v.words])), drugs: Object.fromEntries(Object.entries(o?.drugs ?? {}).map(([k, v]) => [k, { words: v.words, controlled: v.controlled }])) };
  }

  // The hospital matches the voiceprint, or computes it from the line's audio, against its enrolled voices and answers only the verdict; a failure reads as unverified, never as the owner.
  private async matchSpeaker(owner: string, voice: SpeakerInput, prov: Provenance): Promise<SpeakerVerdict> {
    const op = this.profile.ops.speaker!;
    if ("pcm16k" in voice && voice.pcm16k.length > 1 && !this.profile.headers.audio_segments) return { speaker: "unverified", reason: "segments_unsupported" };
    const audio = "pcm16k" in voice ? { bytes: concatBytes(voice.pcm16k), segments: voice.pcm16k.map((p) => p.byteLength) } : null;
    const r = await this.request("POST", op.path, prov, audio ?? { body: { embedding: voice, model: "nemo_en_titanet_small" } });
    if (r.kind !== "response" || r.status !== 200) return { speaker: "unverified", reason: r.kind === "response" ? `door_${r.status}` : r.reason };
    const j = r.json as Record<string, unknown> | null;
    const sp = j?.["speaker"];
    if (sp === "owner" && typeof j?.["token"] === "string" && TOKEN.test(j["token"])) return { speaker: "owner", token: j["token"] };
    if (sp === "other_clinician") { const c = (j?.["clinician"] ?? {}) as Record<string, unknown>; return { speaker: "other_clinician", label: String(c["label"] ?? "Another clinician").slice(0, 60), role: String(c["role"] ?? "") }; }
    return { speaker: "unverified", reason: typeof j?.["reason"] === "string" ? String(j["reason"]).slice(0, 40) : "no_match" };
  }

  private async readBackFor(owner: string, visitId: string, prov: Provenance): Promise<ReadBack> {
    const j = (await this.read(this.profile.ops.read_back!, { visit_id: visitId }, { ...prov, owner })) as Record<string, unknown> | null;
    const list = (v: unknown) => (Array.isArray(v) ? v : []) as Record<string, unknown>[];
    return {
      items: list(j?.["items"]).map((i) => ({ stateId: String(i["stateId"]), label: String(i["label"] ?? "Order").slice(0, 120), kind: String(i["kind"] ?? ""), controlled: i["controlled"] === true, sentAt: typeof i["sentAt"] === "string" ? i["sentAt"] : null })).filter((i) => EmrId.safeParse(i.stateId).success),
      itemsDigest: typeof j?.["itemsDigest"] === "string" && /^[0-9a-f]{64}$/.test(j["itemsDigest"]) ? j["itemsDigest"] : null,
      readBackAt: typeof j?.["readBackAt"] === "string" ? j["readBackAt"] : this.now().toISOString(),
      seal: typeof j?.["readBackSeal"] === "string" && /^[A-Za-z0-9_-]{43}$/.test(j["readBackSeal"]) ? j["readBackSeal"] : null,
      awaitingSecond: list(j?.["awaitingSecond"]).map((i) => ({ stateId: String(i["stateId"]), label: String(i["label"] ?? "Order").slice(0, 120) })),
      changed: list(j?.["changed"]).map((i) => ({ stateId: String(i["stateId"]), label: String(i["label"] ?? "Order").slice(0, 120) }))
    };
  }

  // The paperwork as the hospital filled it from the record; a missing or malformed digest fails, so nothing can be confirmed unread.
  private async paperworkFor(owner: string, admissionId: string, prov: Provenance): Promise<PaperworkReadBack> {
    const op = this.profile.ops.paperwork!;
    const j = await this.read(op, { admission_id: admissionId }, { ...prov, owner });
    const digest = pick(j, op.digest);
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) throw new EmrPortError("no_paperwork", "the hospital returned no paperwork to read back");
    const list = (path: string) => { const v = pick(j, path); return (Array.isArray(v) ? v : []) as unknown[]; };
    const tests = list(op.tests);
    const unsigned = op.unsigned ? Number(pick(j, op.unsigned) ?? 0) : 0;
    return {
      digest,
      diagnosis: str(pick(j, op.diagnosis))?.slice(0, 200) ?? null,
      dispensed: list(op.medicines).filter((m) => pick(m, op.medicine_dispensed) !== null && pick(m, op.medicine_dispensed) !== undefined)
        .map((m) => `${str(pick(m, op.medicine_name))?.slice(0, 60) ?? "Medicine"} ${str(pick(m, op.medicine_dispensed))}`),
      exceptions: list(op.exceptions).map((e) => str(pick(e, op.exception_text))?.slice(0, 160) ?? "").filter(Boolean),
      tests: { resulted: tests.filter((x) => pick(x, op.test_resulted) === true).length, total: tests.length },
      unsigned: Number.isFinite(unsigned) ? unsigned : 0,
      pending: op.pending ? list(op.pending).map((x) => str(pick(x, op.pending_text ?? "text"))?.slice(0, 200) ?? "").filter(Boolean).slice(0, 20) : []
    };
  }

  delegationSide(owner: string): "none" | "assignee" | "delegator" | "both" {
    return this.profile.delegations ? this.profile.owners.find((x) => x.id === owner)?.delegation ?? "none" : "none";
  }
  // Only owners this serve holds a bearer for are polled, so an owner left out of a run is never a refused read.
  delegationOwners(): readonly string[] { return this.profile.owners.filter((x) => this.delegationSide(x.id) !== "none" && this.o.bearers[x.id]).map((x) => x.id); }
  // The teams are the hospital's, the same for every owner who may hand work on.
  delegationTeams(owner: string): Record<string, DelegationTeam> {
    const side = this.delegationSide(owner);
    if (side !== "delegator" && side !== "both") return {};
    return Object.fromEntries(Object.entries(this.profile.delegations?.teams ?? {}).map(([k, t]) => [k, { words: t.words, task_kind: t.task_kind, title: t.title, label: t.label, ...(t.escalate_after_minutes !== undefined ? { escalate_after_minutes: t.escalate_after_minutes } : {}) }]));
  }
  delegationHandoffs(owner: string): Record<string, { team: string; subject_table: string }> {
    const side = this.delegationSide(owner);
    return side === "delegator" || side === "both" ? this.profile.delegations?.handoffs ?? {} : {};
  }
  // The open tasks handed to the owner, or handed on by them, as the door lists them.
  async delegations(owner: string, as: "assignee" | "delegator", prov: Provenance): Promise<DelegationRead[]> {
    const spec = this.profile.delegations;
    if (!spec || this.delegationSide(owner) === "none" || !this.o.bearers[owner]) return [];
    const json = await this.read(spec.list, { as }, prov);
    const list = pick(json, spec.list.list_path);
    return (Array.isArray(list) ? list : []).map(delegationOf).filter((d): d is DelegationRead => d !== null);
  }
  // One task with what the record says about it, read fresh.
  async delegation(owner: string, id: string, prov: Provenance): Promise<DelegationRead | null> {
    const spec = this.profile.delegations;
    if (!spec || this.delegationSide(owner) === "none" || !EmrId.safeParse(id).success) return null;
    return delegationOf(await this.read(spec.one, { delegation_id: id }, prov));
  }

  private readonly pacers = new Map<string, DoorPacer>();
  private pacerOf(owner: string): DoorPacer { let p = this.pacers.get(owner); if (!p) { p = new DoorPacer(this.o.budget ?? PISGAH_AGENT_BUDGET); this.pacers.set(owner, p); } return p; }
  refusedCount(): number { return this.refusals.length; }
  private now(): Date { return this.o.now?.() ?? new Date(); }

  private refuse(method: string, path: string, reason: Refusal["reason"]): DoorResult {
    this.refusals.push({ at: this.now().toISOString(), method, path, reason });
    this.o.onRequest?.({ at: this.now().toISOString(), method, path, status: null, ms: 0, replayed: false, headers: {}, body: null, outcome: "refused", reason });
    return { kind: "refused", reason };
  }

  // The only function that reaches the network: deny list first, then the allowlist, then the bearer for the named owner.
  async request(method: "GET" | "POST", path: string, prov: Provenance, init: { body?: unknown; bytes?: Uint8Array; segments?: readonly number[]; idempotencyKey?: string; query?: Record<string, string> } = {}): Promise<DoorResult> {
    const clean = path.replace(/^\/+|\/+$/g, "");
    if (this.profile.deny.some((d) => clean === d || clean.startsWith(`${d}/`)) || this.profile.deny_exact.includes(clean)) return this.refuse(method, clean, "denied_path");
    if (!this.allow.some((a) => a.method === method && a.re.test(clean))) return this.refuse(method, clean, "not_allowlisted");
    const query = Object.entries(init.query ?? {});
    if (query.some(([k, v]) => !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k) || !QUERY_VALUE.test(v))) return this.refuse(method, clean, "bad_header");
    const qs = query.length ? `?${new URLSearchParams(query).toString()}` : "";
    const bearer = this.o.bearers[prov.owner];
    if (!bearer) return this.refuse(method, clean, "no_bearer_for_owner");
    if (!EVIDENCE.test(prov.evidence) || Number.isNaN(Date.parse(prov.spoken_at)) || (init.idempotencyKey !== undefined && !IDEM.test(init.idempotencyKey))) return this.refuse(method, clean, "bad_header");
    if ([prov.voice?.authorisation, prov.voice?.confirmation].some((v) => v !== undefined && !VOICE.test(v))) return this.refuse(method, clean, "bad_header");
    if (prov.read_back_digest !== undefined && !DIGEST.test(prov.read_back_digest)) return this.refuse(method, clean, "bad_header");
    const batch = prov.voice?.batch;
    if (batch !== undefined && (batch.length < 1 || batch.length > 20 || !batch.every((d) => DIGEST.test(d)))) return this.refuse(method, clean, "bad_header");
    if (this.profile.confirm.includes(clean) && (method !== "POST" || !this.profile.headers.confirmation || !prov.voice?.confirmation || (!!this.profile.headers.read_back_digest && !prov.read_back_digest))) return this.refuse(method, clean, "needs_confirmation");
    const h = this.profile.headers;
    const shown: Record<string, string> = {
      [h.on_behalf_of]: prov.owner, [h.origin]: this.profile.origin_value, [h.evidence]: prov.evidence, [h.spoken_at]: prov.spoken_at,
      ...(h.authorisation && prov.voice?.authorisation ? { [h.authorisation]: prov.voice.authorisation } : {}), ...(h.confirmation && prov.voice?.confirmation ? { [h.confirmation]: prov.voice.confirmation } : {}),
      ...(h.read_back_digest && prov.read_back_digest ? { [h.read_back_digest]: prov.read_back_digest } : {}),
      ...(h.authorisation_batch && batch?.length && prov.voice?.authorisation ? { [h.authorisation_batch]: [...new Set(batch)].sort().join(",") } : {}),
      ...(h.audio_segments && init.segments ? { [h.audio_segments]: init.segments.join(",") } : {}),
      ...(init.idempotencyKey ? { [h.idempotency]: init.idempotencyKey } : {}), ...(init.bytes ? { "content-type": "application/octet-stream" } : init.body !== undefined ? { "content-type": "application/json" } : {}), accept: "application/json"
    };
    // The door's own budget is kept here, so a busy watcher never starves the writes it exists for.
    const pacer = this.o.budget === null ? null : this.pacerOf(prov.owner);
    if (pacer && method === "POST") pacer.write();
    if (pacer && method === "GET" && !(await pacer.read())) { this.o.onRequest?.({ at: this.now().toISOString(), method, path: clean, status: null, ms: 0, replayed: false, headers: {}, body: null, outcome: "network_error", reason: "paced" }); return { kind: "network_error", reason: "paced" }; }
    const t0 = performance.now();
    const at = this.now().toISOString();
    const log = (status: number | null, replayed: boolean, outcome: DoorLog["outcome"], reason?: string) =>
      this.o.onRequest?.({ at, method, path: clean, status, ms: Math.round(performance.now() - t0), replayed, headers: { authorization: "Bearer <redacted>", ...redactVoice(shown, h) }, body: clean === this.profile.ops.speaker?.path ? { [init.bytes ? "audio" : "embedding"]: init.bytes ? "<audio withheld>" : "<voiceprint withheld>" } : init.bytes ? "<bytes withheld>" : init.body ?? null, outcome, ...(reason ? { reason } : {}) });
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(`${this.profile.base_url.replace(/\/+$/, "")}/${clean}${qs}`, {
        method, headers: { authorization: `Bearer ${bearer}`, ...shown }, ...(init.bytes ? { body: new Uint8Array(init.bytes) } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
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
      // A door that says to ask again, such as a key whose first request is still running, has not refused the write.
      return { ok: false, reason: `door_${r.status}${typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? `_${code}` : ""}`, status: r.status, retryable: pick(r.json, "error.retryable") === true, counted: false };
    }
    const writes = pick(r.json, op.writes_path);
    const list = Array.isArray(writes) ? writes.filter((w): w is { store: string; id: string } => !!w && typeof w === "object" && typeof (w as P).store === "string" && typeof (w as P).id === "string") : [];
    const primary = list.find((w) => w.store === op.primary_store);
    if (!primary) return COMMITTED_WITHOUT_RECORD(r.status);
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
    for (const [name, map] of Object.entries(this.profile.value_maps)) {
      const x = v[name];
      if (typeof x === "string") v[name] = map[x];
      else if (Array.isArray(x)) { const named = x.map((y) => (typeof y === "string" ? map[y] : undefined)).filter((y): y is string => !!y); v[name] = named.length ? named : undefined; }
    }
    if (kind === OBSERVATION_KIND) { const r = [a["corrects_record_id"] ? `Corrects entry ${String(a["corrects_record_id"])}.` : null, a["remark"] ?? null].filter(Boolean).join(" "); if (r) v["remarks"] = r; }
    if (kind === "record_note") v["note_body"] = a["label"] === "handover" && !/^handover\b/i.test(String(a["text"])) ? `Handover. ${String(a["text"])}` : a["text"];
    const label = (a["admission_id"] ? this.learned.label.get(String(a["admission_id"])) : undefined) ?? (patient ? this.learned.label.get(patient) : undefined);
    if (kind === "page_staff") {
      const t = this.profile.page_targets[String(a["to"])];
      if (t) Object.assign(v, t.vars);
      v["page_body"] = `${label ? `${label}: ` : ""}${String(a["text"])}`;
    }
    if (kind === "schedule_follow_up") v["clinic_id"] = this.profile.clinics[String(a["clinic"])]?.id;
    if (kind === "admit_patient" || kind === "assign_bed") { const w = this.profile.wards[String(a["ward"])]; if (w) { v["ward_id"] = w.id; v["ward_class"] = w.class; } }
    if (kind === "record_clerking") {
      // The note goes as the EMR's encounter details, each spoken section under the key the profile names, and as plain text for the clinical notes.
      const sections = this.profile.clerking?.sections ?? {};
      const note = (a["note"] as Record<string, string> | undefined) ?? { [String(a["section"])]: String(a["text"]) };
      const details = Object.fromEntries(Object.entries(note).filter(([k]) => sections[k]).map(([k, t]) => [sections[k]!, t]));
      v["encounter_details_json"] = JSON.stringify(details);
      v["clinical_notes"] = Object.entries(note).map(([k, t]) => `${k.charAt(0).toUpperCase()}${k.slice(1).replace(/_/g, " ")}: ${t}`).join("\n");
    }
    if (kind === "schedule_review") v["review_title"] = `Review: ${String(a["title"])}`.slice(0, 200);
    if (kind === "order_test") { const tst = this.profile.orders?.tests[String(a["test"])]; if (tst) v["test_name"] = tst.name; }
    if (kind === "prescribe") { const d = this.profile.orders?.drugs[String(a["drug"])]; if (d) { v["drug_catalog_id"] = d.id; v["duration"] = a["duration_days"]; } }
    if (kind === "take_verbal_order") {
      v["issuer_id"] = this.profile.verbal_issuers[String(a["issuer"])]?.id;
      if (a["test"]) v["test_name"] = this.profile.orders?.tests[String(a["test"])]?.name;
      if (a["drug"]) v["drug_catalog_id"] = this.profile.orders?.drugs[String(a["drug"])]?.id;
    }
    if (kind === "countersign") v["first_item_id"] = (a["item_ids"] as string[] | undefined)?.[0];
    if (kind === "delegate_task" || kind === "request_ward_review") {
      // A team is named by its key; who takes it in the EMR comes from the profile, never from the words.
      const team = this.profile.delegations?.teams[String(a["team"])];
      if (team) {
        v["assignee"] = team.person_id ? { facilityUserId: team.person_id } : Object.fromEntries(Object.entries({ role: team.role, clinicId: team.clinic_id, wardId: team.ward_id, unitFacilityId: team.unit_facility_id }).filter(([, x]) => x !== undefined));
        if (team.clinic_id) v["clinic_id"] = team.clinic_id;
      }
      if (a["subject_table"] && a["subject_id"]) v["subject"] = { table: a["subject_table"], id: a["subject_id"] };
    }
    return v;
  }

  // The digest of the exact path and body this kind's write would send, the same text the hospital hashes; null when the write needs a pre-read first.
  voiceItem(kind: string, a: WorkArgs): string | null {
    const op = this.profile.work[kind];
    if (!op || !("method" in op) || READ_ONLY_KINDS.has(kind) || (op.before?.length ?? 0) > 0) return null;
    const vars = this.varsFor(kind, a);
    const path = fillPath(op.path, Object.fromEntries(Object.entries(vars).map(([k, x]) => [k, str(x) ?? undefined]))).replace(/^\/+|\/+$/g, "");
    try { return sha256(canonical({ path, body: fillTemplate(op.body, vars) })); } catch { return null; }
  }

  // A write kind from the profile: pre-reads fill values, the key makes a retry replay, and the answer names the record.
  private async commitWork(kind: string, a: WorkArgs, intentKey: string, prov: Provenance): Promise<EmrCommit> {
    const op = this.profile.work[kind];
    if (!op) return { ok: false, reason: "kind_not_in_profile", status: null, retryable: false, counted: false };
    // Both matched lines must travel, and they must be two lines, before such work reaches the network.
    if (this.profile.confirm_kinds.includes(kind) && (!prov.voice?.authorisation || !prov.voice.confirmation || prov.voice.authorisation.split("~")[0] === prov.voice.confirmation.split("~")[0] || prov.voice.authorisation.split("~")[0] !== prov.evidence)) {
      this.refusals.push({ at: this.now().toISOString(), method: "POST", path: `kind:${kind}`, reason: "needs_confirmation" });
      return { ok: false, reason: "needs_confirmation", status: null, retryable: false, counted: true };
    }
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
      // A door that says to ask again, such as a key whose first request is still running, has not refused the write.
      return { ok: false, reason: `door_${r.status}${typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? `_${code}` : ""}`, status: r.status, retryable: pick(r.json, "error.retryable") === true, counted: false };
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
    // Only work whose record is its visit or stay is named by that id; a success naming no record of its own is saved but unnamed, and is read for.
    if (!id && !op.ack.id_path && !op.ack.writes_path && !NEW_RECORD_KINDS.has(kind)) id = str(a["admission_id"] ?? a["visit_id"]);
    if (!id) return COMMITTED_WITHOUT_RECORD(r.status);
    if (kind === EMERGENCY_KIND) this.learnArrival(id, str(pick(r.json, op.ack.also?.["visit"] ?? "visitId")), a);
    if ((kind === "request_admission" || kind === "admit_patient") && EmrId.safeParse(id).success && vars["patient_id"]) {
      this.learned.admission_by_patient.set(String(vars["patient_id"]), id);
      this.learned.patient_by_admission.set(id, String(vars["patient_id"]));
    }
    return { ok: true, record_id: id, record_version: 1, event_ids: events.length ? events : [`${op.ack.store}:${id}`], replayed: r.replayed };
  }

  // A new unnamed patient's arrival and label are learned at once, so the next words and reads reach that arrival.
  private learnArrival(id: string, visit: string | null, a: WorkArgs): void {
    if (!EmrId.safeParse(id).success) return;
    if (visit && EmrId.safeParse(visit).success) this.learned.visit_by_patient.set(id, visit);
    this.learned.label.set(id, String(a["unidentified_ref"] ?? "the unnamed patient"));
  }

  // The record a write made, found by the profile's lookup: exactly one row matching the arguments and made after the intent, never one made before it.
  async findWrite(kind: string, a: WorkArgs, sought: { intent_key: string; since: string }, prov: Provenance): Promise<{ found: { record_id: string; record_version: number; event_ids: string[] } | null; why?: string }> {
    const op = this.profile.work[kind];
    if (!op || !("method" in op) || !op.lookup) return { found: null, why: "no_lookup" };
    const spec = op.lookup;
    const vars = this.varsFor(kind, a);
    const json = await this.read(spec, vars, prov);
    const since = Date.parse(sought.since);
    const rows = pickAll(json, spec.find.list).filter((x) => Object.entries(spec.find.where).every(([k, want]) => checkOne(pick(x, k), want, vars)) && Date.parse(String(pick(x, spec.made_at) ?? "")) >= since);
    if (rows.length !== 1) return { found: null, why: rows.length ? "ambiguous" : "absent" };
    const id = str(pick(rows[0], spec.id));
    if (!id) return { found: null, why: "absent" };
    const events = [`${op.ack.store}:${id}`];
    for (const [store, path] of Object.entries(spec.also ?? {})) { const v = str(pick(rows[0], path)); if (v) events.push(`${store}:${v}`); }
    if (kind === EMERGENCY_KIND) this.learnArrival(id, str(pick(rows[0], spec.also?.["visit"] ?? "visitId")), a);
    return { found: { record_id: id, record_version: 1, event_ids: events } };
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
      for (const [k, f] of Object.entries(w.facts)) { facts[`${n}.${k}`] = factValue(json, f); labels[`${n}.${k}`] = f.label; }
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

const opt = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
// A watched fact's value: the value at its path, or the present word when any value along the path is set and not false.
export function factValue(json: unknown, f: { path: string; present?: string | undefined }): string | null {
  if (!f.present) return str(f.path.includes("[].") ? pickAll(json, f.path) : pick(json, f.path));
  return pickAll(json, f.path).some((v) => v !== null && v !== undefined && v !== false && v !== "" && !(Array.isArray(v) && !v.length)) ? f.present : null;
}
// One delegation from the door's answer, or null when it is not one.
function delegationOf(x: unknown): DelegationRead | null {
  const id = opt(pick(x, "id"));
  const patient = opt(pick(x, "patientId"));
  if (!id || !EmrId.safeParse(id).success || !patient) return null;
  const status = opt(pick(x, "record.status"));
  return {
    id, kind: String(pick(x, "kind") ?? ""), title: String(pick(x, "title") ?? ""), patient_id: patient, admission_id: opt(pick(x, "admissionId")), visit_id: opt(pick(x, "visitId")),
    state: String(pick(x, "state") ?? ""), assignee: opt(pick(x, "assignee.facilityUserId")), rule: String(pick(x, "assignee.rule") ?? ""),
    acknowledged_at: opt(pick(x, "acknowledgedAt")), completed_at: opt(pick(x, "completedAt")), completion_record_id: opt(pick(x, "completionRecordId")),
    due_at: opt(pick(x, "dueAt")), overdue: pick(x, "overdue") === true, escalated_at: opt(pick(x, "escalatedAt")),
    record: { status: status === "verified" || status === "verifier_error" ? status : "unsupported_or_incomplete", record_id: opt(pick(x, "record.recordId")), reason: opt(pick(x, "record.reason")) },
    instruction: opt(pick(x, "instruction")), nudged: Array.isArray(pick(x, "nudged")) ? (pick(x, "nudged") as unknown[]).map(String) : [],
    subject_id: opt(pick(x, "subject.id")), subject_prepared: flag(pick(x, "subjectPrepared")), order_received: flag(pick(x, "orderReceived")), consult_finished: flag(pick(x, "consultFinished")), created_at: opt(pick(x, "createdAt")),
    subject_ready: flag(pick(x, "subjectReady")), awaiting_payment: flag(pick(x, "awaitingPayment"))
  };
}

// One proof check: "$name" equal, "@nonnull", "@recent:<seconds>" for a time written just now, "@startswith:$name" on the first 40 characters, or "@contains:$name".
function checkOne(seen: unknown, want: string, vars: Vars, now = Date.now()): boolean {
  const val = (x: string) => (x.startsWith("$") ? vars[x.slice(1)] : x);
  if (want === "@nonnull") return seen !== null && seen !== undefined && seen !== "";
  if (want.startsWith("@recent:")) {
    const within = Number(want.slice(8)) * 1000;
    const at = typeof seen === "string" ? Date.parse(seen) : NaN;
    return Number.isFinite(within) && Number.isFinite(at) && at <= now + 5_000 && now - at <= within;
  }
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

// The voice headers are kept out of the request log, since each carries a token for one line.
function redactVoice(shown: Record<string, string>, h: DoorProfile["headers"]): Record<string, string> {
  const out = { ...shown };
  for (const k of [h.authorisation, h.confirmation]) if (k && out[k]) out[k] = `${out[k]!.split("~")[0]}~<token>`;
  return out;
}
