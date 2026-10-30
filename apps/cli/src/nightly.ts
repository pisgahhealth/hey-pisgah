import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { projectEmr } from "@hey-pisgah/agent";
import { createModelClient } from "@hey-pisgah/model";
import { nightly } from "@hey-pisgah/intelligence";
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
    const base = { encounter, owner: t.owner, department: departmentOf(t.owner) };
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

// The five faults the publication path must refuse, made from the real memo of this run: each must end anything but delivered.
async function negatives(s: nightly.NightSources, m: nightly.Memo): Promise<{ tried: number; refused: number; cases: Record<string, string> }> {
  const f0 = m.facts[0]!;
  const tamper: Record<string, nightly.Memo> = {
    invented_figure: { ...m, facts: m.facts.map((f) => (f === f0 ? { ...f, value: f.value + 7 } : f)) },
    false_completion: { ...m, unfinished: m.unfinished.map((i, k) => (k === 0 ? { ...i, state: "done" as const } : i)) },
    patient_name: { ...m, preview: `${m.preview} ${s.labels[0] ?? "x"}` }
  };
  const cases: Record<string, string> = {};
  for (const [k, x] of Object.entries(tamper)) cases[k] = (await nightly.memoPublisher({ sources: s, transport: nightly.heldTransport(), now: () => new Date(`${s.day}T23:00:00.000Z`) }).publish(x)).verdict.status;
  const v = nightly.verifyMemo(m, s);
  cases["changed_after_verification"] = (await nightly.sendOnVerdict({ ...m, preview: `${m.preview} ` }, v, nightly.heldTransport())).reason;
  cases["checker_error"] = (await nightly.memoPublisher({ sources: s, transport: nightly.heldTransport(), check: () => { throw new Error("checker failed"); } }).publish(m)).verdict.status;
  const refused = Object.values(cases).filter((x) => x !== "verified" && x !== "delivered").length;
  return { tried: Object.keys(cases).length, refused, cases };
}

// npx tsx apps/cli/src/nightly.ts --observed f --emr-store dir [--emr-store dir] --roster f --day 2026-10-30 --run-id run-x --store dir --out-private f --out f
if (process.argv[1]?.endsWith("nightly.ts")) {
  const roster = JSON.parse(readFileSync(need("roster"), "utf8")) as { recipients: (nightly.Recipient & { authorise_own?: boolean })[]; departments: Record<string, string> };
  const dept = (owner: string) => roster.departments[owner] ?? "unknown";
  const observed = JSON.parse(readFileSync(need("observed"), "utf8")) as { cases: nightly.DayCase[] };
  const work = all("emr-store").map((d) => openWork(d, dept));
  const open = work.flatMap((w) => w.open);
  // A clinician is authorised for the encounters their own agent worked on; anyone else only for the encounters the roster file declares.
  const recipients = roster.recipients.map(({ authorise_own, ...r }) => ({ ...r, authorised: [...new Set([...r.authorised, ...(authorise_own ? open.filter((i) => i.owner === r.id).map((i) => i.encounter) : [])])] }));
  const sources: nightly.NightSources = { day: need("day"), cases: observed.cases, open, recipients, labels: work.flatMap((w) => w.labels) };
  const facts = nightly.computeFacts(sources);
  const runId = need("run-id");
  const client = createModelClient({ storeRoot: need("store"), mode: (process.env["HEY_PISGAH_MODE"] as "live" | "mock" | "replay" | undefined) ?? "mock", recordingsDir: flag("recordings") ?? `${need("store")}/../recordings`, timeoutMs: 120_000 });
  const t0 = Date.now();
  const inv = await nightly.investigateDay(facts, { client, provider: "modal", model: "meta-models/Muse-Spark-Open-816B-A42B", effort: "medium", run_id: runId });
  const hits = nightly.scanNightPrompts(inv.prompts);
  // The memo generator holds only the publisher; the transport is reached through the checks and nowhere else.
  const transport = nightly.heldTransport();
  const publisher = nightly.memoPublisher({ sources, transport, now: () => new Date(`${sources.day}T23:00:00.000Z`) });
  const results = [];
  for (const r of recipients) {
    const memo = nightly.composeMemo(sources, r, facts, inv.investigations, new Date(`${sources.day}T23:00:00.000Z`));
    results.push({ memo, result: await publisher.publish(memo) });
  }
  client.close();
  const closed = await negatives(sources, results.find((x) => x.memo.unfinished.length && x.memo.facts.length)!.memo);
  const priv = { sources_hash: nightly.sourcesHash(sources), facts, investigations: inv.investigations, deny_hits: hits, results, held_deliveries: transport.sent, calls: inv.calls, cost_usd: inv.cost_usd, ms: Date.now() - t0 };
  mkdirSync(dirname(need("out-private")), { recursive: true });
  writeFileSync(need("out-private"), `${JSON.stringify(priv, null, 1)}\n`);
  // The public file keeps statuses, counts and check codes only: no encounter id, no title, no name.
  const pub = {
    measured_at: new Date().toISOString(), measured: true, source: "nightly_run", set: "sandbox", run_id: runId, day: sources.day, sources_hash: priv.sources_hash,
    departments: inv.investigations.map((i) => ({ department: i.department, causes: i.causes.length, challenged: i.causes.filter((c) => c.critic?.verdict === "challenged").length, changes: i.changes.length, nothing_warrants_change: i.nothing_warrants_change })),
    memos: results.map(({ memo, result }) => ({ recipient_role: recipients.find((x) => x.id === memo.recipient_id)!.role, incoming: recipients.find((x) => x.id === memo.recipient_id)!.incoming, status: result.status, verdict: result.verdict.status, failures: result.verdict.failures.map((f) => f.code), repairs: result.repairs, facts: memo.facts.length, causes: memo.suspected_causes.length, changes: memo.proposed_changes.length, unfinished: memo.unfinished.length, urgent: memo.urgent.length, encounters_named: memo.unfinished.filter((i) => i.encounter).length, preview: memo.preview, nothing_warrants_change: memo.nothing_warrants_change, publish_ms: result.ms })),
    verified: results.every((x) => x.result.verdict.status === "verified"), names_in_previews: results.filter((x) => sources.labels.some((l) => l.length >= 3 && x.memo.preview.toLowerCase().includes(l.toLowerCase()))).length, unauthorised_names: results.reduce((n, x) => n + x.result.verdict.failures.filter((f) => f.code === "unauthorised_encounter" || f.code === "patient_name").length, 0),
    deny_hits: hits.length, delivered: false, delivery: "held: E4 merged the memo notification kind but no door route sends a memo, so the publisher's transport holds the deliveries", checks_failed_closed: closed.refused, checks_tried: closed.tried, negative_cases: closed.cases,
    tests: "packages/intelligence/test/nightly.test.ts", calls: inv.calls, cost_usd: inv.cost_usd, effort: "medium", purposes: ["draft_text", "other"], model: "meta-models/Muse-Spark-Open-816B-A42B"
  };
  writeFileSync(need("out"), `${JSON.stringify(pub, null, 1)}\n`);
  console.log(JSON.stringify({ memos: pub.memos.map((m) => [m.recipient_role, m.status, m.verdict, m.failures.join("|")]), calls: pub.calls, cost: pub.cost_usd, deny: pub.deny_hits }));
}
