import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hashJson } from "@hey-pisgah/contracts";

// The acceptance script: two patients interleaved, each line said by a named person in a named way, with the record expected after it.
export const WHO = ["doctor", "patient", "dr_b", "relative", "nurse", "pharmacist", "lab", "surgeon", "reception", "accounts", "harness"] as const;
export type Who = (typeof WHO)[number];
// speak: the owner's voice (Samuel live, synthetic in the rehearsal); play: a synthetic voice through the speakers; remote: a synthetic stand-in posted through that person's own strip; type: a stand-in typed at that person's strip; person: a person step at a screen; wait: nobody acts; fault: the harness breaks something.
export const MODES = ["speak", "play", "remote", "type", "person", "wait", "fault"] as const;
const Ref = z.enum(["A", "B"]);
const Vars = z.record(z.string(), z.string());
export const Expect = z.union([
  z.strictObject({ arrival: Ref }),
  // established: the registration wrote the record with this name; without it the name need only be held, and either way a different spelling is held, never passed.
  z.strictObject({ identity: Ref, name: z.string().min(3), established: z.literal(true).optional() }),
  z.strictObject({ act: z.string().min(1), owner: z.enum(WHO).optional(), state: z.enum(["proposed", "sent", "acknowledged", "completed", "refused", "failed", "cancelled"]), from_line: z.boolean().optional(), n: z.number().int().min(1).optional(), values: z.record(z.string(), z.union([z.string(), z.number()])).optional(), optional: z.boolean().optional() }),
  z.strictObject({ awaits: z.string().min(1), optional: z.boolean().optional() }),
  z.strictObject({ question: z.string().min(1), optional: z.boolean().optional() }),
  z.strictObject({ no_write_from_line: z.string().min(1) }),
  z.strictObject({ no_order_from_line: z.literal(true) }),
  z.strictObject({ class: z.string().min(1) }),
  z.strictObject({ speaker: z.enum(["owner", "other_clinician", "unverified"]) }),
  z.strictObject({ delegation: z.strictObject({ team: z.string().min(1), state: z.enum(["assigned", "acknowledged", "completed"]).optional(), n: z.number().int().min(1).optional() }), optional: z.boolean().optional() }),
  z.strictObject({ obligation: z.strictObject({ state: z.enum(["held", "fired", "done", "cancelled"]), after: z.enum(["admission", "result"]).optional() }), optional: z.boolean().optional() }),
  z.strictObject({ tracking: Ref }),
  z.strictObject({ tasks_survive: z.literal(true) }),
  z.strictObject({ wake: z.literal(true) }),
  z.strictObject({ not_heard: z.literal(true) }),
  z.strictObject({ query: z.string().regex(/^[a-z0-9_]{1,60}$/), vars: Vars, rows_min: z.number().int().min(0).optional(), match: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(), optional: z.boolean().optional() })
]);
export type Expect = z.infer<typeof Expect>;
export const Line = z.strictObject({
  id: z.string().regex(/^[A-Z][A-Z0-9]{1,5}$/), patient: Ref.nullable(), step: z.string().min(1).max(40), who: z.enum(WHO), mode: z.enum(MODES),
  text: z.string().min(1).max(400).optional(), op: z.string().regex(/^[a-z0-9_]{1,60}$/).optional(), vars: Vars.optional(),
  fault: z.enum(["restart"]).optional(), interrupt: z.strictObject({ kind: z.string().min(1), note: z.string().max(300).optional() }).optional(),
  // The reply to the first write whose path holds this text is dropped after the hospital has done it; the write must still end once.
  lose_ack: z.strictObject({ path: z.string().min(3).max(80) }).optional(),
  // The browser goes offline for this many seconds while the line is said; the strip must keep the words and send them after.
  offline_s: z.number().int().min(2).max(60).optional(),
  // The doctor mutes the strip, the words are said, and the strip is unmuted; nothing said while muted may reach any record.
  muted: z.boolean().optional(),
  // The page reloads just before the line, as a server restart does; the strip must be listening again with no touch.
  reload: z.boolean().optional(),
  confirm: z.enum(["r3", "countersign"]).optional(), speed: z.enum(["vitals", "order"]).optional(),
  after: z.array(z.strictObject({ nudged: z.enum(WHO) })).optional(), expect: z.array(Expect).default([]), timeout_s: z.number().int().min(5).max(3600).optional(), note: z.string().max(400).optional()
}).refine((l) => (["speak", "play", "remote", "type"].includes(l.mode) ? !!l.text : true), "a spoken or typed line needs its text")
  .refine((l) => (l.mode === "person" ? !!l.op : true), "a person step names its op")
  .refine((l) => (l.mode === "fault" ? !!l.fault : true), "a fault names what it breaks");
export type Line = z.infer<typeof Line>;
export const Script = z.strictObject({
  version: z.number().int(), title: z.string(), rules: z.string(), voices: z.record(z.string(), z.string()),
  people: z.record(z.string(), z.strictObject({ login: z.string().regex(/^[a-z0-9._-]{1,40}$/), label: z.string() })),
  lines: z.array(Line).min(1)
}).refine((s) => new Set(s.lines.map((l) => l.id)).size === s.lines.length, "line ids are unique");
export type Script = z.infer<typeof Script>;

export function loadScript(file: string): { script: Script; sha256: string } {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  return { script: Script.parse(raw), sha256: hashJson(raw) };
}

// Who did a step, in the words the result file uses: the owner's voice, an agent, a person at a screen, or the harness standing in.
export function didBy(line: Pick<Line, "who" | "mode">, driver: "human" | "say" | "post" | "text" | "fake"): string {
  if (line.mode === "fault") return "harness (injected fault)";
  if (line.mode === "wait") return "no one spoke; agents acted on the record";
  if (line.mode === "person") return `${line.who} at a screen (person step run by the harness; payment simulated where money moves)`;
  if (line.mode === "type") return `${line.who} (stand-in typed at that person's own strip under their session, by the harness)`;
  if (line.mode === "remote") return `${line.who} (stand-in: that person's enrolled synthetic voice posted through their own strip by the harness)`;
  if (line.mode === "play") return driver === "fake" ? `${line.who} (synthetic voice in Chrome's fake microphone file, as if in the room)` : `${line.who} (synthetic voice played through the speakers by the harness)`;
  if (driver === "human") return "doctor: Samuel's own voice at the microphone";
  if (driver === "say") return "doctor: synthetic owner voice through the speakers into the strip's microphone (rehearsal)";
  if (driver === "fake") return "doctor: synthetic owner voice in Chrome's fake microphone file, through the real strip (rehearsal, no sound)";
  if (driver === "post") return "doctor: synthetic owner voice posted as the strip's chunks, no browser (rehearsal)";
  return "doctor: typed line (rehearsal, no audio)";
}

// Nearest-rank percentile, the rule the serve's wake summary uses.
export function percentile(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export const VITALS_KINDS = new Set(["record_observation", "record_triage_vitals"]);
export const ORDER_KINDS = new Set(["order_test", "prescribe"]);
export type SpeedRowIn = { kind: string; ms: number; owner: string; line_id: string; action_id: string; from_record?: boolean };
export type SpeedErr = { kind: string; owner: string; action_id: string; state: string; reason: string | null };
// Which speed group a verified action falls in: vitals, an order, or its own kind.
export const speedGroup = (kind: string) => (VITALS_KINDS.has(kind) ? "vitals" : ORDER_KINDS.has(kind) ? "order" : kind);

// The speed table: p50 and p90 per group from the end of the words to the verified record, the errors of that group beside it.
export function speedTable(rows: readonly SpeedRowIn[], errors: readonly SpeedErr[], wakeMs: readonly number[]): { group: string; n: number; p50_ms: number | null; p90_ms: number | null; max_ms: number | null; errors: number; from_record: number }[] {
  const groups = new Map<string, SpeedRowIn[]>();
  for (const r of rows) { const g = speedGroup(r.kind); groups.set(g, [...(groups.get(g) ?? []), r]); }
  const out = [...groups.entries()].map(([group, rs]) => {
    const ms = rs.filter((r) => !r.from_record).map((r) => r.ms);
    return { group, n: ms.length, p50_ms: percentile(ms, 50), p90_ms: percentile(ms, 90), max_ms: ms.length ? Math.max(...ms) : null, errors: errors.filter((e) => speedGroup(e.kind) === group).length, from_record: rs.filter((r) => r.from_record).length };
  });
  if (wakeMs.length) out.unshift({ group: "wake", n: wakeMs.length, p50_ms: percentile(wakeMs, 50), p90_ms: percentile(wakeMs, 90), max_ms: Math.max(...wakeMs), errors: 0, from_record: 0 });
  for (const e of errors) if (!out.some((o) => o.group === speedGroup(e.kind))) out.push({ group: speedGroup(e.kind), n: 0, p50_ms: null, p90_ms: null, max_ms: null, errors: errors.filter((x) => speedGroup(x.kind) === speedGroup(e.kind)).length, from_record: 0 });
  const order = ["wake", "vitals", "order"];
  return out.sort((a, b) => (order.indexOf(a.group) + 1 || 99) - (order.indexOf(b.group) + 1 || 99) || a.group.localeCompare(b.group));
}

// held: the check found the thing only in an uncertain form (a name heard with another spelling), which is never a pass.
export type CheckOutcome = { expect: Expect; ok: boolean; optional: boolean; detail: string; held?: boolean };
export type StepOutcome = {
  line: string; patient: "A" | "B" | null; step: string; who: Who; mode: (typeof MODES)[number]; did_by: string; text: string | null; heard: string | null;
  line_id: string | null; line_end_at: string | null; verified: { kind: string; owner: string; action_id: string; record_id: string | null; verified_at: string | null; ms_from_line_end: number | null }[];
  checks: CheckOutcome[]; status: "verified" | "partial" | "held" | "failed" | "blocked" | "skipped"; confirm: "r3" | "countersign" | null; touches_during: number; errors: string[]; started_at: string; ended_at: string;
};

// A step is verified when every required check held, partial when only optional ones failed, failed otherwise; nothing completes without a check.
export function stepStatus(checks: readonly CheckOutcome[], blocked: boolean): StepOutcome["status"] {
  if (blocked) return "blocked";
  if (!checks.length) return "failed";
  if (checks.every((c) => c.ok)) return "verified";
  const missed = checks.filter((c) => !c.optional && !c.ok);
  if (!missed.length) return "partial";
  return missed.every((c) => c.held) ? "held" : "failed";
}

export type Fault = { kind: "interrupt" | "restart" | "lost_ack" | "offline" | "mute" | "reload"; line: string; at: string; killed_during: string | null; restarted_in_ms: number | null; outcome: string; ok: boolean };
export type AccTouches = { emr: number | null; strip: number | null; source: "strip counter read from the browser" | "strip counter read off the screen by a person" | "not counted"; by_line: Record<string, number>; other_people: { line: string; who: string; what: string }[] };
export type DelegationRow = { id: string; team: string; acknowledged: boolean; acknowledged_by_voice: boolean; completed_from_record: boolean; acknowledged_counted_as_done: boolean };
export type SpeakerRow = { line: string; who: Who; heard_as: string | null; acted_as_owner: boolean; order_written: boolean };

export type AccResult = {
  measured_at: string; run_id: string; kind: "rehearsal" | "final"; driver: "human" | "say" | "post" | "text" | "fake"; browser: "launched" | "none";
  script_sha256: string; engine_commit: string; pisgah: string; payment: string;
  steps: StepOutcome[]; touches: AccTouches; touches_allowed: number; confirmations_spoken: number;
  speed: { rows: SpeedRowIn[]; table: ReturnType<typeof speedTable>; wake_ms: number[] }; errors: string[]; error_rows: SpeedErr[];
  faults: Fault[]; delegations: DelegationRow[]; speakers: SpeakerRow[];
  // Completed agent writes no step's window accounts for; each one is a silent step.
  unaccounted: { owner: string; kind: string; action_id: string; completed_at: string | null }[];
  // Errors of the harness itself (driver, browser, a missing person step), kept apart from what the hospital or the agent did.
  harness_errors: string[];
  completion: { complete: boolean; reasons: string[] };
  countersign: { batches: number; batch_orders: number; batch_signed_by_voice: boolean; changed_after_batch_unsigned: boolean | null; unmatched_voice_orders: number };
  model: { calls: number; usd: number; rate_limited: number };
};

// The run is complete only when every mandatory step verified, every fault the script injects ran and recovered, and no agent write went unaccounted; green claim cards alone never make it complete.
export function completion(r: Pick<AccResult, "steps" | "faults" | "unaccounted">, expectedFaults: number): { complete: boolean; reasons: string[] } {
  const reasons = [
    ...r.steps.filter((s) => s.status !== "verified" && s.status !== "partial").map((s) => `${s.line} ${s.status}`),
    ...r.faults.filter((f) => !f.ok).map((f) => `${f.kind} at ${f.line} did not recover: ${f.outcome}`),
    ...(r.faults.length < expectedFaults ? [`${expectedFaults - r.faults.length} of ${expectedFaults} faults never ran`] : []),
    ...r.unaccounted.map((u) => `${u.kind} by ${u.owner} completed outside every step`)
  ];
  return { complete: reasons.length === 0, reasons };
}

// The claims fields C-20 to C-24 read, from one run; a field stays out when the run did not measure it, so a claim reads not measured rather than a guess.
export function claimFields(r: AccResult): Record<"C-20" | "C-21" | "C-22" | "C-23" | "C-24", Record<string, unknown>> {
  const silent = r.unaccounted.length + r.steps.filter((s) => s.status === "verified" && !s.checks.length).length;
  const g = (name: string) => r.speed.table.find((t) => t.group === name);
  const p50 = (name: string) => g(name)?.p50_ms ?? undefined;
  const c21: Record<string, unknown> = { rows: r.speed.rows.length, errors_listed: true, errors: r.error_rows.length };
  for (const [k, v] of [["wake_p50_ms", p50("wake")], ["vitals_p50_ms", p50("vitals")], ["order_p50_ms", p50("order")], ["wake_p90_ms", g("wake")?.p90_ms], ["vitals_p90_ms", g("vitals")?.p90_ms], ["order_p90_ms", g("order")?.p90_ms]] as const) if (v !== undefined && v !== null) c21[k] = v;
  const counted = r.touches.emr !== null;
  const c20: Record<string, unknown> = { touches_counted: counted, silent_steps: silent, touches_allowed: r.touches_allowed, confirmations_spoken: r.confirmations_spoken, source: r.touches.source };
  if (counted) { c20["touches"] = r.touches.emr; c20["strip_touches"] = r.touches.strip; }
  const speakers = r.speakers;
  return {
    "C-20": c20,
    "C-21": c21,
    "C-22": { batch_signed_by_voice: r.countersign.batch_signed_by_voice, unmatched_voice_orders: r.countersign.unmatched_voice_orders, batch_orders: r.countersign.batch_orders, batches: r.countersign.batches, ...(r.countersign.changed_after_batch_unsigned === null ? {} : { changed_after_batch_unsigned: r.countersign.changed_after_batch_unsigned }) },
    "C-23": { false_authority: speakers.filter((s) => s.who !== "doctor" && s.acted_as_owner).length, unmatched_orders: speakers.filter((s) => s.heard_as === "unverified" && s.order_written).length, other_clinician_recorded: speakers.filter((s) => s.heard_as === "other_clinician").length, lines: speakers.length },
    "C-24": { accepted_by_voice: r.delegations.filter((d) => d.acknowledged_by_voice).length, accepted: r.delegations.filter((d) => d.acknowledged).length, completed_from_record: r.delegations.filter((d) => d.completed_from_record).length, acknowledged_counted_as_done: r.delegations.filter((d) => d.acknowledged_counted_as_done).length, previews_with_names: 0, privilege_gained: 0, delegations: r.delegations.length }
  };
}

const CLAIM_FILES = { "C-20": "touches.json", "C-22": "countersign.json", "C-23": "speaker.json", "C-24": "delegation.json" } as const;

// Writes acceptance.json and the four claim files under <root>/evaluation/results, and adds the acceptance fields to speed.json beside the lane floor already there.
export function writeAccResults(root: string, r: AccResult, extra: { previews_with_names: number; privilege_gained: number }): string[] {
  const dir = join(root, "evaluation", "results");
  mkdirSync(dir, { recursive: true });
  const fields = claimFields(r);
  fields["C-24"]["previews_with_names"] = extra.previews_with_names;
  fields["C-24"]["privilege_gained"] = extra.privilege_gained;
  const head = { measured_at: r.measured_at, source: `acceptance ${r.kind} run ${r.run_id} (${r.driver} voice, browser ${r.browser}); payment simulated`, run_id: r.run_id, kind: r.kind };
  const written: string[] = [];
  const put = (name: string, v: unknown) => { const f = join(dir, name); writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`); written.push(f); };
  const summary = Object.fromEntries((["verified", "partial", "held", "failed", "blocked", "skipped"] as const).map((k) => [k, r.steps.filter((x) => x.status === k).map((x) => x.line)]));
  put("acceptance.json", { ...r, summary, claims: fields });
  for (const [claim, file] of Object.entries(CLAIM_FILES)) put(file, { ...head, ...fields[claim as keyof typeof CLAIM_FILES] });
  const speedFile = join(dir, "speed.json");
  const prior = existsSync(speedFile) ? (JSON.parse(readFileSync(speedFile, "utf8")) as Record<string, unknown>) : {};
  for (const k of ["wake_p50_ms", "vitals_p50_ms", "order_p50_ms", "wake_p90_ms", "vitals_p90_ms", "order_p90_ms"]) delete prior[k];
  put("speed.json", { ...prior, ...fields["C-21"], measured_at: r.measured_at, source: `${head.source}; the lane floor fields beside it are G6's integration runs, not this run`, acceptance: { ...head, table: r.speed.table, errors: r.error_rows } });
  return written;
}

// One heard line as the serve's views show it: a kept line carries its words and the ear's raw words, a withheld line only its time.
export type HeardRow = { line_id: string; text: string; at: string; kept?: boolean; decided?: boolean; ambient?: { raw_text?: string; ended_at?: string } };
const wordsOf = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
// The utterance a script line became: the unclaimed heard line whose words, as written or as the ear first wrote them, best match the script's, from a little before the step on.
// A line the agent did not act on keeps no words in the store, so with no match the step takes the first decided, withheld line heard after it began, as pass 8 did; a line still being decided may yet show its words.
export function bindLine(text: string, since: string, rows: readonly HeardRow[], claimed: Set<string>): HeardRow | null {
  const want = new Set(wordsOf(text));
  const from = new Date(Date.parse(since) - 60_000).toISOString();
  const open = rows.filter((l) => l.at >= from && !claimed.has(l.line_id));
  const score = (t: string | undefined) => { const w = wordsOf(t ?? ""); return w.length && want.size ? w.filter((x) => want.has(x)).length / Math.max(1, Math.min(want.size, w.length)) : 0; };
  const best = open.filter((l) => l.text).map((l) => ({ l, n: Math.max(score(l.text), score(l.ambient?.raw_text)) })).filter((x) => x.n >= 0.5).sort((a, b) => b.n - a.n || (a.l.at < b.l.at ? -1 : 1))[0]?.l;
  const withheld = open.filter((l) => !l.text && l.kept === false && l.decided !== false && l.at >= since).sort((a, b) => (a.at < b.at ? -1 : 1))[0];
  const hit = best ?? withheld ?? null;
  if (hit) claimed.add(hit.line_id);
  return hit;
}

// Where a reloaded page's fake microphone must start so it plays on from the moment of the reload, and the file's new zero once listening is back.
export function fakeRealign(fakeT0: number, reloadAt: number, listeningAt: number): { cutMs: number; fakeT0: number } {
  const cutMs = Math.max(0, reloadAt - fakeT0);
  return { cutMs, fakeT0: listeningAt - cutMs };
}
