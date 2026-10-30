import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { HospitalPort, VERSIONS_STREAM, VersionDesk, deployCheck, loadCases, project, readVersion, caseFacts, type Counterparts } from "@hey-pisgah/agent";
import { findCase } from "@hey-pisgah/cases";
import { definitionHash, type WorkflowDefinition as WD } from "@hey-pisgah/contracts";
import { loadManifests, runAcceptance, runCase } from "@hey-pisgah/evaluator";
import { loadV1, worldRules } from "@hey-pisgah/hospital";
import { readStream } from "@hey-pisgah/store";
import { Registry, type Facts } from "@hey-pisgah/workflow";
import { adoptionApproval } from "./approval.js";
import { devDistribution, devFields } from "./dev-distribution.js";

type Row = Record<string, unknown>;
const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const need = (k: string) => { const v = flag(k); if (!v) throw new Error(`--${k} is required`); return v; };
const lines = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { record_type: string; payload: Row; seq: number });

// child: the parent proposal with the scope the adopting person set, linked to its parent and re-validated by the evaluator before adoption.
export function narrowedChild(parent: Row, wards: string[], note: string): Row {
  const { proposal_id: pid, hash: _h, status: _s, ...rest } = parent;
  const why = ` Scope set at adoption: ${note}`;
  const rationale = `${String(rest["rationale"] ?? "").slice(0, 600 - why.length)}${why}`;
  return { ...rest, parent_proposal_id: pid, scope: { wards, condition: null }, rationale };
}

// The first start of a step in a run's events, in case minutes.
const firstAt = (events: readonly Row[], kind: string, step: string): number | null => {
  const e = events.find((x) => x["kind"] === kind && (x["payload"] as Row | undefined)?.["step_id"] === step);
  return e ? Number(e["occurred_at"]) : null;
};

// What the agent did in one live task under the version its case resolved to, read from the task stream and the case's own port.
function liveTask(store: string, desk: VersionDesk, taskId: string): Row {
  const recs = readStream(store, `tasks/${taskId}`);
  const p = project(recs);
  const world = loadCases().get(p.case_id)!;
  const port = HospitalPort.open(store, world, desk.registry, worldRules());
  try {
    const run = port.run();
    const file = findCase(p.case_id)!.file;
    const man = loadManifests("demo").get(p.case_id)!;
    const ac = runAcceptance({ run, manifest: man, requirement_version: String(file.initial_state.requirement_version), definition: port.caseDef, schedule: world.schedule, version: { status: "adopted", version_hash: definitionHash(port.caseDef), in_scope: true, fallback_hash: null, adopted_at_min: 0 } });
    const acts = p.order.map((id) => p.actions.get(id)!);
    const intentAt = (id: string) => recs.find((e) => e.record_type === "action.intent" && (e.payload as Row)["action_id"] === id)?.recorded_at ?? null;
    const prepared = acts.filter((a) => a.action_kind === "prepare_document").map((a) => ({ document_id: a.args["document_id"], stage: a.args["stage"], at: intentAt(a.action_id), state: a.state, proved: a.state === "completed" }));
    const ledger = readStream(store, `ledger/${p.run_id}`).filter((e) => e.record_type === "model.call").map((e) => e.payload as { cost_usd: number; effort: string; model: string; latency_ms: number });
    const ev = run.events as unknown as Row[];
    return {
      task_id: taskId, case_id: p.case_id, ward_id: world.schedule.facts["ward_id"], workflow_version: p.workflow_version, definition_hash: port.def.definition_hash,
      state: p.state, reason: p.reason, actions: acts.length, actions_proved: acts.filter((a) => a.state === "completed").length,
      // A refused action is a guard that held, counted beside the others; an action still open or failed has no proof.
      actions_refused: acts.filter((a) => a.state === "refused").length, actions_open: acts.filter((a) => a.state !== "completed" && a.state !== "refused").length,
      completed_with_proof: acts.filter((a) => a.state === "completed" && !!a.proof).length,
      acceptance: { pass: ac.checks.filter((c) => c.pass).length, of: ac.checks.length, failed: ac.checks.filter((c) => !c.pass).map((c) => c.ac) },
      round_entry_at: firstAt(ev, "step.completed", "st01"), signoff_at: firstAt(ev, "step.completed", "st05"),
      summary_draft_at: prepared.find((x) => x.document_id === "discharge_summary" && x.stage === "draft")?.at ?? null, prepared,
      post_signoff_wait_min: run.metrics.post_signoff_wait_min, rework_events: run.metrics.rework_events, rework_min: run.metrics.rework_min,
      effect_set_hash: p.closed?.["effect_set_hash"] ?? null, check_failed: recs.filter((e) => e.record_type === "version.check_failed").length,
      calls: ledger.length, cost_usd: Math.round(ledger.reduce((n, l) => n + l.cost_usd, 0) * 1e6) / 1e6, efforts: [...new Set(ledger.map((l) => l.effort))], models: [...new Set(ledger.map((l) => l.model))]
    };
  } finally { port.close(); }
}

// The same case under each version with the definition executor and no model, so the version alone explains the difference.
function counterfactual(caseId: string, defs: Record<string, WD>): Row {
  const s = loadCases().get(caseId)!.schedule;
  return Object.fromEntries(Object.entries(defs).map(([k, d]) => {
    const r = runCase(d, s);
    if (r.outcome !== "ok") return [k, { outcome: r.outcome }];
    const ev = r.events as unknown as Row[];
    return [k, { summary_draft_start: firstAt(ev, "step.started", "st06"), signoff: firstAt(ev, "step.completed", "st05"), post_signoff_wait_min: r.metrics.post_signoff_wait_min, rework_events: r.metrics.rework_events, rework_min: r.metrics.rework_min }];
  }));
}

// The dev gate's report for the adopted version, found through the validation reference its creation logged.
function adoptedValidation(store: string, created: Row): Parameters<typeof devDistribution>[0] {
  const ref = created["validation_ref"] as { stream_id: string; seq: number };
  const e = readStream(store, ref.stream_id).find((x) => x.seq === ref.seq);
  if (!e) throw new Error(`no validation at ${ref.stream_id}#${ref.seq}`);
  return (e.payload as { report: Parameters<typeof devDistribution>[0] }).report;
}

if (argv[0] === "child") {
  const parentId = need("parent");
  const sub = lines(need("parent-file")).find((e) => e.record_type === "proposal.submitted" && e.payload["proposal_id"] === parentId);
  if (!sub) throw new Error(`no submitted proposal ${parentId}`);
  writeFileSync(need("out"), `${JSON.stringify(narrowedChild(sub.payload, need("wards").split(","), need("note")), null, 1)}\n`);
} else if (argv[0] === "outcomes") {
  // The verified engine events of the two live runs, in the outcome shape the second cycle reads.
  const store = need("store");
  const desk = new VersionDesk(store, Registry.load([loadV1()]));
  try {
    const cases = need("tasks").split(",").map((taskId) => {
      const p = project(readStream(store, `tasks/${taskId}`));
      const world = loadCases().get(p.case_id)!;
      const port = HospitalPort.open(store, world, desk.registry, worldRules());
      try {
        const run = port.run();
        const f = world.schedule.facts;
        return { case_id: p.case_id, ward_id: String(f["ward_id"]), payer_type: String(f["payer_type"]), requirement_version: world.requirements.at(-1)!.set.requirement_version, facts: f, events: run.events };
      } finally { port.close(); }
    });
    writeFileSync(need("out"), `${JSON.stringify({ source: "e6 live runs under the adopted Ward A version and its withheld Ward B case", cases }, null, 1)}\n`);
  } finally { desk.close(); }
} else if (argv[0] === "report") {
  const store = need("store");
  const desk = new VersionDesk(store, Registry.load([loadV1()]));
  try {
    const log = desk.records();
    const created = log.find((r) => r.record_type === "version.created")!.payload as Row;
    const adopted = log.find((r) => r.record_type === "version.adopted")!.payload as Row;
    const v = Number(adopted["version"]);
    const def = desk.registry.get(v);
    const v1 = desk.registry.get(1);
    const app = liveTask(store, desk, need("applicable"));
    const wh = liveTask(store, desk, need("withheld"));
    const facts = (id: string) => loadCases().get(id)!.schedule.facts as Facts;
    const cf = { [String(app["case_id"])]: counterfactual(String(app["case_id"]), { v1, adopted: def }), [String(wh["case_id"])]: counterfactual(String(wh["case_id"]), { v1, adopted: def }) };
    const appCf = cf[String(app["case_id"])] as Record<string, Row>;
    const approver = adopted["approver"] as Row;
    // The EMR reading of the adopted version per M4.c's counterparts; only statuses and step ids are published, never the EMR's own fact names.
    const prof = flag("profile");
    const emr = prof && existsSync(prof) ? (() => {
      const file = JSON.parse(readFileSync(prof, "utf8")) as { versions: { ward_id: string; requirement_version: string; facts: Record<string, string> } & Counterparts; owners?: { id: string; kinds: string[] }[] };
      const spec = file.versions;
      const r = readVersion(def, v1, spec, caseFacts(spec));
      const d = deployCheck(def, v1, spec, file.owners ?? []);
      return {
        ward_id: spec.ward_id, resolved_version: desk.registry.current(caseFacts(spec)).version, offers: r.offers.filter((o) => o.changed).length, lines: r.lines,
        changed: r.readings.filter((x) => x.changed).map((x) => ({ step_id: x.step_id, document_id: x.document_id, stage: x.stage, status: x.status, reason: x.status === "offer" ? "offer" : x.reason })),
        deployment: { deployable: d.deployable, reason: d.reason, changed: d.changed.map((x) => ({ step_id: x.step_id, trigger: x.trigger, event: x.event, status: x.status, reason: x.reason, owners: x.owners.length })) }
      };
    })() : null;
    // The fresh EMR journey under the adopted version: the offers the agents made there, read from that run's public version file.
    const jv = flag("journey-version") && existsSync(flag("journey-version")!) ? JSON.parse(readFileSync(flag("journey-version")!, "utf8")) as Row : null;
    const journeyOffers = jv ? Number(jv["offers_made"] ?? 0) : null;
    // The same version on a live stay through the real door reads, beside version 1 on the same stay; only counts, steps and the time are published.
    const stay = (f: string | undefined) => (f && existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) as { version: number; offers_made: number; offers: { step_id: string; at: string }[]; questions: string[] } : null);
    const sv2 = stay(flag("stay-offer")), sv1 = stay(flag("stay-offer-v1"));
    const stayOffers = sv2 ? { mode: "sandbox door reads, no model call", adopted: { version: sv2.version, offers_made: sv2.offers_made, steps: sv2.offers.map((o) => o.step_id), at: sv2.offers.map((o) => o.at) }, version_1: sv1 ? { version: sv1.version, offers_made: sv1.offers_made } : null } : null;
    const blocked = flag("journey-blocked") ?? null;
    const dev = devDistribution(adoptedValidation(store, created));
    const out = {
      measured_at: new Date().toISOString(), measured: true, source: "simulator_demo_cases", set: "demo", measured_in: "simulator",
      proposal: { adopted: (created["meta"] as Row)["proposal_id"], parent: flag("parent") ?? null, ops: created["ops"], scope: created["scope"], trade_offs: flag("trade-offs") ? JSON.parse(flag("trade-offs")!) : null },
      version: v, definition_hash: def.definition_hash, fallback_version: def.fallback_version,
      adopted_by_person: approver["role"] === "ward_manager", approver: approver["display_name"], approver_id: approver["staff_id"],
      ...adoptionApproval(log, v),
      fresh_applicable: {
        ...app, resolved_version: desk.registry.current(facts(String(app["case_id"]))).version,
        executed_differently: app["workflow_version"] === v && app["summary_draft_at"] !== null && app["signoff_at"] !== null && Number(app["summary_draft_at"]) < Number(app["signoff_at"]),
        v1_counterfactual: appCf["v1"], adopted_counterfactual: appCf["adopted"]
      },
      withheld: {
        ...wh, resolved_version: desk.registry.current(facts(String(wh["case_id"]))).version,
        version_withheld: wh["workflow_version"] !== v && desk.registry.current(facts(String(wh["case_id"]))).version !== v,
        why: `the adopted scope is wards ${JSON.stringify((created["scope"] as Row)["wards"])} and this case is in ward ${String(wh["ward_id"])}`,
        drafted_before_signoff: wh["summary_draft_at"] !== null && wh["signoff_at"] !== null && Number(wh["summary_draft_at"]) < Number(wh["signoff_at"]),
        counterfactual: cf[String(wh["case_id"])]
      },
      emr_offers: emr,
      // C-27 claims an improvement only for a version this EMR can carry, and only once the fresh journey showed its offer or says why not.
      deployable: emr?.deployment.deployable ?? false,
      deployment_reason: emr?.deployment.reason ?? "no EMR profile was read, so the deploy check did not run",
      emr_journey: jv ? { source: flag("journey-version"), mode: jv["mode"], version: jv["version"], offers_made: journeyOffers, offers_blocked: jv["offers_blocked"], lines: jv["lines"], measured_at: jv["measured_at"] } : null,
      emr_stay_offers: stayOffers,
      emr_journey_blocked: blocked,
      emr_offers_made: journeyOffers ?? 0,
      emr_offer_seen: (journeyOffers ?? 0) >= 1 || (stayOffers?.adopted.offers_made ?? 0) >= 1,
      emr_offer_reason: journeyOffers ? `the agent offered the changed step on the fresh EMR journey ${journeyOffers} time${journeyOffers === 1 ? "" : "s"}`
        : `${jv ? `no offer on the fresh EMR journey (${((jv["lines"] as string[] | undefined) ?? []).join(" ") || "no line"})` : blocked ? `the fresh EMR journey could not run: ${blocked}` : "no fresh EMR journey under this version was read"}${stayOffers ? `; on a live stay through the door the adopted version offered it ${stayOffers.adopted.offers_made} time${stayOffers.adopted.offers_made === 1 ? "" : "s"} at its trigger point and version 1 ${stayOffers.version_1?.offers_made ?? "not run"}` : ""}`,
      applicable_case: app["case_id"], withheld_case: wh["case_id"],
      draft_earlier_by_min: app["summary_draft_at"] !== null && appCf["v1"]?.["summary_draft_start"] != null ? Number(appCf["v1"]!["summary_draft_start"]) - Number(app["summary_draft_at"]) : null,
      wait_v1_min: appCf["v1"]?.["post_signoff_wait_min"] ?? null, wait_adopted_min: app["post_signoff_wait_min"], rework_added: app["rework_events"],
      cost_usd: Math.round((Number(app["cost_usd"]) + Number(wh["cost_usd"])) * 1e6) / 1e6,
      dev_distribution: dev, ...devFields(dev)
    };
    writeFileSync(need("out"), `${JSON.stringify(out, null, 1)}\n`);
    console.log(JSON.stringify({ applicable: out.fresh_applicable.executed_differently, withheld: out.withheld.version_withheld, cost: out.cost_usd }));
  } finally { desk.close(); }
} else if (argv[0] === "loop") {
  // Adds the fresh EMR encounter's offer, its saved and proved action, the withheld case and the adoption record's approval to improve.json; the simulator fields stay as measured.
  const file = need("file");
  const cur = JSON.parse(readFileSync(file, "utf8")) as Row;
  const a = JSON.parse(readFileSync(need("applicable-run"), "utf8")) as Row;
  const b = JSON.parse(readFileSync(need("withheld-run"), "utf8")) as Row;
  const log = readStream(need("store"), VERSIONS_STREAM).map((e) => ({ record_type: e.record_type, wall_at: e.wall_at, payload: e.payload }));
  const v = Number(cur["version"]);
  const saved = (a["a_saved"] ?? {}) as Row;
  const notes = (saved["notes"] as Row[] | undefined) ?? [];
  const prov = (saved["provenance"] as Row[] | undefined) ?? [];
  const offerRows = ((a["a_offer"] as Row | undefined)?.["rows"] as Row[] | undefined) ?? [];
  const w = ((b["b_withheld"] as Row | undefined) ?? {}) as Row;
  const wRow = (w["row"] ?? {}) as Row;
  const loop = {
    mode: "sandbox door, live Spark Open gate on the nurse's two lines, the doctor's admission and round entry written by his agent through the door (scripted)",
    applicable: {
      ward_id: "A", version_in_force: v, offers_made: offerRows.length, offer_step: offerRows[0]?.["step_id"] ?? null, watched_before_round: a["a_watch_before_round"] ?? null,
      approved_by: "the nurse's own spoken line through serve (say draft, then save once reviewed)",
      action: { kind: "record_note", label: "stay_summary", persisted: notes.some((n) => n["id"] === saved["record_id"]), verified: !!saved["record_id"], by_owner_agent: prov.some((r) => r["origin"] === "voice"), provenance_rows: prov.length }
    },
    withheld: { ward_id: wRow["ward_id"] ?? null, version_in_force: w["version_in_force"] ?? null, offers_made: w["offers"] ?? null, questions: w["questions"] ?? null, refused_with_reason: !!wRow["reason"], reason: wRow["reason"] ?? null, reused_stay: ((b["stay_b"] as Row | undefined)?.["reused"]) ?? null }
  };
  const ok = loop.applicable.offers_made >= 1 && loop.applicable.action.persisted && loop.applicable.action.verified && loop.withheld.refused_with_reason && loop.withheld.offers_made === 0;
  const { human_approval_note: _n, ...rest } = cur;
  const approval = adoptionApproval(log, v);
  const next = {
    ...rest, ...approval, emr_loop: loop, emr_loop_complete: ok,
    emr_offers_made: loop.applicable.offers_made, emr_offer_seen: loop.applicable.offers_made >= 1 || cur["emr_offer_seen"] === true, emr_journey_blocked: null,
    emr_offer_reason: `on a fresh ward A stay the adopted version offered the summary draft at the round entry (${loop.applicable.offers_made} offer), the nurse approved it by voice and the reviewed draft was saved as a note on the stay and proved by a fresh read; on a ward B stay at the same trigger point it was withheld with the reason "${String(loop.withheld.reason ?? "")}"`
  };
  writeFileSync(file, `${JSON.stringify(next, null, 1)}\n`);
  console.log(JSON.stringify({ emr_loop_complete: ok, human_approval: approval["human_approval"] }));
} else if (argv[0] === "dev") {
  // Adds the dev-case distribution to an existing improve.json without touching its measured fields.
  const store = need("store");
  const file = need("file");
  const created = readStream(store, VERSIONS_STREAM).find((e) => e.record_type === "version.created")!.payload as Row;
  const dev = devDistribution(adoptedValidation(store, created));
  const cur = JSON.parse(readFileSync(file, "utf8")) as Row;
  writeFileSync(file, `${JSON.stringify({ ...cur, measured_in: "simulator", dev_distribution: dev, ...devFields(dev) }, null, 1)}\n`);
  console.log(JSON.stringify(devFields(dev)));
} else {
  console.log("improve child --parent-file f --parent id --wards A --note text --out f | improve report --store dir --applicable task --withheld task [--profile f] [--journey-version f] [--stay-offer f --stay-offer-v1 f] [--journey-blocked reason] --out f | improve dev --store dir --file improve.json");
  process.exit(2);
}
