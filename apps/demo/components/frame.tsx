import type { ReactNode } from "react";
import { claimsOn, type ClaimsModel } from "../src/lib/claims.js";
import { modelShort, type FooterModel } from "../src/lib/ledger.js";
import { STEPS } from "../src/lib/steps.js";
import type { SourceInfo } from "../src/lib/task-source.js";
import { ClaimBadge, ClaimsStrip, ResultsTile } from "./claims";

export function StepNav({ current }: { current: number | null }) {
  return (
    <nav className="stepnav" aria-label="Demo steps">
      <ol>
        {STEPS.map((s) => (
          <li key={s.n}>
            <a href={`/step/${s.n}`} aria-current={current === s.n ? "step" : undefined} className={s.ready ? "" : "is-shell"}>
              <span className="stepnav-n">{s.n}</span>
              <span className="stepnav-t">{s.title}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function DisclosureBanner() {
  return (
    <section className="disclosure" aria-label="Disclosure">
      <span className="tag tag-sim">Simulation</span>
      <p>
        <b>Prior work.</b> Pisgah Health&apos;s hospital platform existed before the event; its code is not in this app.{" "}
        <b>Built during the event</b> (27 Oct to 4 Nov 2026): the simulated hospital, the agent, the evaluation and this app.
        Every ward, patient and staff member here is synthetic. No patient data is used.
      </p>
    </section>
  );
}

const MODE_TEXT = { live: "Live", replay: "Replay of a live run", mock: "Mock" } as const;

export function Footer({ footer, source, claims }: { footer: FooterModel; source: SourceInfo; claims: ClaimsModel }) {
  const mode = footer.mode;
  const c12 = claimsOn(claims, "footer");
  return (
    <footer className={`footer m-${mode ?? "none"}`} data-footer-mode={mode ?? "none"}>
      <div className="footer-row">
        <span className="footer-mode">{mode ? MODE_TEXT[mode] : "No run yet"}</span>
        {mode === "mock" ? <span className="footer-fact">Scripted agent, no model</span> : null}
        <span className="footer-fact">{footer.provider ?? "no provider"}</span>
        <span className="footer-fact">{modelShort(footer.model)}</span>
        {footer.effort ? <span className="footer-fact is-wide">effort {footer.effort}</span> : null}
        <span className="footer-fact">{footer.calls} calls</span>
        <span className="footer-fact">${footer.usd.toFixed(4)}</span>
        <span className="footer-fact">p50 {footer.p50_ms === null ? "n/a" : `${(footer.p50_ms / 1000).toFixed(2)} s`}</span>
        <span className="footer-claim">{c12.map((c) => <ClaimBadge key={c.id} claim={c} variant="chip" />)}</span>
      </div>
      <details className="footer-more">
        <summary>{source.kind === "fixture" ? "Committed replay" : `serve ${source.url}`}{footer.run_id ? ` · ${footer.run_id}` : ""}{mode === "replay" || mode === "live" ? ` · ${footer.request_ids.length} request ids` : ""}</summary>
        <div className="footer-detail">
          <p>
            {source.kind === "fixture"
              ? <>Data: the committed replay of live run {source.recorded_run}, made with <code>{source.made_by}</code>.</>
              : <>Data: hey-pisgah serve at <code>{source.url}</code> (mode {source.mode}); task stream read only from <code>{source.store}</code>{source.stream_found ? "" : ", not found there"}.</>}
          </p>
          {footer.request_ids.length ? (
            <ol className="request-ids" aria-label="Request ids">
              {footer.request_ids.map((id, i) => <li key={`${id}-${i}`}><code>{id}</code></li>)}
            </ol>
          ) : null}
        </div>
      </details>
    </footer>
  );
}

export function Frame({ step, claims, footer, source, children }: { step: number | null; claims: ClaimsModel; footer: FooterModel; source: SourceInfo; children: ReactNode }) {
  return (
    <div className="frame">
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <div className="top-row">
          <a className="brand" href="/step/1"><span className="brand-mark" aria-hidden="true">P</span>Hey Pisgah</a>
          <span className="top-sub">Discharge paperwork on a simulated ward</span>
          <a className="top-link" href="/evaluation" aria-current={step === null ? "page" : undefined}>Evaluation view</a>
        </div>
        <StepNav current={step} />
      </header>
      <DisclosureBanner />
      <ClaimsStrip claims={claims.claims} measured={claims.generated_at.slice(0, 16).replace("T", " ")} />
      <div className="body">
        <main id="main" className="main">{children}</main>
        <ResultsTile claims={claimsOn(claims, "results")} />
      </div>
      <Footer footer={footer} source={source} claims={claims} />
    </div>
  );
}
