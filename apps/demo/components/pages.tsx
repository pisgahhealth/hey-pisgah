import { claimsOn, type ClaimsModel } from "../src/lib/claims.js";
import type { WardBoard } from "../src/lib/discovery.js";
import { stepOf, STEPS, type DemoStep } from "../src/lib/steps.js";
import type { TaskPage } from "../src/lib/task-source.js";
import { ClaimGroup } from "./claims";
import { LiveRefresh, StartTask } from "./client";
import { Frame } from "./frame";
import { WardBoardView } from "./ward-board";
import { TaskViewPanel } from "./task-view";

function StepHead({ step }: { step: DemoStep }) {
  return (
    <header className="step-head">
      <p className="eyebrow">Step {step.n} of 6</p>
      <h1>{step.title}</h1>
      <p className="lede">{step.lede}</p>
    </header>
  );
}

function StepFoot({ n }: { n: number }) {
  const prev = stepOf(n - 1);
  const next = stepOf(n + 1);
  return (
    <nav className="step-foot" aria-label="Step navigation">
      {prev ? <a href={`/step/${prev.n}`}>← {prev.n} {prev.title}</a> : <span />}
      {next ? <a href={`/step/${next.n}`}>{next.n} {next.title} →</a> : <a href="/evaluation">Evaluation view →</a>}
    </nav>
  );
}

export function ShellBody({ step }: { step: DemoStep }) {
  return (
    <section className="shell" data-shell={step.n}>
      <p className="shell-tag">Arrives in L2.4</p>
      <p>This step is a shell for now. Its content comes from the learning loop&apos;s records.</p>
    </section>
  );
}

function TaskBody({ page }: { page: TaskPage }) {
  const v = page.view;
  if (!v) {
    return (
      <section className="shell">
        <p className="shell-tag">No task on serve yet</p>
        <p>serve is running with no task. Starting the case posts one task to serve, which runs it in its own mode.</p>
        <StartTask />
      </section>
    );
  }
  const settled = ["done", "failed", "cancelled", "needs_input", "paused"].includes(v.state);
  return (
    <>
      {page.source.kind === "serve" && !settled ? <LiveRefresh active /> : null}
      <section className="shell shell-thin">
        <p className="shell-tag">Adoption record arrives in L2.4</p>
        <p>The task below ran on workflow v{v.workflow_version}; the adopted version and its approver show here once a person adopts a change.</p>
      </section>
      <TaskViewPanel task={v} />
      {page.source.kind === "serve" && page.tasks.length > 1 ? (
        <nav className="task-pick" aria-label="Tasks on serve">
          {page.tasks.map((t) => <a key={t.task_id} href={`/step/5?task=${t.task_id}`} aria-current={t.task_id === v.task_id ? "true" : undefined}>{t.task_id} · {t.state}</a>)}
        </nav>
      ) : null}
    </>
  );
}

// Renders one step with the shared frame, from data the caller already loaded.
export function StepPage({ n, claims, board, task }: { n: number; claims: ClaimsModel; board: WardBoard | null; task: TaskPage }) {
  const step = stepOf(n) ?? STEPS[0]!;
  return (
    <Frame step={step.n} claims={claims} footer={task.footer} source={task.source}>
      <StepHead step={step} />
      <ClaimGroup claims={claimsOn(claims, String(step.n))} title={`Claims on step ${step.n}`} />
      {step.n === 1 && board ? <WardBoardView board={board} /> : null}
      {step.n === 5 ? <TaskBody page={task} /> : null}
      {!step.ready ? <ShellBody step={step} /> : null}
      <StepFoot n={step.n} />
    </Frame>
  );
}
