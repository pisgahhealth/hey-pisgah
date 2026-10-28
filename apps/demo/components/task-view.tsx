import { humanize } from "../src/lib/labels.js";
import { hhmm } from "../src/lib/paths.js";
import { ACTION_TEXT, DISPLAY_STATES, STATE_TEXT, displayState, type ActionState, type ActionView, type DisplayState, type Period, type TaskView } from "../src/lib/task.js";

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export const DRAFT_BANNER = "Draft, not for issue: clinical discharge pending";

export type VerifierResult = { status: "not_run" } | { status: "pass" | "fail"; detail: string };

// Verifier results arrive with the evaluator's independent completion verifier; until then each proof says it has not run.
export function verifierFor(_actionId: string): VerifierResult {
  return { status: "not_run" };
}

export function TaskStatePill({ state }: { state: DisplayState }) {
  return <span className={`state state-${state}`} data-state={state}><i aria-hidden="true" />{STATE_TEXT[state]}</span>;
}

export function ActionStatePill({ state }: { state: ActionState }) {
  return <span className={`astate astate-${state}`} data-action-state={state}>{ACTION_TEXT[state]}</span>;
}

export function StateLegend() {
  return (
    <div className="legend" aria-label="Task states">
      {DISPLAY_STATES.map((s) => <TaskStatePill key={s} state={s} />)}
    </div>
  );
}

export function VerifierBadge({ result }: { result: VerifierResult }) {
  if (result.status === "not_run") return <span className="verifier v-not_run" data-verifier="not_run">Independent verifier: not run yet</span>;
  return <span className={`verifier v-${result.status}`} data-verifier={result.status}>Independent verifier: {result.status === "pass" ? "agrees" : "disagrees"}, {result.detail}</span>;
}

export function ProofChips({ a }: { a: ActionView }) {
  if (!a.proof) return null;
  const p = a.proof;
  return (
    <span className="proof">
      <a className="proof-chip" href={`#proof-${a.action_id}`} data-proof-record={p.record_id}>{p.record_id} v{p.record_version}</a>
      {p.produced_event_ids.map((ev) => <a key={ev} className="proof-chip is-event" href={`#proof-${a.action_id}-${ev}`} data-proof-event={ev}>{ev}</a>)}
      <VerifierBadge result={verifierFor(a.action_id)} />
    </span>
  );
}

export function AuditLine({ task, a }: { task: TaskView; a: ActionView }) {
  const doc = a.document ? `${humanize(a.document.id)}${a.document.stage ? ` ${a.document.stage}` : ""}` : a.label;
  return (
    <p className="audit" data-audit-line="">
      Agent for {task.owner} · Workflow v{task.workflow_version} · <a href={`#proof-${a.action_id}`}>{doc} prepared</a> · <span className="audit-pending">Clinical sign-off pending</span>
    </p>
  );
}

export function DocumentCard({ task, a }: { task: TaskView; a: ActionView }) {
  const draft = a.document?.stage === "draft";
  return (
    <article className={`doc ${draft ? "is-draft" : "is-final"}`} data-action={a.action_id}>
      {draft ? <p className="draft-banner" role="note">{DRAFT_BANNER}</p> : null}
      <header className="doc-head">
        <h4>{a.document ? humanize(a.document.id) : a.label}<span className="doc-stage">{a.document?.stage ?? ""}</span></h4>
        <ActionStatePill state={a.state} />
      </header>
      <AuditLine task={task} a={a} />
      <ProofChips a={a} />
      <p className="doc-meta">Asked {hhmm(a.at)}{a.proof?.verified_at != null ? ` · proved ${hhmm(a.proof.verified_at)}` : ""}</p>
    </article>
  );
}

export function ActionRow({ a }: { a: ActionView }) {
  return (
    <li className={`act act-${a.state}`} data-action={a.action_id}>
      <span className="act-time">{hhmm(a.at)}</span>
      <span className="act-body">
        <b>{a.label}</b>
        {a.detail ? <q className="act-detail">{a.detail}</q> : null}
        {a.refusal ? <span className="act-refusal">Refused by the hospital record: {humanize(a.refusal).toLowerCase()}{a.refusal_detail.length ? `; ${a.refusal_detail.join("; ")}` : ""}</span> : null}
        <ProofChips a={a} />
      </span>
      <ActionStatePill state={a.state} />
    </li>
  );
}

function PeriodRow({ p, actions }: { p: Period; actions: ActionView[] }) {
  if (p.kind === "waiting") {
    return (
      <li className={`period period-waiting${p.calls ? " has-calls" : ""}`} data-period="waiting" data-calls={p.calls}>
        <span className="period-time">{hhmm(p.from)}</span>
        <div className="period-body">
          <div className="wait-band">
            <TaskStatePill state="waiting" />
            <span>{hhmm(p.from)} to {p.open ? "now" : hhmm(p.to)}, {p.to - p.from} min</span>
            <span className="wait-calls" data-wait-calls={p.calls}>{plural(p.calls, "call")}</span>
          </div>
          {p.resume ? (
            <p className="resume" data-resume={p.resume.wake_id}>
              <span className="resume-mark" aria-hidden="true">↻</span>
              Resumed at {hhmm(p.to)} on: {p.resume.label.charAt(0).toLowerCase() + p.resume.label.slice(1)} · trigger <code>{p.resume.trigger}</code> · wake <code>{p.resume.wake_id}</code>
            </p>
          ) : null}
        </div>
      </li>
    );
  }
  const inside = actions.filter((a) => a.seq > p.from_seq && a.seq <= p.to_seq);
  return (
    <li className={`period period-${p.kind}`} data-period={p.kind}>
      <span className="period-time">{hhmm(p.from)}</span>
      <div className="period-body">
        <div className="period-head">
          <TaskStatePill state={p.kind} />
          {p.kind === "running" ? <span>{plural(p.calls, "call")}, {plural(inside.length, "action")}</span> : p.reason ? <span>{humanize(p.reason).toLowerCase()}</span> : null}
        </div>
        {inside.length ? <ul className="period-acts">{inside.map((a) => <li key={a.action_id}>{a.label} <ActionStatePill state={a.state} /></li>)}</ul> : null}
      </div>
    </li>
  );
}

export function TaskTimeline({ task }: { task: TaskView }) {
  return (
    <ol className="timeline" aria-label="Task timeline in simulated time">
      {task.periods.map((p) => <PeriodRow key={`${p.kind}-${p.from_seq}`} p={p} actions={task.actions} />)}
    </ol>
  );
}

export function ProofDetails({ task }: { task: TaskView }) {
  const proved = task.actions.filter((a) => a.proof);
  return (
    <div className="proofs">
      {proved.map((a) => {
        const p = a.proof!;
        return (
          <details key={a.action_id} id={`proof-${a.action_id}`} className="proof-detail">
            <summary><b>{a.label}</b> · record <code>{p.record_id}</code> v{p.record_version}</summary>
            <dl>
              <dt>Record hash</dt><dd><code>{p.record_hash.slice(0, 16)}</code></dd>
              <dt>Events</dt><dd>{p.produced_event_ids.map((ev) => <code key={ev} id={`proof-${a.action_id}-${ev}`}>{ev}</code>)}</dd>
              <dt>Read from</dt><dd>{p.source_refs.length ? p.source_refs.map((s) => <code key={s.record_id}>{s.record_id} v{s.version}</code>) : "none"}</dd>
              <dt>Tool call</dt><dd>{p.tool_call_ids.map((t) => <code key={t}>{t}</code>)}</dd>
              <dt>Model response</dt><dd><code>{p.model_response_id ?? "none"}</code></dd>
              <dt>Proved at</dt><dd>{p.verified_at === null ? "unknown" : hhmm(p.verified_at)} (simulated)</dd>
              <dt>Verifier</dt><dd><VerifierBadge result={verifierFor(a.action_id)} /></dd>
            </dl>
          </details>
        );
      })}
    </div>
  );
}

export function TaskViewPanel({ task }: { task: TaskView }) {
  const docs = task.actions.filter((a) => a.kind === "prepare_document" && a.state !== "refused");
  const others = task.actions.filter((a) => !docs.includes(a));
  const state = displayState(task);
  return (
    <div className="task" data-task={task.task_id} data-task-state={state}>
      <section className="task-head">
        <div>
          <p className="eyebrow">Task <code className="id">{task.task_id}</code> · case <code className="id">{task.case_id}</code> · <span className="tag tag-sim">Simulated ward</span></p>
          <h3>{task.goal}</h3>
          <p className="task-meta">For {task.owner} · workflow v{task.workflow_version}{task.requirement_version ? ` · requirements ${task.requirement_version}` : ""} · {hhmm(task.opened_at)} to {hhmm(task.updated_at)}</p>
        </div>
        <div className="task-state">
          <TaskStatePill state={state} />
          {task.reason ? <span className="task-reason">{humanize(task.reason).toLowerCase()}</span> : null}
        </div>
      </section>
      <section className="conditions" aria-label="What done requires">
        {task.conditions.map((c) => (
          <span key={c.condition_id} className={`cond ${c.met ? "is-met" : "is-open"}`} data-condition={c.condition_id}>
            {c.met ? "✓" : "○"} {humanize(c.condition_id)}
          </span>
        ))}
        {task.unmet.length ? <span className="cond is-open">Open: {task.unmet.map((u) => humanize(u)).join(", ")}</span> : null}
      </section>
      <div className="task-cols">
        <section aria-label="Prepared documents">
          <h3 className="eyebrow">Prepared documents</h3>
          <div className="docs">{docs.map((a) => <DocumentCard key={a.action_id} task={task} a={a} />)}</div>
          <h3 className="eyebrow">Messages and refusals</h3>
          <ul className="acts">{others.map((a) => <ActionRow key={a.action_id} a={a} />)}</ul>
          <h3 className="eyebrow">Proofs</h3>
          <ProofDetails task={task} />
        </section>
        <section aria-label="Timeline">
          <h3 className="eyebrow">Timeline, simulated clock</h3>
          <TaskTimeline task={task} />
          <dl className="counts">
            <dt>Model calls</dt><dd>{task.counts.model_calls}</dd>
            <dt>Refused by the runtime</dt><dd>{task.counts.agent_refused}</dd>
            <dt>Early finish attempts refused</dt><dd>{task.counts.completion_refused}</dd>
            <dt>Write retries</dt><dd>{task.counts.retries}</dd>
          </dl>
          <h3 className="eyebrow">How states look</h3>
          <StateLegend />
        </section>
      </div>
    </div>
  );
}
