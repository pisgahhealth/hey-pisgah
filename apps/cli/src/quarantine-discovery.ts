import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LedgerRow, sha256 } from "@hey-pisgah/contracts";
import { runValidationStream, validateProposal } from "@hey-pisgah/evaluator";
import { CYCLE, Session, checkDiscovery, commitmentFor, denyScan, loadVariant, preconditionTable, runCycleLoop, runRecord, scriptedInvestigator, type LoopOutcome } from "@hey-pisgah/intelligence";
import { createModelClient, type CallArgs, type ChatMessage, type ModelClient, type Mode } from "@hey-pisgah/model";
import { readStream } from "@hey-pisgah/store";

// Quarantined discovery experiments; these texts never enter a committed prompt, tool, commitment, claim or fixture.
const PLAYBOOK = "If an operation changes nothing: (a) check the operation's preconditions in the precondition table; (b) check whether another constraint still binds the same step; (c) test it combined with each operation that affects the same step.";
const TABLE = `Precondition table: ${JSON.stringify(preconditionTable())}`;
const MULTI = "Some workflow changes need more than one operation before any step behaves differently.";
const ACTIVITY = "The change that serves the hospital's aim involves the step where the nurse prepares the discharge summary draft.";
const ANSWER = "The answer in words: let the nurse's discharge summary draft start once the take-home medicines are ordered, instead of waiting for the doctor's clinical discharge.";

// The hint ladder; each rung keeps every hint below it.
export const RUNGS = { L0: [], L1: [PLAYBOOK], L2: [PLAYBOOK, TABLE], L3: [PLAYBOOK, TABLE, MULTI], L4: [PLAYBOOK, TABLE, MULTI, ACTIVITY], L5: [PLAYBOOK, TABLE, MULTI, ACTIVITY, ANSWER] } as const;
export type Rung = keyof typeof RUNGS;
export const hintText = (r: Rung): string => (RUNGS[r].length ? `Quarantined hint for this session:\n${RUNGS[r].join("\n")}` : "");

export const SHARED_HEADER = "Shared ledger: what the other investigators on this pool have recorded so far, kept by their sessions from tool results. Their hypothesis, experiment and proposal ids belong to their sessions and cannot be cited here; run an experiment yourself to cite its result.";

type Row = Record<string, unknown>;
const root = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const argv = process.argv.slice(2);
const all = (n: string) => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]!] : []));
const flag = (n: string) => all(n)[0];
const mode = (process.env.HEY_PISGAH_MODE as Mode | undefined) ?? "mock";

// The other investigators' ledgers in short form: statements, experiments with their receipts' outcome, and proposals.
export function sharedLedger(others: readonly { k: number; s: Session }[]): string {
  const view = others.map(({ k, s }) => {
    const l = s.ledger() as { hypotheses: Row[]; experiments: Row[]; proposals: Row[] };
    return { investigator: k, hypotheses: l.hypotheses.map((h) => ({ status: h.status, statement: h.statement, mechanism: h.mechanism, predicted: h.predicted })), experiments: l.experiments.map((x) => ({ ops: x.ops, expected_change: x.expected_change, delivered: x.delivered, outcome: x.outcome, median_delta: x.median_delta, first_divergence: x.first_divergence })), proposals: l.proposals.map((p) => ({ ops: p.ops, validation: p.validation })) };
  }).filter((v) => v.hypotheses.length || v.experiments.length || v.proposals.length);
  return view.length ? `${SHARED_HEADER}\n${JSON.stringify(view)}` : "";
}

// Wraps the client so the quarantined text rides after the kickoff, and the shared ledger after each cycle's ledger, snapshotted once per cycle.
export function quarantined(client: ModelClient, s: Session, hint: string, shared?: () => string): ModelClient {
  const snapshots = new Map<string, string>();
  const call = async (args: CallArgs) => {
    const m = [...args.messages] as ChatMessage[];
    if (hint && m[1]?.role === "user" && typeof m[1].content === "string") m[1] = { role: "user", content: `${m[1].content}\n${hint}` };
    if (shared && m[2]?.role === "user" && typeof m[2].content === "string") {
      const key = m[2].content;
      if (!snapshots.has(key)) {
        const text = shared();
        snapshots.set(key, text);
        s.log("quarantine.shared_ledger", { cycle: s.cycle, text, hash: sha256(text) });
      }
      const text = snapshots.get(key)!;
      if (text) m.splice(3, 0, { role: "user", content: text });
    }
    return client.call({ ...args, messages: m });
  };
  return new Proxy(client, { get: (t, p) => (p === "call" ? call : typeof (t as any)[p] === "function" ? (t as any)[p].bind(t) : (t as any)[p]) });
}

type Spec = { store: string; runId: string; effort: "low" | "medium" | "high"; maxCalls: number; budgetUsd: number; hint: string; label: string };
function open(sp: Spec): { client: ModelClient; session: Session } {
  const client = createModelClient({ storeRoot: sp.store, mode, recordingsDir: join(sp.store, "recordings"), mock: scriptedInvestigator("adaptive"), timeoutMs: 300_000, budget: { runUsd: sp.budgetUsd, runMaxCalls: sp.maxCalls, weekUsd: 120, weekStopFraction: 0.8, weekSince: () => new Date(Date.now() - 7 * 24 * 3600 * 1000) } });
  const session = new Session({ storeRoot: sp.store, runId: sp.runId, arm: "adaptive", validate: async (st) => { await runValidationStream(st); }, usage: () => ({ ...client.runUsage(sp.runId), max_calls: sp.maxCalls, max_usd: sp.budgetUsd }) });
  return { client, session };
}

async function run(sp: Spec, session: Session, client: ModelClient, shared?: () => string): Promise<LoopOutcome> {
  const commitment = commitmentFor(root, "adaptive");
  if (mode === "live" && !commitment) throw new Error("the adaptive arm does not match the last committed revision");
  session.log("quarantine.opened", { label: sp.label, run_label: `quarantine/${sp.runId}`, hint: sp.hint, hint_hash: sha256(sp.hint), shared_ledger: shared !== undefined, max_cycles: CYCLE.max_cycles });
  return runCycleLoop({ client: quarantined(client, session, sp.hint, shared), session, maxCalls: sp.maxCalls, budgetUsd: sp.budgetUsd, effort: sp.effort, commitment: commitment ?? { revision: null, hash: null } });
}

// Total spend over every ledger under a directory, so the lane can stop before its cap.
export function spendUnder(dir: string): number {
  let usd = 0;
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { if (f !== "recordings") walk(p); continue; }
      if (d.endsWith("/ledger") && f.endsWith(".jsonl")) for (const e of readStream(join(d, ".."), `ledger/${f.replace(/\.jsonl$/, "")}`)) if (e.record_type === "model.call") usd += LedgerRow.parse(e.payload).cost_usd;
    }
  };
  if (existsSync(dir)) walk(dir);
  return Math.round(usd * 1e4) / 1e4;
}

const proposal = (ops: unknown[], tag: string) => ({ proposal_id: `p-${tag}`, parent_proposal_id: null, base_version: 1, ops, scope: { wards: "all", condition: null }, rationale: "share", evidence: { hypothesis_ids: [], experiment_ids: [], event_ids: [] }, expected_effects: [], known_exceptions: [], viewed_case_ids: [], status: "submitted", hash: "0".repeat(64) });
const gain = (r: { cases: { delta: { post_signoff_wait_min: number | null } }[] }) => -r.cases.reduce((n, c) => n + (c.delta.post_signoff_wait_min ?? 0), 0);

// One run's record with its share of the planted gain, the deny-list scan of the injected texts, and the first call at which a proposal passed the gate.
async function record(store: string, runId: string, label: string): Promise<Row> {
  const r = runRecord(store, runId, label);
  const v = loadVariant("pair");
  const planted = gain(await validateProposal(proposal(v.planted, "0000aaa1") as never, {}));
  const props = readStream(store, "learning/proposals").filter((e) => e.record_type === "proposal.submitted").map((e) => e.payload as { proposal_id: string; ops: unknown[]; scope: unknown });
  const shares: Row[] = [];
  for (const p of props.filter((x) => (r.proposals as string[]).includes(x.proposal_id))) {
    const rep = await validateProposal({ ...proposal(p.ops, "0000ccc1"), scope: p.scope } as never, {});
    shares.push({ proposal_id: p.proposal_id, ops: p.ops, status: rep.status, share_of_planted: Math.round((gain(rep) / Math.max(1, planted)) * 100) / 100 });
  }
  const log = readStream(store, `discovery/${runId}`);
  const q = log.find((e) => e.record_type === "quarantine.opened")?.payload as Row | undefined;
  const sharedTexts = log.filter((e) => e.record_type === "quarantine.shared_ledger").map((e) => String((e.payload as Row).text));
  const hintHits = denyScan(q?.hint ? [{ label: "hint", text: String(q.hint) }] : []);
  const headerHits = denyScan(sharedTexts.length ? [{ label: "shared_header", text: SHARED_HEADER }] : []);
  const echoedHits = denyScan(sharedTexts.map((t, i) => ({ label: `shared.${i}`, text: t })));
  const deliveredPlanted = (r.experiments as { expected_change: { step: string } | null; outcome_class: string | null }[]).some((x) => x.outcome_class === "delivered_outcome_better" && x.expected_change !== null && v.planted_steps.includes(x.expected_change.step));
  const c = checkDiscovery(store, runId);
  const stopped = log.find((e) => e.record_type === "session.stopped")?.payload as Row | undefined;
  const validatedAt = log.filter((e) => e.record_type === "tool.called" && (e.payload as Row).name === "submit_proposal" && String((e.payload as Row).result).includes("dev_validated")).map((e) => Number((e.payload as Row).turn))[0] ?? null;
  return {
    run_label: `quarantine/${runId}`, ...r, label, planted_gain_min: planted, proposal_shares: shares, found_planted: shares.some((x) => x.status === "dev_validated" && Number(x.share_of_planted) >= 0.9), planted_step_delivered_better: deliveredPlanted,
    simulations: ((stopped?.counters ?? {}) as Row).simulations ?? null, dev_validated_at_turn: validatedAt,
    deny_scan: { main_lane_texts_hits: c.summary.deny_hits, hint_hits: hintHits.map((h) => h.pattern), shared_header_hits: headerHits.map((h) => h.pattern), shared_ledger_echoed_hits: echoedHits.map((h) => `${h.label} /${h.pattern}/`) },
    hint: q?.hint ?? null, max_cycles: q?.max_cycles ?? null
  };
}

async function main(): Promise<void> {
  const cmd = argv[0];
  if (cmd === "spend") { console.log(spendUnder(flag("dir")!)); return; }
  if (cmd === "ladder" || cmd === "long") {
    const rung = (flag("rung") ?? "L0") as Rung;
    if (!(rung in RUNGS)) throw new Error("--rung takes L0 to L5");
    if (flag("max-cycles")) Object.assign(CYCLE, { max_cycles: Number(flag("max-cycles")) });
    const sp: Spec = { store: flag("store")!, runId: flag("run-id")!, effort: flag("effort") as Spec["effort"], maxCalls: Number(flag("max-calls")), budgetUsd: Number(flag("budget-usd")), hint: cmd === "ladder" ? hintText(rung) : "", label: cmd === "ladder" ? `ladder ${rung}` : "long loop" };
    if (!sp.effort) throw new Error("--effort is required");
    const { client, session } = open(sp);
    try { console.log(JSON.stringify(await run(sp, session, client))); } finally { session.close(); client.close(); }
    for (const l of checkDiscovery(sp.store, sp.runId).lines) console.log(l);
    return;
  }
  if (cmd === "parallel") {
    const dir = flag("dir")!;
    const n = Number(flag("n") ?? 8);
    const effort = flag("effort") as Spec["effort"];
    if (!effort) throw new Error("--effort is required");
    const each = Array.from({ length: n }, (_, i) => {
      const sp: Spec = { store: join(dir, `p${i + 1}`), runId: `run-q7p${flag("group") ?? "0"}000${i + 1}`, effort, maxCalls: Number(flag("max-calls-each")), budgetUsd: Number(flag("budget-usd-each")), hint: "", label: `parallel ${i + 1} of ${n}` };
      return { k: i + 1, sp, ...open(sp) };
    });
    const out = await Promise.all(each.map((x) => run(x.sp, x.session, x.client, () => sharedLedger(each.filter((o) => o.k !== x.k).map((o) => ({ k: o.k, s: o.session })))).catch((e: unknown) => ({ error: String(e) }))));
    for (const x of each) { x.session.close(); x.client.close(); }
    out.forEach((o, i) => console.log(`p${i + 1} ${JSON.stringify(o)}`));
    return;
  }
  if (cmd === "publish") {
    const file = flag("out")!;
    const group = flag("group")!;
    const runs: Row[] = [];
    for (const spec of all("run")) { const [store, id, label] = spec.split("=") as [string, string, string]; runs.push(await record(store, id, label)); }
    const count = (f: (r: Row) => boolean) => runs.filter(f).length;
    const k = { n: runs.length, dev_valid_proposal: count((r) => r.outcome === "dev_valid_proposal"), found_planted: count((r) => r.found_planted === true), planted_step_delivered_better: count((r) => r.planted_step_delivered_better === true), usd: Math.round(runs.reduce((s, r) => s + Number(r.cost_usd), 0) * 1e4) / 1e4, calls: runs.reduce((s, r) => s + Number(r.calls), 0) };
    const prev = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Row) : { artifact: "discovery-quarantine", note: "Quarantined lane G7: hint ladder, parallel investigators, second-model separator, revision 12 repeats. Nothing here enters a main-lane prompt, commitment, claim or fixture.", groups: {} };
    const groups = { ...(prev.groups as Row), [group]: { measured_at: new Date().toISOString(), commitment: commitmentFor(root, "adaptive"), k_of_n: k, runs } };
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...prev, groups }, null, 1)}\n`);
    renameSync(`${file}.tmp`, file);
    console.log(group, JSON.stringify(k));
    return;
  }
  if (cmd === "note") {
    const file = flag("out")!;
    const prev = JSON.parse(readFileSync(file, "utf8")) as Row;
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...prev, [flag("key")!]: JSON.parse(readFileSync(flag("json")!, "utf8")) as unknown }, null, 1)}\n`);
    renameSync(`${file}.tmp`, file);
    return;
  }
  console.log("quarantine-discovery spend|ladder|long|parallel|publish|note");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
