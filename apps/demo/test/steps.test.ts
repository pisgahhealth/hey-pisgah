import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Footer } from "../components/frame";
import { DRAFT_BANNER, StateLegend, TaskTimeline } from "../components/task-view";
import { EVAL_TABS } from "../src/lib/evaluation.js";
import { stepLabels } from "../src/lib/labels.js";
import type { Env } from "../src/lib/paths.js";
import { DISPLAY_STATES, STATE_TEXT, foldTask } from "../src/lib/task.js";
import { loadFixture } from "../src/lib/task-source.js";
import { decode } from "./claim-check";
import { fixturePage, loadClaims, renderEval, renderStep, root } from "./render";

const count = (html: string, needle: string) => html.split(needle).length - 1;
const plain = (html: string) => decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ");

describe("demo steps render", () => {
  it("every step renders with the nav, the disclosure, the strip, the results tile and the footer", async () => {
    const claims = loadClaims(root);
    const task = await fixturePage();
    for (let n = 1; n <= 6; n += 1) {
      const html = renderStep(n, claims, task);
      expect(count(html, 'class="stepnav"'), `step ${n}`).toBe(1);
      expect(html).toContain(`href="/step/${n}" aria-current="step"`);
      expect(html).toContain("Prior work.");
      expect(html).toContain("Built during the event");
      expect(html).toContain("Simulation");
      expect(html).toContain('aria-label="Results"');
      expect(html).toContain("data-footer-mode=");
      if ([2, 3, 4, 6].includes(n)) expect(html, `step ${n} shell`).toContain("Arrives in L2.4");
    }
  });

  it("step 1 shows the 12 discovery cases with two clocks and no cause labels", async () => {
    const html = renderStep(1, loadClaims(root), await fixturePage());
    expect(count(html, "data-case=")).toBe(12);
    expect(count(html, 'class="twoclock"')).toBe(12);
    expect(html).toContain("tc-later");
    expect(plain(html)).not.toMatch(/\bF(1[0-2]|[1-9])\b|family|confound|late entry/i);
  });

  it("step 5 shows the audit line, proofs with the verifier slot, drafts marked and greyed waits with 0 calls and resume markers", async () => {
    const task = await fixturePage();
    const html = renderStep(5, loadClaims(root), task);
    const text = plain(html);
    expect(text).toContain("Agent for nurse n-a1 · Workflow v1 · Discharge summary final prepared · Clinical sign-off pending");
    const v = task.view!;
    const drafts = v.actions.filter((a) => a.state === "completed" && a.document?.stage === "draft").length;
    expect(drafts).toBe(2);
    expect(count(html, DRAFT_BANNER)).toBe(drafts);
    const proved = v.actions.filter((a) => a.proof).length;
    expect(count(html, "data-proof-record=")).toBe(proved);
    expect(count(html, 'data-verifier="not_run"')).toBeGreaterThanOrEqual(proved);
    expect(html).toContain('data-proof-event="ev-c8d3f53b"');
    expect(html).toContain('id="proof-a-d9b5ae01-ev-c8d3f53b"');
    const waits = v.periods.filter((p) => p.kind === "waiting");
    expect(waits.length).toBe(9);
    expect(count(html, 'data-period="waiting"')).toBe(9);
    expect(count(html, 'data-wait-calls="0"')).toBe(9);
    expect(count(html, ">0 calls<")).toBe(9);
    expect(count(html, "data-resume=")).toBe(9);
    expect(text).toContain("Resumed at 10:00 on: clinical discharge recorded");
    expect(html).toContain('data-task-state="done"');
  });

  it("a model call inside a wait shows on that wait, not as 0 calls", () => {
    const f = loadFixture(root);
    const i = f.records.findIndex((e) => e.record_type === "task.state_changed" && e.payload["to"] === "waiting");
    const planted: Env[] = [...f.records.slice(0, i + 1), { seq: f.records[i]!.seq, record_type: "model.turn", occurred_at: f.records[i]!.occurred_at, recorded_at: f.records[i]!.occurred_at, payload: {} }, ...f.records.slice(i + 1)];
    const v = foldTask(planted, stepLabels(root));
    expect(v.periods.find((p) => p.kind === "waiting")!.calls).toBe(1);
    const html = renderToStaticMarkup(createElement(TaskTimeline, { task: v }));
    expect(count(html, 'data-wait-calls="1"')).toBe(1);
    expect(html).toContain("period-waiting has-calls");
  });

  it("waiting, retrying, cancelled and needs_input render distinctly", () => {
    const html = renderToStaticMarkup(createElement(StateLegend));
    const classes = [...html.matchAll(/class="state (state-[a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(classes).size).toBe(DISPLAY_STATES.length);
    for (const s of ["waiting", "retrying", "cancelled", "needs_input"] as const) expect(html).toContain(`class="state state-${s}" data-state="${s}"`);
    expect(new Set(Object.values(STATE_TEXT)).size).toBe(DISPLAY_STATES.length);
  });

  it("a task that asks a person, retries a write and is cancelled shows each state in its timeline", () => {
    const at = (seq: number, record_type: string, payload: Record<string, unknown>, m = 500): Env => ({ seq, record_type, occurred_at: m, recorded_at: m, payload });
    const recs: Env[] = [
      at(1, "task.opened", { task_id: "t-x", case_id: "c-x", owner: "nurse n-a1", goal: "g", workflow_version: 1, run_id: "run-x" }, 480),
      at(2, "action.intent", { action_id: "a-1", action_kind: "prepare_document", args: { document_id: "discharge_summary", stage: "draft" } }, 480),
      at(3, "action.retry", { action_id: "a-1" }, 480),
      at(4, "task.state_changed", { from: "running", to: "needs_input", reason: "work_left_undone" }, 490),
      at(5, "task.state_changed", { from: "needs_input", to: "running", reason: "person:n" }, 520),
      at(6, "task.state_changed", { from: "running", to: "cancelled", reason: "person:n" }, 530)
    ];
    const v = foldTask(recs, new Map());
    expect(v.periods.map((p) => p.kind)).toEqual(["running", "needs_input", "running", "cancelled"]);
    expect(v.actions[0]!.state).toBe("retrying");
    const html = renderToStaticMarkup(createElement(TaskTimeline, { task: v }));
    expect(html).toContain('data-period="needs_input"');
    expect(html).toContain('data-period="cancelled"');
    expect(html).toContain('data-action-state="retrying"');
  });

  it("the footer has three distinct states: live, replay of a live run with request ids, and mock", async () => {
    const claims = loadClaims(root);
    const task = await fixturePage();
    const render = (mode: "live" | "replay" | "mock") => renderToStaticMarkup(createElement(Footer, { footer: { ...task.footer, mode }, source: task.source, claims }));
    const live = render("live");
    const replay = render("replay");
    const mock = render("mock");
    expect(live).toContain('data-footer-mode="live"');
    expect(plain(live)).toContain("Live");
    expect(plain(replay)).toContain("Replay of a live run");
    expect(count(replay, "<li><code>")).toBe(38);
    expect(replay).toContain("9c79d54fadd54138bd4f704db56d641d");
    expect(plain(mock)).toContain("Mock");
    expect(plain(mock)).toContain("Scripted agent, no model");
    expect(task.footer.mode).toBe("replay");
    expect(task.footer.calls).toBe(38);
    expect(task.footer.calls_while_waiting).toBe(0);
  });

  it("the evaluation view has ten named tab shells", async () => {
    const claims = loadClaims(root);
    const task = await fixturePage();
    expect(EVAL_TABS.map((t) => t.name)).toEqual([
      "Baselines", "Reserved run", "Decision points", "Truthful completion", "Reliability", "Prediction checks",
      "Costs and instrumentation", "Commitments and contamination", "Failures and limitations", "Variation"
    ]);
    for (const t of EVAL_TABS) {
      const html = renderEval(t.slug, claims, task);
      expect(count(html, "data-tab=")).toBe(10);
      expect(html).toContain(`data-tab-panel="${t.slug}"`);
      expect(html).toContain("Arrives in L2.4");
    }
    let anchored = 0;
    for (const t of EVAL_TABS) anchored += count(renderEval(t.slug, claims, task), 'id="claim-C-');
    expect(anchored).toBe(17);
  });
});
