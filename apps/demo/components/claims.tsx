import { STATUS_LABEL, type ClaimView } from "../src/lib/claims.js";
import { evidenceHref } from "../src/lib/evaluation.js";

// The only components that print claim text; every string they show comes from the registry and the status file.
export function ClaimBadge({ claim, variant = "card", anchor = false }: { claim: ClaimView; variant?: "chip" | "card"; anchor?: boolean }) {
  const href = evidenceHref(claim.id, claim.tab);
  if (variant === "chip") {
    return (
      <a className={`claim-chip s-${claim.status}`} href={href} data-claim={claim.id} data-claim-status={claim.status} title={claim.question}>
        <span className="claim-dot" aria-hidden="true" />
        <span className="claim-id">{claim.id}</span>
        <span className="claim-wording" data-claim-wording="">{claim.wording}</span>
        <span className="sr-only">{STATUS_LABEL[claim.status]}</span>
      </a>
    );
  }
  return (
    <a className={`claim-card s-${claim.status}`} href={href} data-claim={claim.id} data-claim-status={claim.status} {...(anchor ? { id: `claim-${claim.id}` } : {})}>
      <span className="claim-card-top">
        <span className="claim-id">{claim.id}</span>
        <span className="claim-status"><span className="claim-dot" aria-hidden="true" />{STATUS_LABEL[claim.status]}</span>
      </span>
      <span className="claim-question" data-claim-question="">{claim.question}</span>
      <span className="claim-wording" data-claim-wording="">{claim.wording}</span>
      <span className="claim-evidence">Evidence: {claim.tab}, {claim.table}</span>
    </a>
  );
}

export function ClaimsStrip({ claims, measured }: { claims: ClaimView[]; measured: string }) {
  return (
    <section className="strip" aria-label="Claims and their measured status">
      <div className="strip-label">
        <b>Claims</b>
        <span>status file {measured || "undated"}</span>
      </div>
      <div className="strip-row">
        {claims.map((c) => <ClaimBadge key={c.id} claim={c} variant="chip" />)}
      </div>
    </section>
  );
}

export function ClaimGroup({ claims, title }: { claims: ClaimView[]; title: string }) {
  if (!claims.length) return null;
  return (
    <section className="claim-group" aria-label={title}>
      <h3 className="eyebrow">{title}</h3>
      <div className="claim-grid">{claims.map((c) => <ClaimBadge key={c.id} claim={c} />)}</div>
    </section>
  );
}

export function ResultsTile({ claims }: { claims: ClaimView[] }) {
  return (
    <aside className="results" aria-label="Results">
      <div className="results-head">
        <h2>Results</h2>
        <a href="/evaluation">Evaluation view</a>
      </div>
      <p className="results-note">Read from the status file only. A claim that is not measured says so.</p>
      <div className="results-list">{claims.map((c) => <ClaimBadge key={c.id} claim={c} />)}</div>
    </aside>
  );
}
