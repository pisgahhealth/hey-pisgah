import type { ClaimsModel } from "../src/lib/claims.js";
import { EVAL_TABS, tabFor, type EvalTab } from "../src/lib/evaluation.js";
import type { TaskPage } from "../src/lib/task-source.js";
import { ClaimBadge } from "./claims";
import { Frame } from "./frame";

export function claimsForTab(claims: ClaimsModel, tab: EvalTab) {
  if (tab.slug === "failures") return claims.claims.filter((c) => c.status === "red" || c.status === "amber");
  return claims.claims.filter((c) => tabFor(c.tab)?.slug === tab.slug);
}

// The evaluation view: ten tabs that share the status file with the main demo, so a badge leads to its evidence in one click.
export function EvaluationPage({ claims, tabSlug, task }: { claims: ClaimsModel; tabSlug: string | null; task: TaskPage }) {
  const tab = EVAL_TABS.find((t) => t.slug === tabSlug) ?? EVAL_TABS[0]!;
  const here = claimsForTab(claims, tab);
  return (
    <Frame step={null} claims={claims} footer={task.footer} source={task.source}>
      <header className="step-head">
        <p className="eyebrow">Evaluation view</p>
        <h1>{tab.name}</h1>
        <p className="lede">{tab.holds}</p>
      </header>
      <nav className="tabs" aria-label="Evaluation tabs">
        <ul role="list">
          {EVAL_TABS.map((t) => (
            <li key={t.slug}>
              <a href={`/evaluation?tab=${t.slug}`} aria-current={t.slug === tab.slug ? "page" : undefined} data-tab={t.slug}>{t.name}</a>
            </li>
          ))}
        </ul>
      </nav>
      <section className="tab-panel" data-tab-panel={tab.slug} aria-label={tab.name}>
        <section className="shell">
          <p className="shell-tag">Arrives in L2.4</p>
          <p>The tables for this tab are filled from the committed results once the evaluation runs.</p>
        </section>
        {here.length ? (
          <div className="claim-grid">{here.map((c) => <ClaimBadge key={c.id} claim={c} anchor />)}</div>
        ) : (
          <p className="empty">{tab.slug === "failures" ? "The status file has no red or amber claim." : "No claim points to this tab."}</p>
        )}
      </section>
    </Frame>
  );
}
