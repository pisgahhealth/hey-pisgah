import { LedgerRow, type HypothesisRecord, type WorkflowChangeProposal } from "@hey-pisgah/contracts";
import { readStream } from "@hey-pisgah/store";
import { denyScan } from "./deny.js";
import { appTexts } from "./prompts.js";
import { STREAMS, sessionStreamId, type Arm, type StoredExperiment } from "./session.js";

const READ_TOOLS = new Set(["list_cases", "get_case_timeline", "get_record", "compute_intervals", "get_queue_snapshot", "get_staff_activity", "get_ward_requirements", "get_workflow_definition"]);
type Row = Record<string, unknown>;
const payloads = (root: string, id: string, type: string): Row[] => readStream(root, id).filter((e) => e.record_type === type).map((e) => e.payload as Row);

export type DiscoveryCheck = { pass: boolean; lines: string[]; summary: Row };

// Reads one run's streams and reports hypotheses, experiments with their prediction checks, the outcome, cost and the deny-list scan.
export function checkDiscovery(storeRoot: string, runId: string): DiscoveryCheck {
  const log = readStream(storeRoot, sessionStreamId(runId));
  const opened = log.find((e) => e.record_type === "session.opened")?.payload as Row | undefined;
  if (!opened) return { pass: false, lines: [`check:discovery ${runId}: no such run`], summary: {} };
  const arm = opened.arm as Arm;
  const stopped = log.find((e) => e.record_type === "session.stopped")?.payload as Row | undefined;
  const result = log.find((e) => e.record_type === "session.result")?.payload as Row | undefined;
  const hyps = payloads(storeRoot, STREAMS.hypotheses, "hypothesis.recorded").filter((h) => h.session_id === runId) as unknown as HypothesisRecord[];
  const statuses = payloads(storeRoot, STREAMS.hypotheses, "hypothesis.status_changed").filter((h) => h.session_id === runId);
  const refused = payloads(storeRoot, STREAMS.hypotheses, "hypothesis.status_refused").filter((h) => h.session_id === runId);
  const exps = readStream(storeRoot, STREAMS.experiments).filter((e) => (e.payload as Row).session_id === runId);
  const done = exps.filter((e) => e.record_type === "experiment.completed").map((e) => e.payload as StoredExperiment);
  const aborted = exps.filter((e) => e.record_type === "experiment.aborted").length;
  const invalid = exps.filter((e) => e.record_type === "experiment.invalid").length;
  const linked = new Set(log.filter((e) => e.record_type === "proposal.linked").map((e) => (e.payload as Row).proposal_id as string));
  const props = payloads(storeRoot, STREAMS.proposals, "proposal.submitted").filter((p) => linked.has(p.proposal_id as string)) as unknown as WorkflowChangeProposal[];
  const reports = payloads(storeRoot, STREAMS.validations, "validation.completed").map((v) => v.report as Row).filter((r) => linked.has(r.proposal_id as string));
  const rows = readStream(storeRoot, `ledger/${runId}`).filter((e) => e.record_type === "model.call").map((e) => LedgerRow.parse(e.payload));
  const tools = log.filter((e) => e.record_type === "tool.called").map((e) => e.payload as Row);

  const lines: string[] = [];
  const say = (s: string) => lines.push(s);
  const last = new Map<string, string>(hyps.map((h) => [h.hypothesis_id, "open"]));
  for (const s of statuses) last.set(s.hypothesis_id as string, s.status as string);
  const competed = hyps.filter((h) => Array.isArray(h.competing) || hyps.some((o) => Array.isArray(o.competing) && o.competing.includes(h.hypothesis_id)));
  const reasoned = hyps.filter((h) => !Array.isArray(h.competing));
  say(`run ${runId}  arm ${arm}  mode ${String(opened.mode)}  model ${String(opened.model)}  effort ${String(opened.effort ?? (opened.settings as Row).effort)}`);
  const c = opened.commitment as { revision: number | null; hash: string | null } | null;
  say(`commitment ${c?.revision ? `revision ${c.revision} ${String(c.hash).slice(0, 12)}` : "none"}  prompt ${String((opened.hashes as Row).prompt).slice(0, 12)}  tools ${String((opened.hashes as Row).tools).slice(0, 12)}`);
  say(`hypotheses ${hyps.length}: ${competed.length} in a competing pair, ${reasoned.length} with a stated reason`);
  for (const h of hyps) say(`  ${h.hypothesis_id} ${last.get(h.hypothesis_id)}  ${h.statement.slice(0, 110)}`);
  say(`experiments ${done.length} completed, ${aborted} aborted, ${invalid} refused`);
  for (const x of done) {
    const pc = x.prediction_check;
    const req = x.request as { ops?: unknown[]; case_ids?: string[] };
    say(`  ${x.experiment_id} ops ${JSON.stringify(req.ops)} cases ${(req.case_ids ?? []).length}`);
    say(`    before: speaks to ${pc.before.speaks_to.join(", ") || "none"}; distinguishes ${pc.before.distinguishes.map((p) => p.join(" vs ")).join(", ") || "no pair"}`);
    const per = Object.entries(pc.after?.per_hypothesis ?? {}).map(([h, v]) => `${h} ${v.landed}`).join(", ");
    say(`    after: ${per || "nothing landed"}; contradicted ${pc.after?.contradicted.join(", ") || "none"}`);
    if (x.behaviour) say(`    behaviour: event logs identical to control in ${x.behaviour.event_logs_identical_to_control}${x.behaviour.note ? "; behaviour unchanged" : ""}`);
  }
  const pairRefused = exps.filter((e) => e.record_type === "experiment.refused_pair").length;
  const reasons = done.filter((x) => x.no_pair_reason).map((x) => `${x.experiment_id}: ${String(x.no_pair_reason).slice(0, 120)}`);
  say(`pair gate: ${pairRefused} refused, ${reasons.length} run on a stated no_pair_reason${reasons.length ? ` (${reasons.join("; ")})` : ""}`);
  say(`say-do mismatches ${refused.length}`);
  for (const p of props) {
    const r = reports.find((x) => x.proposal_id === p.proposal_id);
    say(`proposal ${p.proposal_id} ops ${JSON.stringify(p.ops)} scope ${JSON.stringify(p.scope)} validation ${r ? String(r.status) : "pending"}`);
  }
  if (result) say(`declared result ${String(result.result)}: ${String(result.note).slice(0, 160)}`);
  const usd = rows.reduce((s, r) => s + r.cost_usd, 0);
  const promptTokens = rows.reduce((s, r) => s + r.prompt_tokens, 0);
  const promptPerCall = rows.length ? Math.round(promptTokens / rows.length) : 0;
  const promptMax = rows.reduce((m, r) => Math.max(m, r.prompt_tokens), 0);
  const lat = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
  say(`stop ${String(stopped?.stop ?? "not stopped")}  calls ${rows.length}  cost $${usd.toFixed(4)}  prompt ${promptTokens} (${promptPerCall} a call, max ${promptMax})  completion ${rows.reduce((s, r) => s + r.completion_tokens, 0)}  reasoning ${rows.reduce((s, r) => s + (r.reasoning_tokens ?? 0), 0)}  latency p50 ${lat.length ? lat[Math.floor(lat.length / 2)] : 0} ms`);
  const counters = (stopped?.counters ?? {}) as Row;
  const failed = tools.filter((t) => t.ok === false).length;
  say(`definition unchanged answers ${Number(counters.definition_unchanged ?? 0)}  reading-budget refusals ${Number(counters.read_refusals ?? 0)}  experiment-budget refusals ${Number(counters.experiment_budget_refusals ?? 0)}  hypothesis schema errors ${Number(counters.hypothesis_schema_errors ?? 0)}  timeline pages ${Number(counters.timeline_pages ?? 0)}`);
  say(`repairs ${Number(counters.repairs ?? 0)}  tool calls ${tools.length}  refused tool calls ${failed}  efforts ${[...new Set(rows.map((r) => r.effort))].join(",") || "-"}`);

  const notes = log.filter((e) => e.record_type === "note.recorded").map((e) => e.payload as Row);
  say(`notes ${notes.length}`);
  for (const n of notes) say(`  ${String(n.number)}. ${String(n.note).slice(0, 140)}`);
  const scanned = [
    ...notes.map((n) => ({ label: `note.${String(n.number)}`, text: String(n.note) })),
    ...appTexts(arm),
    { label: "session.system", text: String(opened.system_prompt) },
    { label: "session.kickoff", text: String(opened.kickoff) },
    ...tools.filter((t) => READ_TOOLS.has(t.name as string)).map((t, i) => ({ label: `tool_output.${String(t.name)}.${i}`, text: String(t.result) }))
  ];
  const hits = denyScan(scanned);
  say(`deny-list scan: ${scanned.length} texts, ${hits.length} hits${hits.length ? `: ${hits.slice(0, 5).map((h) => `${h.label} /${h.pattern}/`).join("; ")}` : ""}`);

  const needs = {
    hypotheses: arm === "prior" || competed.length >= 2 || reasoned.length >= 1,
    experiment: arm === "prior" || arm === "a3" || done.some((x) => x.prediction_check.after !== null),
    outcome: props.length > 0 || result !== undefined,
    deny_list: hits.length === 0,
    stopped: stopped !== undefined
  };
  const pass = Object.values(needs).every(Boolean);
  say(`check: ${Object.entries(needs).map(([k, v]) => `${k} ${v ? "pass" : "FAIL"}`).join("  ")}  => ${pass ? "PASS" : "FAIL"}`);
  return { pass, lines, summary: { run_id: runId, arm, needs, calls: rows.length, usd, prompt_tokens: promptTokens, prompt_tokens_per_call: promptPerCall, prompt_tokens_max: promptMax, hypotheses: hyps.length, experiments: done.length, aborted, invalid, pair_refusals: pairRefused, no_pair_reasons: reasons.length, say_do_mismatches: refused.length, notes: notes.length, definition_unchanged: Number(counters.definition_unchanged ?? 0), read_refusals: Number(counters.read_refusals ?? 0), experiment_budget_refusals: Number(counters.experiment_budget_refusals ?? 0), hypothesis_schema_errors: Number(counters.hypothesis_schema_errors ?? 0), proposals: props.map((p) => p.proposal_id), validations: reports.map((r) => r.status), stop: stopped?.stop ?? null, deny_hits: hits.length } };
}
