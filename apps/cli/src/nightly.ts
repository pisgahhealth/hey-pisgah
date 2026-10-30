import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { projectEmr } from "@hey-pisgah/agent";
import { createModelClient } from "@hey-pisgah/model";
import { nightly } from "@hey-pisgah/intelligence";
import { PisgahPort, doorMemoTransport, loadProfile, type DoorDeliveryLog } from "@hey-pisgah/pisgah-adapter";
import { listStreams, readStream } from "@hey-pisgah/store";

type Row = Record<string, unknown>;
const argv = process.argv.slice(2);
const all = (k: string) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]!] : []));
const flag = (k: string) => all(k)[0];
const need = (k: string) => { const v = flag(k); if (!v) throw new Error(`--${k} is required`); return v; };

// Open work at the end of the day from the agents' own task records: unanswered questions, held obligations, and work the EMR refused or that never finished.
export function openWork(storeRoot: string, departmentOf: (owner: string) => string): { open: nightly.OpenItem[]; labels: string[] } {
  const open: nightly.OpenItem[] = [];
  const labels = new Set<string>();
  for (const sid of listStreams(storeRoot, "emr")) {
    const recs = readStream(storeRoot, sid);
    const t = projectEmr(recs);
    if (t.label) labels.add(t.label);
    const encounter = t.admission_id || t.visit_id || "";
    if (!encounter) continue;
    const seq = (type: string, key: string, id: string) => recs.find((e) => e.record_type === type && (e.payload as Row)[key] === id)?.seq ?? 0;
    // The ward the task last read for its patient, when the record named one.
    const ward = [...recs].reverse().map((e) => ((e.payload as Row)["facts"] as Row | undefined)?.["ward"]).find((w): w is string => typeof w === "string" && w.length > 0);
    const base = { encounter, owner: t.owner, department: departmentOf(t.owner), ...(ward ? { ward } : {}) };
    for (const q of t.questions.filter((x) => x.answered_by === null)) open.push({ ...base, item_id: `oi-${q.question_id}`, kind: "question", title: q.text.slice(0, 160), state: "open", due_at: null, refs: [`${sid}#${seq("question.asked", "question_id", q.question_id)}`] });
    for (const o of t.obligations.filter((x) => x.state === "held")) open.push({ ...base, item_id: `oi-${o.obligation_id}`, kind: "obligation", title: o.title.slice(0, 160), state: "held", due_at: o.due_at, refs: [`${sid}#${seq("obligation.held", "obligation_id", o.obligation_id)}`] });
    for (const id of t.order) {
      const a = t.actions.get(id)!;
      if (a.state === "completed" || a.state === "cancelled") continue;
      open.push({ ...base, item_id: `oi-${a.action_id}`, kind: "action", title: a.summary.slice(0, 160), state: a.state === "refused" || a.state === "failed" ? "failed" : "open", due_at: null, refs: [`${sid}#${seq("action.proposed", "action_id", a.action_id)}`] });
    }
  }
  return { open, labels: [...labels] };
}

type Expect = Record<string, { expect: "deliver" | "refuse"; why: string }>;
// One recipient's delivery against what the record says should happen; a refusal is correct only when the record does not authorise the recipient.
export function deliveryOutcome(r: nightly.PublishResult, expect: Expect[string] | undefined): { memo: string; reason: string | null; expected: string | null; correct: boolean | null } {
  const memo = r.not_sent.find((x) => x.kind === "memo");
  const got = r.status === "delivered" ? "deliver" : r.status === "refused" && memo?.refused ? "refuse" : null;
  return { memo: r.status, reason: memo?.reason ?? null, expected: expect?.expect ?? null, correct: expect && got ? got === expect.expect : null };
}

// npx tsx apps/cli/src/nightly.ts --observed f --emr-store dir [--emr-store dir] --roster f --day 2026-10-30 --run-id run-x --store dir --out-private f --out f [--door-profile f --bearer-file f --expect f]
if (process.argv[1]?.endsWith("nightly.ts")) {
  const roster = JSON.parse(readFileSync(need("roster"), "utf8")) as { recipients: (nightly.Recipient & { authorise_own?: boolean })[]; departments: Record<string, string> };
  const dept = (owner: string) => roster.departments[owner] ?? "unknown";
  const observed = JSON.parse(readFileSync(need("observed"), "utf8")) as { cases: nightly.DayCase[] };
  // The day's sources from the task stores; read once to write the memos and again right before each one is published.
  const readSources = (): nightly.NightSources => {
    const work = all("emr-store").map((d) => openWork(d, dept));
    const open = work.flatMap((w) => w.open);
    // A clinician is authorised for the encounters their own agent worked on; anyone else only for the encounters the roster file declares.
    const recipients = roster.recipients.map(({ authorise_own, ...r }) => ({ ...r, authorised: [...new Set([...r.authorised, ...(authorise_own ? open.filter((i) => i.owner === r.id).map((i) => i.encounter) : [])])] }));
    return { day: need("day"), cases: observed.cases, open, recipients, labels: work.flatMap((w) => w.labels) };
  };
  const sources = readSources();
  const recipients = sources.recipients;
  const facts = nightly.computeFacts(sources);
  const runId = need("run-id");
  const client = createModelClient({ storeRoot: need("store"), mode: (process.env["HEY_PISGAH_MODE"] as "live" | "mock" | "replay" | undefined) ?? "mock", recordingsDir: flag("recordings") ?? `${need("store")}/../recordings`, timeoutMs: 120_000 });
  const t0 = Date.now();
  const inv = await nightly.investigateDay(facts, { client, provider: "modal", model: "meta-models/Muse-Spark-Open-816B-A42B", effort: "medium", run_id: runId });
  const hits = nightly.scanNightPrompts(inv.prompts);
  // The memo generator holds only the publisher; the transport is reached through the checks and nowhere else.
  // With a door profile the memo goes to the hospital under the profile's sender; without one the deliveries are held.
  const doorProfile = flag("door-profile");
  const held = nightly.heldTransport();
  let doorLog: DoorDeliveryLog[] = [];
  let transport: nightly.MemoTransport = held;
  let sender: string | null = null;
  if (doorProfile) {
    const profile = loadProfile(doorProfile);
    if (!profile.memos) throw new Error("the door profile names no memo route");
    sender = profile.memos.sender_label;
    const port = new PisgahPort(profile, { bearers: { [profile.memos.sender]: readFileSync(need("bearer-file"), "utf8").trim() } });
    const door = doorMemoTransport(port, { run_id: runId });
    doorLog = door.log;
    transport = door;
  }
  const expect = (flag("expect") ? JSON.parse(readFileSync(need("expect"), "utf8")).recipients : {}) as Expect;
  const at = new Date(`${sources.day}T23:00:00.000Z`);
  // On a change the memo is written again from the fresh records with the same investigations, then checked again before it goes.
  // One bounded repair from the records: a failed statement is left out and the memo rebuilt, then checked again; still failing, it is withheld with its reasons.
  const dropped: { memo_id: string; finding_id: string; code: string; detail: string }[] = [];
  const publisher = nightly.memoPublisher({
    sources, transport, now: () => at, refresh: readSources, maxRepairs: 1, repair: nightly.repairFromRecords(sources, inv.investigations, at, dropped),
    recompose: (fresh, m) => nightly.composeMemo(fresh, fresh.recipients.find((r) => r.id === m.recipient_id)!, nightly.computeFacts(fresh), inv.investigations, at)
  });
  const results = [];
  for (const r of recipients) {
    const memo = nightly.composeMemo(sources, r, facts, inv.investigations, new Date(`${sources.day}T23:00:00.000Z`));
    const result = await publisher.publish(memo);
    results.push({ memo: result.final, result });
  }
  client.close();
  // Cost and calls from the ledger, so a repaired call is counted with the attempt it replaced.
  const ledger = listStreams(need("store"), "ledger").flatMap((sid) => readStream(need("store"), sid)).filter((e) => e.record_type === "model.call" && (e.payload as Row)["run_id"] === runId && (e.payload as Row)["mode"] !== "replay").map((e) => e.payload as { cost_usd: number });
  inv.calls = ledger.length || inv.calls;
  inv.cost_usd = ledger.length ? Math.round(ledger.reduce((n, r) => n + r.cost_usd, 0) * 1e6) / 1e6 : inv.cost_usd;
  const outcomes = results.map(({ memo, result }) => ({ memo, result, out: deliveryOutcome(result, expect[memo.recipient_id]) }));
  const throughDoor = !!doorProfile;
  // Delivered means every recipient the record authorises received the memo and every refusal was one the record calls for.
  const deliveredAll = throughDoor && outcomes.length > 0 && outcomes.every((x) => x.out.correct === true) && outcomes.some((x) => x.result.status === "delivered");
  const closed = await nightly.plantedFaults(sources, results.map((x) => x.memo), at);
  const priv = { repaired_out: dropped, sources_hash: nightly.sourcesHash(sources), facts, investigations: inv.investigations, deny_hits: hits, results, held_deliveries: held.sent, door_log: doorLog, expect, sender, calls: inv.calls, cost_usd: inv.cost_usd, ms: Date.now() - t0 };
  mkdirSync(dirname(need("out-private")), { recursive: true });
  writeFileSync(need("out-private"), `${JSON.stringify(priv, null, 1)}\n`);
  // The public file keeps statuses, counts and check codes only: no encounter id, no title, no name.
  const pub = {
    measured_at: new Date().toISOString(), measured: true, source: "nightly_run", set: "sandbox", run_id: runId, day: sources.day, sources_hash: priv.sources_hash,
    departments: inv.investigations.map((i) => ({ department: i.department, causes: i.causes.length, challenged: i.causes.filter((c) => c.critic?.verdict === "challenged").length, changes: i.changes.length, nothing_warrants_change: i.nothing_warrants_change })),
    memos: results.map(({ memo, result }) => ({ recipient_role: recipients.find((x) => x.id === memo.recipient_id)!.role, incoming: recipients.find((x) => x.id === memo.recipient_id)!.incoming, status: result.status, verdict: result.verdict.status, failures: result.verdict.failures.map((f) => f.code), repairs: result.repairs, facts: memo.facts.length, causes: memo.suspected_causes.length, changes: memo.proposed_changes.length, unfinished: memo.unfinished.length, urgent: memo.urgent.length, encounters_named: memo.unfinished.filter((i) => i.encounter).length, preview: memo.preview, nothing_warrants_change: memo.nothing_warrants_change, publish_ms: result.ms })),
    verified: results.every((x) => x.result.verdict.status === "verified"), names_in_previews: results.filter((x) => sources.labels.some((l) => l.length >= 3 && x.memo.preview.toLowerCase().includes(l.toLowerCase()))).length, unauthorised_names: results.reduce((n, x) => n + x.result.verdict.failures.filter((f) => f.code === "unauthorised_encounter" || f.code === "patient_name").length, 0),
    deny_hits: hits.length, delivered: deliveredAll,
    delivery: !throughDoor ? "held: no door profile was given, so the publisher's transport holds the deliveries"
      : deliveredAll ? "every authorised recipient received the memo and every refusal was correct"
      : `through the door: ${outcomes.filter((x) => x.out.correct === false).length} recipient(s) not as the record calls for, ${outcomes.filter((x) => x.out.correct === null).length} without a record expectation`,
    sender,
    // The counts C-28 reads: recipients the record authorises against those who received it, and refusals against the correct ones.
    recipients: outcomes.length, authorised_recipients: outcomes.filter((x) => x.out.expected === "deliver").length,
    authorised_delivered: outcomes.filter((x) => x.out.expected === "deliver" && x.result.status === "delivered").length,
    refusals: outcomes.filter((x) => x.out.memo === "refused").length, correct_refusals: outcomes.filter((x) => x.out.memo === "refused" && x.out.correct === true).length,
    incorrect_outcomes: outcomes.filter((x) => x.out.correct !== true).length,
    delivery_results: outcomes.map(({ memo, result, out }) => ({ recipient_role: recipients.find((x) => x.id === memo.recipient_id)!.role, incoming: recipients.find((x) => x.id === memo.recipient_id)!.incoming, ...out, why: expect[memo.recipient_id]?.why ?? null, task_alerts_not_sent: result.not_sent.filter((x) => x.kind !== "memo").length, urgent_alerts_sent: result.delivered.filter((x) => x.kind === "urgent").length })), checks_failed_closed: closed.refused, checks_tried: closed.tried, negative_cases: closed.cases, negative_not_applicable: closed.not_applicable,
    repairs: results.reduce((n, x) => n + x.result.repairs, 0), repaired_out: dropped.map(({ finding_id, code }) => ({ finding_id, code })),
    withheld_reasons: results.filter((x) => x.result.status === "withheld").map((x) => ({ recipient_role: recipients.find((r) => r.id === x.memo.recipient_id)!.role, codes: x.result.verdict.failures.map((f) => f.code) })),
    refreshed: results.map((x) => x.result.refreshed), urgent_alerts: results.reduce((n, x) => n + x.result.delivered.filter((d) => d.kind === "urgent").length, 0), urgent_items: results.reduce((n, x) => n + x.memo.urgent.length, 0),
    // Each urgent item of a recipient the record authorises must ring as its own alert, not only inside the memo.
    urgent_items_authorised: outcomes.filter((x) => x.out.expected === "deliver").reduce((n, x) => n + x.memo.urgent.length, 0),
    urgent_alerts_authorised: outcomes.filter((x) => x.out.expected === "deliver").reduce((n, x) => n + x.result.delivered.filter((d) => d.kind === "urgent").length, 0),
    tests: "packages/intelligence/test/nightly.test.ts", model_mode: process.env["HEY_PISGAH_MODE"] ?? "mock", calls: inv.calls, cost_usd: inv.cost_usd, effort: "medium", purposes: ["draft_text", "other"], model: "meta-models/Muse-Spark-Open-816B-A42B"
  };
  writeFileSync(need("out"), `${JSON.stringify(pub, null, 1)}\n`);
  console.log(JSON.stringify({ memos: pub.memos.map((m) => [m.recipient_role, m.status, m.verdict, m.failures.join("|")]), delivery: pub.delivery_results.map((d) => [d.recipient_role, d.memo, d.expected, d.correct]), delivered: pub.delivered, calls: pub.calls, cost: pub.cost_usd, deny: pub.deny_hits }));
}
